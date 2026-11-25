import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/modelCatalog/sync.js", () => ({ startModelCatalogSync: vi.fn() }));
vi.mock("@/lib/consoleLogBuffer", () => ({ initConsoleLogCapture: vi.fn() }));
vi.mock("open-sse/providers/catalogOverride.js", () => ({ installCatalogSource: vi.fn() }));

const day = 86400;
const today = Date.UTC(2025, 0, 15) / 1000;
const midnight = today * 1000;
const realTimer = globalThis.setTimeout;

async function waitForIo(complete) {
  for (let i = 0; i < 250; i++) {
    if (complete()) return;
    await new Promise(resolve => realTimer(resolve, 2));
  }
  throw new Error("Synthetic quota collection did not finish");
}

it.skipIf(process.platform !== "linux")("Next server startup collects without a Dashboard and reuses durable schedule and history", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-runtime-"));
  const secrets = path.join(temp, "secrets");
  fs.mkdirSync(secrets);
  fs.writeFileSync(path.join(secrets, "sandbox"), "sk-admin-fixture-runtime-only", { mode: 0o400 });
  vi.stubEnv("DATA_DIR", temp);
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("QUOTA_COLLECTOR_SECRETS_DIR", secrets);
  vi.stubEnv("QUOTA_COLLECTOR_SECRET_REFS", "ref:sandbox");
  vi.stubEnv("QUOTA_COLLECTOR_ENABLED", "false");

  const { register } = await import("../../src/instrumentation.js");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { createQuotaRepository } = await import("@/lib/db/repos/quotaRepo.js");
  const { startQuotaCollector, stopQuotaCollector, quotaCollectorStartedAt } = await import("@/lib/quota/runtime.js");
  let oldInput = 11;
  let releaseUsage;
  const heldUsage = new Promise(resolve => { releaseUsage = resolve; });
  const fetch = vi.fn(async url => {
    const usage = url.pathname.endsWith("/completions");
    if (usage) await heldUsage;
    const requestedEnd = Number(url.searchParams.get("end_time"));
    const currentStart = Math.floor(requestedEnd / day) * day;
    const result = input => ({
      object: "organization.usage.completions.result", model: "fixture-model",
      input_tokens: input, output_tokens: 2, num_model_requests: 1, service_tier: "incentivized-tier",
    });
    return Response.json({
      object: "page", has_more: false, next_page: null,
      data: usage ? [
        { object: "bucket", start_time: currentStart - day, end_time: currentStart, results: [result(oldInput)] },
        { object: "bucket", start_time: currentStart, end_time: currentStart + day, results: [result(5)] },
      ] : [],
    });
  });
  vi.stubGlobal("fetch", fetch);

  let db;
  try {
    db = await getAdapter();
    vi.useFakeTimers();
    vi.setSystemTime(midnight + 1000);
    let repo = createQuotaRepository(db);
    repo.putOrganization({
      id: "local-fixture", provider: "openai", externalId: "fictional-org", credentialRef: "ref:sandbox",
      enabled: true,
    });
    await register();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("QUOTA_COLLECTOR_ENABLED", "true");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).not.toHaveBeenCalled();

    vi.stubEnv("NEXT_PHASE", undefined);
    await register();
    const starting = startQuotaCollector();
    expect(startQuotaCollector()).toBe(starting);
    await starting;
    await vi.advanceTimersByTimeAsync(0);
    expect(quotaCollectorStartedAt("local-fixture", "usage", "1d")).toBe(Date.now());
    releaseUsage();
    await waitForIo(() => repo.readSchedule("local-fixture", "usage", "1d") &&
      repo.readSchedule("local-fixture", "costs", "1d"));
    expect(fetch).toHaveBeenCalledTimes(2);
    const history = { source: "usage", start: today - day, end: today };
    expect(repo.listObservedBuckets("local-fixture", history)[0].rows[0].input_tokens).toBe(11);
    const next = repo.readSchedule("local-fixture", "usage", "1d").nextAt;
    await stopQuotaCollector();
    db.close();
    delete global._dbAdapter;
    vi.resetModules();

    const nextDriver = await import("@/lib/db/driver.js");
    const nextRepos = await import("@/lib/db/repos/quotaRepo.js");
    const nextRuntime = await import("@/lib/quota/runtime.js");
    db = await nextDriver.getAdapter();
    repo = nextRepos.createQuotaRepository(db);
    oldInput = 27;
    await nextRuntime.startQuotaCollector();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(repo.readSchedule("local-fixture", "usage", "1d").nextAt).toBe(next);
    await vi.advanceTimersByTimeAsync(next - Date.now());
    await waitForIo(() => repo.readSchedule("local-fixture", "usage", "1d")?.nextAt > next);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(repo.listObservedBuckets("local-fixture", history)).toMatchObject([{ rows: [{ input_tokens: 27 }] }]);
  } finally {
    await stopQuotaCollector();
    db?.close();
    delete global._dbAdapter;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
