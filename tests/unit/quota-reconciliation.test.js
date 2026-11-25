import { describe, expect, it } from "vitest";
import { reconcileQuota } from "../../src/lib/quota/reconciliation.js";

const midnight = Date.UTC(2026, 0, 2);
const minute = 60_000;
const current = { start: midnight, end: midnight + 2 * minute };
const daily = { start: midnight, end: midnight + 24 * 60 * minute };
const scope = { organizationId: "fixture-org", groupId: "fixture-group", policyRevision: "v1", unit: "tokens" };
const dimensions = { model: "fixture-chat-v1", apiKeyId: "fixture-inference-id", projectId: "fixture-project" };
const usageScope = "fixture-unfiltered-scope";
const attemptKnownAt = midnight + 2000;

function row(overrides = {}) {
  return {
    id: "row-1", ...dimensions, serviceTier: "incentivized-tier", incentive: "incentivized",
    origin: "gateway", keyUse: "exclusive", amount: "600", ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    id: "daily-bucket", revision: 1, source: "usage", scope, resolution: "1d", usageScope,
    populationCoverage: "complete", bucketWindow: daily, observedWindow: current, status: "observed",
    collectedAt: current.end, knownAt: current.end, dataAsOf: current.end, rows: [row()], ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: "attempt-1", ...dimensions, scope, state: "observed", amount: "250",
    window: { start: midnight + 1000, end: attemptKnownAt }, knownAt: attemptKnownAt, ...overrides,
  };
}

function proof(overrides = {}) {
  return {
    id: "evidence-1", basis: "verified-exclusive-aggregate", reference: "synthetic-audit-record",
    observationId: "daily-bucket", revision: 1, rowId: "row-1", attemptId: "attempt-1",
    attemptKnownAt, knownAt: current.end, amount: "200",
    ...overrides,
  };
}

function example(overrides = {}) {
  const { policy, ...input } = overrides;
  return {
    policy: {
      scope, window: daily, resolution: "1d", usageScope, scale: 0, limit: "1000", safetyMargin: "0.1",
      knownAt: midnight - minute, validFrom: midnight - minute, validTo: null,
      maxReportingLagMs: 0, maxCollectionAgeMs: 5 * minute, maxObservationTailMs: 0, models: [dimensions.model], excludedModels: ["another-group"], ...policy,
    },
    evaluatedAt: current.end,
    localCoverage: { status: "complete", knownAt: midnight - minute },
    observations: [snapshot()],
    attempts: [attempt()],
    evidence: [],
    ...input,
  };
}

describe("passive quota reconciliation", () => {
  it("keeps unproven local usage even when remote counters match it", () => {
    const result = reconcileQuota(example({ observations: [snapshot({ rows: [row({ amount: "250" })] })] }));
    expect(result).toMatchObject({
      thresholdAfterMargin: "900", indicative: { status: "current", amount: "400" }, consideredSubtotal: "500",
      remote: { incentivized: "250" }, local: { observed: "250", notProvenIncluded: "250" }, overlap: { amount: "0" },
    });
  });

  it.each([
    ["none", [], "0", "50"],
    ["exact", [proof({ amount: "250" })], "250", "300"],
    ["partial", [proof()], "200", "250"],
  ])("accounts for %s overlap", (_, evidence, amount, balance) => {
    const result = reconcileQuota(example({ evidence }));
    expect(result.overlap).toMatchObject({ amount, accepted: evidence });
    expect(result.indicative.amount).toBe(balance);
  });

  it.each([
    [proof({ reference: null }), "missing_verification"],
    [proof({ basis: "equal-counters" }), "missing_verification"],
    [proof({ amount: "251" }), "overlap_out_of_bounds"],
    [proof({ amount: "0" }), "overlap_out_of_bounds"],
    [proof({ amount: "-1" }), "invalid_overlap_amount"],
    [proof({ amount: 200 }), "invalid_overlap_amount"],
    [proof({ attemptId: "missing" }), "observation_or_attempt_unavailable"],
    [proof({ revision: 0 }), "observation_or_attempt_unavailable"],
  ])("rejects invalid evidence (%#)", (evidence, reason) => {
    const result = reconcileQuota(example({ evidence: [evidence] }));
    expect(result.overlap).toEqual({ amount: "0", accepted: [], rejected: [{ id: evidence.id, reason }] });
    expect(result.indicative.amount).toBe("50");
  });

  it("rejects amounts above the observed remote value", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [row({ amount: "100" })] })],
      evidence: [proof({ amount: "101" })],
    }));
    expect(result.overlap.rejected[0].reason).toBe("overlap_out_of_bounds");
    expect(result.overlap.amount).toBe("0");
  });

  it("prevents competing claims for the same local attempt even below the total", () => {
    const result = reconcileQuota(example({ evidence: [proof({ amount: "20" }), proof({ id: "evidence-2", amount: "20" })] }));
    expect(result.overlap).toMatchObject({
      amount: "0", rejected: [
        { id: "evidence-1", reason: "overlap_conflict" },
        { id: "evidence-2", reason: "overlap_conflict" },
      ],
    });
  });

  it("rejects claims whose combined amount exceeds the remote row", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [row({ amount: "300" })] })],
      attempts: [attempt(), attempt({ id: "attempt-2" })],
      evidence: [proof(), proof({ id: "evidence-2", attemptId: "attempt-2" })],
    }));
    expect(result.overlap).toMatchObject({ amount: "0", rejected: [
      { id: "evidence-1", reason: "overlap_conflict" }, { id: "evidence-2", reason: "overlap_conflict" },
    ] });
  });

  it("rejects duplicate evidence IDs without counting them twice", () => {
    const result = reconcileQuota(example({ evidence: [proof(), proof()] }));
    expect(result.overlap).toEqual({ amount: "0", accepted: [], rejected: [{ id: "evidence-1", reason: "duplicate_evidence" }] });
  });

  it.each([
    { apiKeyId: "different-key" }, { projectId: null }, { projectId: "different-project" },
    { model: "different-model" }, { serviceTier: "different-admin-tier" },
  ])("rejects incompatible dimensions (%#)", overrides => {
    const result = reconcileQuota(example({
      policy: { models: [dimensions.model, "different-model"] },
      attempts: [attempt(overrides)],
      evidence: [proof()],
    }));
    expect(result.overlap.rejected[0].reason).toBe("incompatible_dimensions");
    expect(result.local.notProvenIncluded).toBe("250");
  });

  it.each(["organizationId", "groupId", "policyRevision", "unit"])("rejects records in a different %s", field => {
    const foreign = { ...scope, [field]: "different-scope" };
    expect(reconcileQuota(example({ observations: [snapshot(), snapshot({ scope: foreign })] }))).toMatchObject({
      remote: { incentivized: "600" },
      indicative: { amount: null, blockers: [{ code: "remote_scope_incompatible" }] },
    });
    expect(reconcileQuota(example({ attempts: [attempt(), attempt({ scope: foreign })] }))).toMatchObject({
      local: { observed: "250" },
      indicative: { amount: null, blockers: [{ code: "local_scope_incompatible" }] },
    });
  });

  it("requires a matching population scope for balance and keeps local coverage explicit", () => {
    expect(reconcileQuota(example({ observations: [snapshot({ usageScope: "filtered-to-one-key" })] }))).toMatchObject({
      remote: null, indicative: { amount: null, blockers: expect.arrayContaining([{ code: "remote_scope_incompatible" }]) },
    });
    const result = reconcileQuota(example({
      observations: [snapshot({ populationCoverage: "partial" })], localCoverage: { status: "unknown", knownAt: midnight }, attempts: [],
    }));
    expect(result).toMatchObject({
      quality: { temporal: { status: "full" }, population: "partial", local: { status: "unknown" } },
      indicative: { amount: null, blockers: [{ code: "remote_population_partial" }, { code: "local_coverage_unknown" }] },
    });
  });

  it("preserves external and indeterminate origins in the remote total", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [
        row({ amount: "400" }),
        row({ id: "external", amount: "125", origin: "external" }),
        row({ id: "shared", amount: "75", origin: "unknown", keyUse: "shared" }),
      ] })],
      evidence: [proof({ rowId: "external", amount: "100" }), proof({ id: "evidence-2", rowId: "shared", amount: "50" })],
    }));
    expect(result.remote).toMatchObject({ gateway: "400", external: "125", originUnknown: "75", incentivized: "600" });
    expect(result.overlap).toMatchObject({ amount: "0", rejected: [
      { id: "evidence-1", reason: "unproven_attribution" }, { id: "evidence-2", reason: "unproven_attribution" },
    ] });
  });

  it("keeps verified non-incentivized usage separate from usage eligible for this group", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [row({ incentive: "not-incentivized", serviceTier: "fixture-paid-tier" })] })],
      attempts: [attempt({ incentive: "not-incentivized" })],
    }));
    expect(result).toMatchObject({
      indicative: { amount: "900" }, remote: { incentivized: "0", notIncentivized: "600" },
      local: { observed: "0", counts: { outsideScope: 1 } },
    });
  });

  it("accepts direct audited attempt identity on a shared key only when it links both sides", () => {
    const evidence = [proof({ basis: "verified-attempt" })];
    const shared = overrides => [snapshot({ rows: [row({ keyUse: "shared", origin: "unknown", ...overrides })] })];
    expect(reconcileQuota(example({ observations: shared({ attemptId: "other" }), evidence })).overlap.rejected[0].reason)
      .toBe("unproven_attribution");
    expect(reconcileQuota(example({ observations: shared({ attemptId: "attempt-1" }), evidence })).overlap.amount).toBe("200");
    expect(reconcileQuota(example({
      observations: [snapshot({ rows: [row({ attemptId: "other" })] })], evidence: [proof()],
    })).overlap.rejected[0].reason).toBe("unproven_attribution");
  });

  it("blocks the balance for potentially eligible models and tiers without classification", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [
        row({ id: "unknown-model", model: "unmapped-version", amount: "50" }),
        row({ id: "unknown-tier", serviceTier: null, incentive: "unknown", amount: "100" }),
        row({ id: "other", incentive: "not-incentivized", amount: "90" }),
        row({ id: "out", model: "another-group", amount: "75" }),
      ] })],
      attempts: [attempt({ model: null })],
    }));
    expect(result).toMatchObject({
      indicative: { status: "unknown", amount: null, blockers: [
        { code: "remote_model_unclassified" }, { code: "remote_tier_unclassified" },
        { code: "local_model_unclassified", subject: "attempt-1" },
      ] }, remote: {
        incentivized: "0", unclassifiedModel: "50", unclassifiedTier: "100", notIncentivized: "90", outsideGroup: "75",
      },
      local: { observed: "250", notProvenIncluded: "250" },
    });
  });

  it("keeps cache and reasoning breakdown out of the canonical total", () => {
    const amount = "163"; // 19 input (including 6 cached) + 144 output (including 128 reasoning)
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [row({ amount, input_cached_tokens: 6, reasoning_tokens: 128 })] })],
      attempts: [attempt({ amount, cachedTokens: 6, reasoningTokens: 128 })],
      evidence: [proof({ amount })],
    }));
    expect(result).toMatchObject({ remote: { incentivized: amount }, consideredSubtotal: amount, indicative: { amount: "737" } });
  });

  it("distinguishes unavailable rows, explicit zero and a trusted explicit empty bucket", () => {
    const none = reconcileQuota(example({ observations: [], attempts: [] }));
    const zero = reconcileQuota(example({ observations: [snapshot({ rows: [row({ amount: "0" })] })], attempts: [attempt({ amount: "0" })] }));
    const empty = reconcileQuota(example({ observations: [snapshot({ rows: [] })], attempts: [] }));
    expect(none).toMatchObject({ quality: { temporal: { status: "missing" } }, indicative: { amount: null }, remote: null });
    expect(zero).toMatchObject({ quality: { temporal: { status: "full" } }, indicative: { amount: "900" }, remote: { incentivized: "0" }, local: { counts: { observed: 1 } } });
    expect(empty).toMatchObject({ quality: { temporal: { status: "full" } }, indicative: { amount: "900" }, remote: { incentivized: "0" }, local: { counts: { observed: 0 } } });
    expect(reconcileQuota(example({
      observations: [snapshot({ rows: [], dataAsOf: null })], attempts: [],
    }))).toMatchObject({
      remote: { incentivized: "0" }, quality: { collection: { status: "recent" }, completeness: { status: "unknown" } },
      indicative: { amount: null, blockers: [{ code: "remote_zero_without_completeness" }] },
    });
    expect(() => reconcileQuota(example({ observations: [snapshot({ rows: [row({ amount: null })] })] })))
      .toThrow("remote amount");
  });

  it("preserves subtotals and blocks the indication with a material gap inside the reference window", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ observedWindow: { start: midnight + minute, end: current.end } })],
    }));
    expect(result).toMatchObject({
      quality: { temporal: { status: "partial", referenceGaps: [{ start: midnight, end: midnight + minute }] },
        collection: { status: "recent" } },
      indicative: { amount: null, blockers: [{ code: "remote_coverage_partial" }] }, remote: { incentivized: "600" },
    });
  });

  it.each([
    [{ dataAsOf: null }, "recent", "unknown", "current", "50"],
    [{ dataAsOf: midnight + minute }, "recent", "partial", "unknown", null],
    [{ status: "stale", dataAsOf: null }, "stale", "unknown", "historical", "50"],
    [{ status: "stale" }, "stale", "complete", "historical", "50"],
  ])("keeps collection quality and effective completeness independent (%#)", (overrides, collection, completeness, status, amount) => {
    const result = reconcileQuota(example({ observations: [snapshot(overrides)] }));
    expect(result).toMatchObject({
      indicative: { status, amount, referenceWindow: current },
      quality: { temporal: { status: "full" }, collection: { status: collection }, completeness: { status: completeness } },
      remote: { incentivized: "600" },
    });
    if (completeness !== "complete") expect(result).toMatchObject({
      indicative: { assumptions: ["external_usage_only_as_reported"], limitations: expect.arrayContaining([`provider_completeness_${completeness}`]) },
      quality: { external: { status: "unreported_possible" } },
    });
  });

  it("uses only the reference horizon for the indication and retains later local usage in diagnostics", () => {
    const observedWindow = { start: midnight, end: midnight + minute };
    const later = attempt({ id: "later", amount: "45", knownAt: current.end,
      window: { start: observedWindow.end + 1, end: current.end } });
    const input = example({
      observations: [snapshot({ observedWindow, collectedAt: observedWindow.end, knownAt: observedWindow.end, dataAsOf: null })],
      attempts: [attempt(), later],
    });
    const historical = reconcileQuota(input);
    expect(historical).toMatchObject({
      consideredSubtotal: "895", local: { observed: "295" },
      quality: { temporal: { status: "partial", gaps: [{ start: observedWindow.end, end: current.end }], referenceGaps: [] } },
      indicative: { amount: "50", status: "historical", referenceWindow: observedWindow, consideredSubtotal: "850",
        limitations: expect.arrayContaining(["remote_tail_unobserved"]) },
    });
    expect(reconcileQuota({ ...input, policy: { ...input.policy, maxObservationTailMs: minute } }).indicative)
      .toMatchObject({ amount: "50", status: "current", referenceWindow: observedWindow });
    const unbounded = { ...later, state: "pending", amount: null };
    expect(reconcileQuota({ ...input, attempts: [attempt(), unbounded] }).indicative)
      .toMatchObject({ amount: null, blockers: [{ code: "local_without_upper_bound", subject: "later" }] });
  });

  it("detects collection age independently even with a complete provider watermark", () => {
    const result = reconcileQuota(example({ evaluatedAt: current.end + 6 * minute }));
    expect(result).toMatchObject({
      quality: { collection: { status: "stale", lastCollectedAt: current.end }, completeness: { status: "complete" } },
      indicative: { status: "historical", amount: "50", referenceWindow: current },
    });
  });

  it("reports a known partial watermark within policy without manufacturing completeness", () => {
    const dataAsOf = midnight + minute;
    const result = reconcileQuota(example({
      policy: { maxReportingLagMs: minute }, observations: [snapshot({ dataAsOf })],
    }));
    expect(result).toMatchObject({
      observations: [{ dataAsOf }],
      quality: { completeness: { status: "partial", requiredThrough: dataAsOf, gaps: [{ start: dataAsOf, end: current.end }] } },
      indicative: { status: "current", amount: "50", assumptions: ["external_usage_only_as_reported"] },
    });
    for (const key of ["balance", "operationalBalance", "guaranteedBalance", "authorized"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("does not hide a known material completeness gap behind an unknown watermark on another bucket", () => {
    const first = { start: midnight, end: midnight + minute };
    const second = { start: first.end, end: current.end };
    const result = reconcileQuota(example({
      policy: { resolution: "1m" },
      observations: [
        snapshot({ id: "first", resolution: "1m", bucketWindow: first, observedWindow: first, dataAsOf: null }),
        snapshot({ id: "second", resolution: "1m", bucketWindow: second, observedWindow: second, dataAsOf: first.end }),
      ],
    }));
    expect(result).toMatchObject({
      quality: { collection: { status: "recent" }, completeness: { status: "unknown" } },
      indicative: { amount: null, blockers: [{ code: "remote_completeness_material_gap" }] },
    });
  });

  it("replaces an older revision, including a downward correction, and invalidates its proof", () => {
    const latest = snapshot({ revision: 2, rows: [row({ amount: "500" })] });
    const result = reconcileQuota(example({ observations: [latest, snapshot()], evidence: [proof()] }));
    expect(result).toMatchObject({
      indicative: { amount: "150" }, remote: { incentivized: "500" }, overlap: { amount: "0" },
      ignoredObservations: [{ id: "daily-bucket", revision: 1, reason: "superseded_revision" }],
    });
    expect(result.overlap.rejected[0].reason).toBe("observation_or_attempt_unavailable");
  });

  it("advances the observed window of an open bucket without changing its identity or adding counts", () => {
    const first = snapshot({ observedWindow: { start: midnight, end: midnight + minute }, collectedAt: midnight + minute,
      knownAt: midnight + minute, dataAsOf: null });
    const latest = snapshot({ revision: 2, dataAsOf: null, rows: [row({ amount: "500" })] });
    const result = reconcileQuota(example({
      observations: [latest, first], evidence: [proof({ knownAt: first.knownAt })],
    }));
    expect(result).toMatchObject({
      observations: [{ id: first.id, revision: 2, bucketWindow: daily, observedWindow: current }],
      remote: { incentivized: "500" }, indicative: { amount: "150", status: "current" },
      overlap: { amount: "0", rejected: [{ id: "evidence-1", reason: "observation_or_attempt_unavailable" }] },
    });
    expect(() => reconcileQuota(example({
      observations: [first, { ...latest, bucketWindow: current }],
    }))).toThrow("observation nominal window changed");
  });

  it("keeps contemporary results invariant when later remote revisions and proofs are supplied", () => {
    const late = snapshot({ revision: 2, collectedAt: current.end + 1, knownAt: current.end + 2,
      rows: [row({ amount: "500" })] });
    const evidence = [proof({ revision: 2, knownAt: late.knownAt })];
    const full = example({ observations: [snapshot(), late], evidence });
    expect(reconcileQuota(full)).toEqual(reconcileQuota(example()));
    expect(reconcileQuota({ ...full, knowledgeAt: late.knownAt })).toMatchObject({
      evaluation: { mode: "retrospective", evaluatedAt: current.end, knowledgeAt: late.knownAt },
      remote: { incentivized: "500" }, overlap: { amount: "200" },
      indicative: { amount: "350", status: "historical", limitations: expect.arrayContaining(["retrospective_knowledge"]) },
    });
  });

  it("does not crop counters from a later revision to fit a retrospective horizon", () => {
    const laterWindow = { start: midnight, end: current.end + minute };
    const later = snapshot({ revision: 2, observedWindow: laterWindow,
      collectedAt: laterWindow.end, knownAt: laterWindow.end, dataAsOf: null });
    const result = reconcileQuota(example({ knowledgeAt: later.knownAt, observations: [snapshot(), later] }));
    expect(result).toMatchObject({
      remote: null, indicative: { amount: null, blockers: expect.arrayContaining([
        { code: "remote_counters_cross_evaluation_window", subject: later.id },
      ]) },
    });
  });

  it("uses overlap evidence only after verification and only for the pinned local state", () => {
    const later = current.end + 1;
    const evidence = [proof({ knownAt: later })];
    expect(reconcileQuota(example({ evidence }))).toEqual(reconcileQuota(example()));
    expect(reconcileQuota(example({ knowledgeAt: later, evidence })).overlap.amount).toBe("200");
    expect(reconcileQuota(example({ evidence: [proof({ knownAt: current.end - 1 })] })).overlap.rejected)
      .toEqual([{ id: "evidence-1", reason: "evidence_chronology" }]);
    expect(reconcileQuota(example({
      attempts: [attempt(), attempt({ knownAt: attemptKnownAt + 1, amount: "260" })], evidence: [proof()],
    }))).toMatchObject({
      local: { observed: "260", counts: { observed: 1 } },
      overlap: { amount: "0", rejected: [{ id: "evidence-1", reason: "evidence_chronology" }] },
    });
  });

  it("does not use coverage or a policy revision before it becomes known", () => {
    const later = current.end + 1;
    const input = example({ policy: { knownAt: later }, localCoverage: { status: "complete", knownAt: later } });
    expect(reconcileQuota(input)).toMatchObject({
      limit: null, remote: null, indicative: { amount: null, blockers: [{ code: "policy_not_known_at_cutoff" }] },
    });
    expect(reconcileQuota({ ...input, knowledgeAt: later })).toMatchObject({
      quality: { local: { status: "complete", knownAt: later } },
      indicative: { amount: "50", status: "historical" },
    });
    expect(reconcileQuota({ ...input, policy: example().policy })).toMatchObject({
      quality: { local: { status: "unknown", knownAt: null } },
      indicative: { amount: null, blockers: [{ code: "local_coverage_unknown" }] },
    });
    expect(reconcileQuota(example({ policy: { validFrom: midnight + 1 } })).indicative)
      .toMatchObject({ amount: null, blockers: [{ code: "policy_not_valid_for_window" }] });
  });

  it("leaves a gap when the latest revision omits the bucket", () => {
    const omitted = snapshot({ revision: 2, status: "omitted", dataAsOf: null, rows: [] });
    const result = reconcileQuota(example({ observations: [snapshot(), omitted] }));
    expect(result).toMatchObject({
      indicative: { amount: null }, quality: { temporal: { status: "missing", gaps: [current] } }, remote: null, local: { observed: "250" },
      observations: [{ revision: 2, status: "omitted" }],
    });
  });

  it("never mixes daily and minute counters or claims", () => {
    const minutes = snapshot({ id: "one-minute", resolution: "1m", observedWindow: { start: midnight, end: midnight + minute } });
    const result = reconcileQuota(example({ observations: [minutes, snapshot()], evidence: [proof({ observationId: minutes.id })] }));
    expect(result).toMatchObject({
      indicative: { amount: "50" }, remote: { incentivized: "600" }, overlap: { amount: "0" },
      ignoredObservations: [{ id: minutes.id, revision: 1, reason: "alternative_resolution" }],
    });
    expect(() => reconcileQuota(example({ observations: [snapshot(), snapshot({ id: "duplicate-window" })] })))
      .toThrow("overlapping primary observations");
  });

  it.each([
    [{ state: "estimated", amount: "25" }, "local_without_upper_bound"],
    [{ state: "estimated", amount: "25", upperBound: { amount: "10", reference: "cap" } }, "local_invalid_upper_bound"],
    [{ state: "estimated", amount: "25", upperBound: { amount: "50", reference: "" } }, "local_invalid_upper_bound"],
    [{ state: "pending", amount: null, reserved: "100" }, "local_without_upper_bound"],
    [{ state: "unknown", amount: null }, "local_without_upper_bound"],
  ])("keeps balance unknown when a tentative amount has no defensible upper bound (%#)", (overrides, code) => {
    const result = reconcileQuota(example({ attempts: [attempt(overrides)] }));
    expect(result).toMatchObject({ indicative: { amount: null, blockers: [{ code, subject: "attempt-1" }] }, local: { counts: { [overrides.state]: 1 } } });
  });

  it("counts the conservative bound and reserve once per unmeasured attempt", () => {
    const result = reconcileQuota(example({ attempts: [
      attempt({ state: "estimated", amount: "20", upperBound: { amount: "75", reference: "output-cap" } }),
      attempt({ id: "second", state: "pending", amount: null, reserved: "40", upperBound: { amount: "60", reference: "request-cap" } }),
      attempt({ id: "third", state: "pending", amount: null, reserved: "90", upperBound: { amount: "80", reference: "request-cap" } }),
    ] }));
    expect(result).toMatchObject({
      indicative: { amount: "75" }, consideredSubtotal: "825", local: { observed: "0", estimated: "20", reserved: "130", unreservedBound: "95", counts: { pending: 2 } },
    });
    expect(result.local.bounds[1]).toEqual({
      attemptId: "second", state: "pending", reference: "request-cap", amount: "60", reserved: "40", unreserved: "20",
    });
  });

  it("shows the known subtotal including a reserve when pending exposure remains indeterminate", () => {
    const pending = attempt({ id: "pending", state: "pending", amount: null, reserved: "40" });
    expect(reconcileQuota(example({ attempts: [attempt(), pending] }))).toMatchObject({
      remote: { incentivized: "600" },
      local: { observed: "250", reserved: "40" },
      indicative: { amount: null, consideredSubtotal: "890", blockers: [{ code: "local_without_upper_bound", subject: "pending" }] },
    });
  });

  it("holds the full possible use on each side of UTC renewal until attribution is proved", () => {
    const window = { start: midnight - 2000, end: midnight + 17_000 };
    const pending = attempt({ window, knownAt: window.start, state: "pending", amount: null, reserved: "40",
      upperBound: { amount: "100", reference: "synthetic-cap" } });
    const crossing = attempt({ window, knownAt: window.end, amount: "80" });
    const previous = { start: midnight - minute, end: midnight };
    const previousInput = example({
      policy: { window: previous }, evaluatedAt: midnight, attempts: [crossing, pending],
      observations: [snapshot({ bucketWindow: previous, observedWindow: previous, knownAt: midnight, collectedAt: midnight, dataAsOf: midnight })],
    });
    const before = reconcileQuota(previousInput);
    expect(before).toEqual(reconcileQuota({ ...previousInput, attempts: [pending] }));
    expect(before).toMatchObject({
      evaluation: { mode: "contemporaneous" }, indicative: { amount: "200", status: "historical" },
      local: { observed: "0", reserved: "40", counts: { pending: 1, crossesWindow: 1 } },
    });
    const reconstructed = reconcileQuota({ ...previousInput, knowledgeAt: window.end });
    expect(reconstructed).toMatchObject({
      evaluation: { mode: "retrospective" }, indicative: { amount: "220", status: "historical" },
      local: { observed: "80", reserved: "0", counts: { pending: 0, crossesWindow: 1 } },
    });
    const after = reconcileQuota(example({ attempts: [pending, crossing], evidence: [proof({ amount: "80", attemptKnownAt: window.end })] }));
    expect(after).toMatchObject({ indicative: { amount: "220" }, local: { observed: "80", counts: { crossesWindow: 1 } }, overlap: { amount: "0" } });
    expect(after.overlap.rejected[0].reason).toBe("incompatible_dimensions");
    expect(reconcileQuota(example({ evaluatedAt: midnight, observations: [], attempts: [pending, crossing] })).indicative.amount).toBeNull();
  });

  it("does not turn an empty new UTC bucket into available quota with a prior-day watermark", () => {
    const result = reconcileQuota(example({
      observations: [snapshot({ rows: [], dataAsOf: midnight - 1000 })], attempts: [],
      policy: { maxReportingLagMs: 5 * minute },
    }));
    expect(result).toMatchObject({
      indicative: { amount: null, blockers: [{ code: "remote_completeness_material_gap" }] },
      quality: { temporal: { status: "full" }, collection: { status: "recent" }, completeness: { status: "partial" } },
    });
  });

  it("does not carry last-window observations into a new UTC window", () => {
    const previous = { start: midnight - minute, end: midnight };
    const result = reconcileQuota(example({
      observations: [snapshot({ bucketWindow: previous, observedWindow: previous, dataAsOf: midnight })],
      attempts: [],
    }));
    expect(result).toMatchObject({
      observations: [], remote: null, quality: { temporal: { status: "missing", gaps: [current] } },
      indicative: { amount: null, status: "unknown", referenceWindow: null },
    });
  });

  it.each([["300", "0"], ["301", "1"]])("returns a known zero balance at and beyond the operational limit", (amount, excess) => {
    expect(reconcileQuota(example({ attempts: [attempt({ amount })] }))).toMatchObject({ indicative: { amount: "0", excess } });
  });

  it("uses exact decimals for money and integers beyond Number.MAX_SAFE_INTEGER", () => {
    const money = { ...scope, unit: "USD" };
    const result = reconcileQuota(example({
      policy: { scope: money, scale: 18, limit: "100.000000000000000003", safetyMargin: "0.1" },
      observations: [snapshot({ scope: money, rows: [row({ amount: "0.000000000000000001" })] })],
      attempts: [attempt({ scope: money, amount: "0.100000000000000001" })],
    }));
    expect(result).toMatchObject({
      marginWithheld: "10.000000000000000001", thresholdAfterMargin: "90.000000000000000002",
      consideredSubtotal: "0.100000000000000002", indicative: { amount: "89.9" },
    });
    expect(reconcileQuota(example({
      policy: { limit: "9007199254740995", safetyMargin: "0" },
      observations: [snapshot({ rows: [row({ amount: "9007199254740993" })] })],
      attempts: [attempt({ amount: "1" })],
    })).indicative.amount).toBe("1");
  });

  it("is deterministic across input order, idempotent across calls and leaves the input intact", () => {
    const input = example({
      observations: [snapshot(), snapshot({ revision: 2 })],
      attempts: [attempt(), attempt({ id: "other", amount: "100" })],
      evidence: [proof({ revision: 2 }), proof({ id: "other", revision: 2, attemptId: "other", amount: "80" })],
    });
    const original = structuredClone(input);
    const first = reconcileQuota(input);
    expect(reconcileQuota(input)).toEqual(first);
    expect(reconcileQuota({
      ...input, observations: [...input.observations].reverse(),
      attempts: [...input.attempts].reverse(), evidence: [...input.evidence].reverse(),
    })).toEqual(first);
    expect(input).toEqual(original);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
