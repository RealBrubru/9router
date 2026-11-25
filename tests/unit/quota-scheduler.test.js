import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuotaScheduler } from "../../src/lib/quota/scheduler.js";
import { createOpenAIQuotaAdapter } from "../../src/lib/quota/openai.js";
import { QuotaCollectionError } from "../../src/lib/quota/errors.js";

const DAY = 86400;
const clockStart = Date.UTC(2025, 0, 15, 12);
const organization = (id, config = {}, enabled = true) => ({
  id, provider: "openai", enabled,
  config: { usageIntervalMs: 60_000, costsIntervalMs: 3_600_000, usageLookbackDays: 1,
    costsLookbackDays: 7, minuteEnabled: false, minuteIntervalMs: 60_000, minuteLookback: 10, ...config },
});

let controllers;
function fixture(organizations, collect = vi.fn(async () => ({ outcome: "success" }))) {
  const schedules = new Map();
  const repository = {
    collect, listOrganizations: vi.fn(() => organizations),
    readSchedule: (id, source, resolution) => schedules.get(`${id}/${source}/${resolution}`),
    writeSchedule: (id, source, resolution, state) => schedules.set(`${id}/${source}/${resolution}`, state),
  };
  function make(options = {}) {
    const scheduler = createQuotaScheduler({
      repository, adapters: { openai: {} }, enabled: true, ...options,
    });
    controllers.push(scheduler);
    return scheduler;
  }
  return { repository, collect, make, schedules };
}

const advance = ms => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  controllers = [];
  vi.useFakeTimers();
  vi.setSystemTime(clockStart);
});
afterEach(async () => {
  await Promise.all(controllers.map(scheduler => scheduler.stop()));
  vi.useRealTimers();
});

describe("server quota scheduler", () => {
  it("does not even enumerate organizations when disabled", async () => {
    const { make, repository } = fixture([organization("alpha")]);
    expect(make({ enabled: false }).start()).toBe(false);
    await advance(60_000);
    expect(repository.listOrganizations).not.toHaveBeenCalled();
    expect(repository.collect).not.toHaveBeenCalled();
  });

  it("does not call an adapter for an empty or disabled configuration", async () => {
    const empty = fixture([]);
    const disabled = fixture([organization("alpha", {}, false)]);
    empty.make().start();
    disabled.make().start();
    await advance(60_000);
    expect(empty.collect).not.toHaveBeenCalled();
    expect(disabled.collect).not.toHaveBeenCalled();
  });

  it("starts once, isolates intervals and applies each organization's lookback", async () => {
    const { make, collect } = fixture([
      organization("alpha", { costsIntervalMs: 120_000 }),
      organization("beta", { usageIntervalMs: 120_000, usageLookbackDays: 2 }),
      organization("gamma", {}, false),
    ]);
    const scheduler = make({ concurrency: 4 });
    expect(scheduler.start()).toBe(true);
    expect(scheduler.start()).toBe(false);
    await advance(0);
    expect(collect.mock.calls.map(([id, query]) => [id, query.source, query.resolution])).toEqual([
      ["alpha", "usage", "1d"], ["alpha", "costs", "1d"], ["beta", "usage", "1d"], ["beta", "costs", "1d"],
    ]);
    const dayStart = Math.floor(clockStart / 1000 / DAY) * DAY;
    expect(collect.mock.calls.map(([, query]) => query.start)).toEqual([
      dayStart - DAY, dayStart - 7 * DAY, dayStart - 2 * DAY, dayStart - 7 * DAY,
    ]);
    await advance(60_000);
    expect(collect.mock.calls.slice(4).map(([id, query]) => [id, query.source])).toEqual([["alpha", "usage"]]);
    await advance(60_000);
    expect(collect.mock.calls.slice(5).map(([id, query]) => [id, query.source])).toEqual([
      ["alpha", "usage"], ["alpha", "costs"], ["beta", "usage"],
    ]);
  });

  it("limits concurrency and excludes minute reads while daily Usage for the same org is active", async () => {
    const collect = vi.fn((_id, _query, _adapter, { signal }) => new Promise(resolve => {
      signal.addEventListener("abort", resolve, { once: true });
    }));
    const { make } = fixture([organization("alpha", { minuteEnabled: true }), organization("beta")], collect);
    make({ concurrency: 2 }).start();
    await advance(0);
    await advance(60_000);
    expect(collect.mock.calls.map(([id, query]) => [id, query.source, query.resolution])).toEqual([
      ["alpha", "usage", "1d"], ["alpha", "costs", "1d"],
    ]);
  });

  it("schedules minutes only when enabled, with no duplicate daily or minute jobs", async () => {
    const { make, collect } = fixture([organization("alpha", { minuteEnabled: true, minuteLookback: 5 })]);
    make().start();
    await advance(1000);
    expect(collect.mock.calls.map(([, query]) => [query.source, query.resolution])).toEqual([
      ["usage", "1d"], ["costs", "1d"], ["usage", "1m"],
    ]);
    expect(collect.mock.calls[2][1].start).toBe(clockStart / 1000 - 300);
  });

  it("isolates permanent and temporary failures and preserves Retry-After after a restart", async () => {
    const collect = vi.fn(async (id, query) => {
      if (id === "alpha" && query.source === "usage") throw new QuotaCollectionError("rate_limited", 429, 95_000);
      if (id === "beta" && query.source === "costs") throw new QuotaCollectionError("authorization", 403);
      return { outcome: "success" };
    });
    const { make, repository } = fixture([organization("alpha"), organization("beta")], collect);
    const scheduler = make({ concurrency: 4 });
    scheduler.start();
    await advance(0);
    expect(repository.readSchedule("alpha", "usage", "1d")).toEqual({ nextAt: clockStart + 95_000, failures: 1 });
    expect(repository.readSchedule("beta", "costs", "1d")).toEqual({ nextAt: clockStart + 900_000, failures: 1 });
    expect(repository.readSchedule("alpha", "costs", "1d").failures).toBe(0);
    expect(repository.readSchedule("beta", "usage", "1d").failures).toBe(0);
    await scheduler.stop();
    make({ concurrency: 4 }).start();
    await advance(94_000);
    expect(collect.mock.calls.filter(([id, query]) => id === "alpha" && query.source === "usage")).toHaveLength(1);
    await advance(1000);
    expect(repository.readSchedule("alpha", "usage", "1d")).toMatchObject({ failures: 2 });
  });

  it("backs off on a transient failure and clears failure counters after recovery", async () => {
    const collect = vi.fn().mockRejectedValueOnce(new QuotaCollectionError("transport")).mockResolvedValue({});
    const { make, repository } = fixture([organization("alpha")], collect);
    make().start();
    await advance(0);
    expect(repository.readSchedule("alpha", "usage", "1d").nextAt).toBe(clockStart + 30_000);
    await advance(30_000);
    expect(repository.readSchedule("alpha", "usage", "1d")).toEqual({ nextAt: clockStart + 90_000, failures: 0 });
  });

  it("moves the daily lookback at UTC midnight and continues querying the preceding day", async () => {
    vi.setSystemTime(Date.UTC(2025, 0, 15, 23, 59, 59));
    const { make, collect } = fixture([organization("alpha", { usageIntervalMs: 2000 })]);
    make().start();
    await advance(2000);
    const [lastDay, today] = collect.mock.calls.filter(([, query]) => query.source === "usage").map(([, query]) => query);
    expect(today.start - lastDay.start).toBe(DAY);
    expect(today.end - lastDay.end).toBe(2);
    expect(today.end - today.start).toBe(DAY + 1);
  });

  it("cancels a hung HTTP request, stops timers and publishes no next run on shutdown", async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const adapter = createOpenAIQuotaAdapter({ resolveCredential: async () => "fixture-administrative-secret", fetchImpl });
    const collect = vi.fn(async (_id, query, handler, { signal }) => handler.collect({
      ...query, organizationId: "fictional-org", credentialRef: "ref:fixture", signal,
    }));
    const { make, schedules } = fixture([organization("alpha")], collect);
    const scheduler = make({ adapters: { openai: adapter } });
    scheduler.start();
    await advance(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    expect(fetchImpl.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
    expect(schedules.size).toBe(0);
    await advance(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
