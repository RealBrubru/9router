import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { calculateCostFromTokens, ZERO_PRICING, formatCost } from "../../open-sse/providers/pricing.js";
import { extractUsage } from "../../open-sse/utils/usageTracking.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";

const pricing = { input: 2, output: 10, reasoning: 20, cached: 0, cache_creation: 5 };
const chatUsage = {
  prompt_tokens: 19, completion_tokens: 144, total_tokens: 163,
  reasoning_tokens: 128, completion_tokens_details: { reasoning_tokens: 128 },
};

describe("token cost categories", () => {
  it.each([
    { prompt_tokens: 100, completion_tokens: 20, cached_tokens: -1 },
    { prompt_tokens: 100, completion_tokens: 20, cache_creation_input_tokens: -1 },
    { prompt_tokens: 100, completion_tokens: 20, reasoning_tokens: -1 },
    { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 21 } },
    { input_tokens: -1, output_tokens: 20, cache_read_input_tokens: 100 },
    { prompt_tokens: 100, completion_tokens: -1 },
  ])("leaves inconsistent usage unpriced: %j", (usage) => {
    expect(calculateCostFromTokens(usage, pricing)).toBeNull();
  });

  it("prices included reasoning once, at a distinct rate when configured", () => {
    expect(calculateCostFromTokens(chatUsage, pricing)).toBeCloseTo(0.002758, 12);
    expect(calculateCostFromTokens(chatUsage, { input: 2, output: 10 })).toBeCloseTo(0.001478, 12);
  });

  it("normalizes native Gemini's separate reasoning consistently with translated Gemini", () => {
    const raw = {
      promptTokenCount: 100, cachedContentTokenCount: 20, candidatesTokenCount: 40,
      thoughtsTokenCount: 60, toolUsePromptTokenCount: 10, totalTokenCount: 210,
    };
    const translated = toOpenAIUsage(raw, "gemini");
    const native = extractUsage({ usageMetadata: raw });
    expect(native.completion_tokens).toBe(100);
    expect(native.prompt_tokens).toBe(110);
    for (const usage of [native, translated]) {
      expect(calculateCostFromTokens(usage, pricing)).toBeCloseTo(0.001780, 12);
    }
  });

  it("prices Anthropic's separate cache read and creation once, including a zero read rate", () => {
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 };
    expect(calculateCostFromTokens(usage, pricing)).toBeCloseTo(0.000850, 12);
  });

  it("reads native cache detail fields as subsets of the inclusive prompt", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 } };
    expect(calculateCostFromTokens(usage, { ...pricing, cache_creation: 7 })).toBeCloseTo(0.000250, 12);
  });

  it("treats Anthropic thinking details as part of the output count", () => {
    const start = { input_tokens: 25, output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } };
    const streamed = extractUsage({ type: "message_delta", usage: start });
    expect(calculateCostFromTokens(start, pricing)).toBeCloseTo(0.000850, 12);
    expect(calculateCostFromTokens(streamed, pricing)).toBeCloseTo(0.000850, 12);
  });

  it("preserves zero rates, unknown rates, and sub-cent precision", () => {
    expect(calculateCostFromTokens(chatUsage, { input: 0, output: 0, reasoning: 0 })).toBe(0);
    expect(calculateCostFromTokens(chatUsage, { input: 2, output: 10, reasoning: 0 })).toBeCloseTo(0.000198, 12);
    expect(calculateCostFromTokens(chatUsage, { output: 10 })).toBeNull();
    expect(calculateCostFromTokens({}, ZERO_PRICING)).toBeNull();
    expect(calculateCostFromTokens(chatUsage, null)).toBeNull();
    expect(calculateCostFromTokens({ prompt_tokens: 0, completion_tokens: 0 }, pricing)).toBe(0);
    expect(calculateCostFromTokens({ input_tokens: 1, output_tokens: 0 }, { input: 0.01 })).toBeCloseTo(0.00000001, 15);
    expect(formatCost(null)).toBe("—");
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("estimated cost from history to Analytics", () => {
  let dir, db, analytics, prices;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "9router-estimated-cost-"));
    vi.stubEnv("DATA_DIR", dir);
    const { getAdapter } = await import("@/lib/db/driver.js");
    db = await getAdapter();
    analytics = await import("@/lib/db/repos/usageRepo.js");
    prices = await import("@/lib/db/repos/pricingRepo.js");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("resolves a partial override the same way for the pricing UI and accounting", async () => {
    const model = "cline-free/fixture";
    await prices.updatePricing({ fixture: { [model]: { output: 3 } } });
    const resolved = await prices.getPricingForModel("fixture", model);
    expect(resolved).toEqual({ ...ZERO_PRICING, output: 3 });
    expect((await prices.getPricing()).fixture[model]).toEqual(resolved);
  });

  it("persists known cost and zeros, preserves estimates and excludes unknown costs from the subtotal", async () => {
    await prices.updatePricing({ fixture: { priced: pricing, free: ZERO_PRICING } });
    const now = new Date();
    const old = { provider: "fixture", model: "historic", timestamp: now.toISOString() };
    db.run("INSERT INTO usageHistory(timestamp, provider, model, promptTokens, completionTokens, cost, tokens) VALUES(?, ?, ?, ?, ?, ?, ?)",
      [old.timestamp, old.provider, old.model, 5, 10, 0.125, JSON.stringify({ prompt_tokens: 5, completion_tokens: 10 })]);
    db.run("INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)", [
      now.toLocaleDateString("sv-SE"),
      JSON.stringify({ requests: 1, promptTokens: 5, completionTokens: 10, cost: 0.125, byProvider: { fixture: { requests: 1, cost: 0.125 } } }),
    ]);

    for (const [model, tokens] of [
      ["priced", chatUsage],
      ["free", chatUsage],
      ["unlisted-fixture", chatUsage],
      ["priced", { prompt_tokens: 10, completion_tokens: 3, estimated: true }],
      ["priced", null],
    ]) {
      await analytics.saveRequestUsage({ provider: "fixture", model, tokens });
    }

    const entries = await analytics.getUsageHistory();
    expect(entries.find((entry) => entry.model === "historic").cost).toBe(0.125);
    expect(entries.find((entry) => entry.tokens.reasoning_tokens && entry.model === "priced").cost).toBeCloseTo(0.002758, 12);
    expect(entries.find((entry) => entry.model === "free").cost).toBe(0);
    expect(entries.find((entry) => entry.model === "unlisted-fixture").cost).toBeNull();
    expect(entries.find((entry) => entry.tokens.estimated).cost).toBeCloseTo(0.00005, 12);
    expect(entries.find((entry) => Object.keys(entry.tokens).length === 0).cost).toBeNull();

    const daily = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect(daily.cost).toBeCloseTo(0.127808, 12);
    expect(daily.unknownCostRequests).toBe(2);
    for (const period of ["all", "24h"]) {
      const stats = await analytics.getUsageStats(period);
      expect(stats.totalCost).toBeCloseTo(0.127808, 12);
      expect(stats.unknownCostRequests).toBe(2);
      expect(stats.byModel["unlisted-fixture (fixture)"].unknownCostRequests).toBe(1);
      const chart = await analytics.getChartData(period);
      expect(chart.reduce((sum, point) => sum + point.unknownCostRequests, 0)).toBe(2);
      expect(chart.reduce((sum, point) => sum + point.cost, 0)).toBeCloseTo(0.127808, 12);
    }
  });
});
