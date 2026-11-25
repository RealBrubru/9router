import { describe, expect, it, vi } from "vitest";
import { createOpenAIQuotaAdapter } from "../../src/lib/quota/openai.js";

const credential = "fixture-admin-secret";
const start = 86400;
const day = { source: "usage", start, end: start + 86400 };
const minute = { ...day, resolution: "1m", end: start + 180 };
const target = { organizationId: "fixture-org", credentialRef: "ref:fixture" };
const usage = {
  object: "organization.usage.completions.result",
  input_tokens: 43,
  output_tokens: 12,
  input_cached_tokens: 25,
  input_cache_write_tokens: 6,
  input_cache_write_30m_tokens: null,
  input_cache_write_12h_tokens: 6,
  num_model_requests: 3,
  model: "fixture-model",
  service_tier: "incentivized-tier",
  project_id: null,
  api_key_id: "fixture-key-id",
};
function bucket(from = start, to = start + 60, results = [usage]) {
  return { object: "bucket", start_time: from, end_time: to, results };
}
function page(data, next = null) {
  return Response.json({ object: "page", data, has_more: next !== null, next_page: next });
}
function setup(fetchImpl, options = {}) {
  const resolveCredential = vi.fn(async () => credential);
  const sleep = vi.fn(async () => {});
  const adapter = createOpenAIQuotaAdapter({ fetchImpl, resolveCredential, sleep, ...options });
  return { adapter, resolveCredential, sleep, collect: input => adapter.collect({ ...target, ...input }) };
}

describe("OpenAI administrative quota adapter", () => {
  it("loads one daily page with organization, grouping, filters and a separate key", async () => {
    const fetch = vi.fn(async () => page([bucket(start, day.end)]));
    const { collect, resolveCredential } = setup(fetch, { now: () => 1000 });
    const observation = await collect({ ...day, filters: { api_key_ids: ["fixture-key-id"] } });
    expect(resolveCredential).toHaveBeenCalledExactlyOnceWith("ref:fixture");
    const [[url, options]] = fetch.mock.calls;
    expect(url.origin + url.pathname).toBe("https://api.openai.com/v1/organization/usage/completions");
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(url.searchParams.getAll("group_by")).toEqual(["api_key_id", "model", "project_id", "service_tier"]);
    expect(url.searchParams.getAll("api_key_ids")).toEqual(["fixture-key-id"]);
    expect(options).toMatchObject({
      method: "GET", redirect: "error",
      headers: { Authorization: `Bearer ${credential}`, "OpenAI-Organization": "fixture-org" },
    });
    expect(observation).toMatchObject({
      startedAt: 1000, collectedAt: 1000, dataAsOf: null,
      buckets: [{ start, end: day.end, rows: [{ ...Object.fromEntries(
        Object.entries(usage).filter(([field]) => field !== "object")), incentive: "incentivized" }] }],
    });
    expect(observation.buckets[0].rows[0]).not.toHaveProperty("input_uncached_tokens");
    expect(JSON.stringify(observation)).not.toContain(credential);
  });

  it("consumes all pages and preserves explicit empty minute buckets", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(page([bucket()], "next=fixture"))
      .mockResolvedValueOnce(page([bucket(start + 60, start + 120, []), bucket(start + 120, start + 180)]));
    const result = await setup(fetch).collect(minute);
    expect(fetch.mock.calls[0][0].searchParams.has("page")).toBe(false);
    expect(fetch.mock.calls[1][0].searchParams.get("page")).toBe("next=fixture");
    expect(fetch.mock.calls[1][0].searchParams.get("bucket_width")).toBe("1m");
    expect(result.buckets).toHaveLength(3);
    expect(result.buckets[1].rows).toEqual([]);
  });

  it("does not expose partial observations if a middle page fails", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(page([bucket()], "next"))
      .mockResolvedValueOnce(new Response("failure", { status: 502 }));
    await expect(setup(fetch, { maxRetries: 0 }).collect(minute))
      .rejects.toMatchObject({ code: "http_error", status: 502 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, [], 3, "  "])("rejects invalid continuation cursor %j", async next_page => {
    const fetch = vi.fn(async () => Response.json({ object: "page", data: [], has_more: true, next_page }));
    await expect(setup(fetch).collect(day)).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects repeated cursors, overlapping buckets and a page limit overrun", async () => {
    const repeat = vi.fn(async () => page([], "repeated"));
    await expect(setup(repeat).collect(day)).rejects.toMatchObject({ code: "invalid_response" });
    expect(repeat).toHaveBeenCalledTimes(2);
    await expect(setup(async () => page([bucket(), bucket()])).collect(day))
      .rejects.toMatchObject({ code: "invalid_response" });
    await expect(setup(async () => page([], "next"), { maxPages: 1 }).collect(day))
      .rejects.toMatchObject({ code: "pagination_limit" });
  });

  it.each([401, 403])("does not retry or echo response bodies on %s", async status => {
    const fetch = vi.fn(async () => new Response(credential, { status }));
    const error = await setup(fetch).collect(day).catch(err => err);
    expect(error).toMatchObject({ code: "authorization", status });
    expect(`${error.stack}${JSON.stringify(error)}`).not.toContain(credential);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["2", "Thu, 01 Jan 1970 00:00:02 GMT"])("honors Retry-After %s", async value => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": value } }))
      .mockResolvedValueOnce(page([bucket()]));
    const { collect, sleep } = setup(fetch, { now: () => 0 });
    await collect(day);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it("surfaces rate limits whose delay exceeds the retry budget", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "70" } }));
    const { collect, sleep } = setup(fetch);
    await expect(collect(day)).rejects.toMatchObject({ code: "rate_limited", status: 429, retryAfterMs: 70000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("backs off and stops retrying server errors at the configured limit", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const { collect, sleep } = setup(fetch, { maxRetries: 2, backoffMs: 100 });
    await expect(collect(day)).rejects.toMatchObject({ code: "http_error", status: 503 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("times out and aborts a hanging transport", async () => {
    const fetch = vi.fn(() => new Promise(() => {}));
    await expect(setup(fetch, { timeoutMs: 5, maxRetries: 0 }).collect(day))
      .rejects.toMatchObject({ code: "timeout" });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it.each([
    () => new Response("not JSON"),
    () => Response.json({ object: "page", data: [] }),
    () => page([{ ...bucket(), results: null }]),
    () => page([bucket(start, start + 60, [{ ...usage, output_tokens: null }])]),
    () => page([bucket(start + 86400, start + 86460)]),
  ])("rejects a malformed or incomplete response", async reply => {
    await expect(setup(async () => reply()).collect(day)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("keeps non-incentive tiers separate from unknown tiers and never labels them billed", async () => {
    const { service_tier, ...missingTier } = usage;
    const rows = [usage, { ...usage, service_tier: "default" }, { ...usage, service_tier: null }, missingTier];
    const result = await setup(async () => page([bucket(start, start + 60, rows)])).collect(day);
    expect(result.buckets[0].rows.map(row => row.incentive)).toEqual(["incentivized", "other", "unknown", "unknown"]);
    expect(result.buckets[0].rows[3]).not.toHaveProperty("service_tier");
  });

  it("passes Costs groups, preserves amounts of zero and retains missing amounts", async () => {
    const type = { object: "organization.costs.result", line_item: "fixture, cache writes", quantity: 3, quantity_unit: "tokens" };
    const fetch = vi.fn(async () => page([bucket(start, day.end, [
      { ...type, amount: { value: 0.0, currency: "usd" } }, { ...type, amount: null }, type,
      { ...type, amount: { value: 0.000000011, currency: "usd" } },
    ])]));
    const result = await setup(fetch).collect({ ...day, source: "costs", groupBy: ["line_item", "project_id", "api_key_id"] });
    expect(fetch.mock.calls[0][0].pathname).toBe("/v1/organization/costs");
    expect(fetch.mock.calls[0][0].searchParams.getAll("group_by")).toEqual(["api_key_id", "line_item", "project_id"]);
    expect(result.buckets[0].rows.map(row => row.amount)).toEqual([
      { value: "0", currency: "usd" }, null, undefined, { value: "1.1e-8", currency: "usd" },
    ]);
  });

  it("redacts transport and credential resolver exceptions and rejects echoed credentials", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const errors = await Promise.all([
        setup(async () => { throw new Error(credential); }, { maxRetries: 0 }).collect(day).catch(err => err),
        setup(vi.fn(), { resolveCredential: async () => { throw new Error(credential); } }).collect(day).catch(err => err),
        setup(async () => page([bucket(start, start + 60, [{ ...usage, model: credential }])])).collect(day).catch(err => err),
        setup(async () => page([], credential)).collect(day).catch(err => err),
      ]);
      expect(errors.map(err => err.code)).toEqual(["transport", "configuration", "invalid_response", "invalid_response"]);
      expect(errors.map(err => err.stack).join()).not.toContain(credential);
      expect(logged).not.toHaveBeenCalled();
      expect(warned).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      warned.mockRestore();
    }
  });
});
