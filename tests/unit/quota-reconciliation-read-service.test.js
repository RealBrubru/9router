import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import { createQuotaRepository } from "../../src/lib/db/repos/quotaRepo.js";
import { buildCreateTableSql, TABLES } from "../../src/lib/db/schema.js";
import { createQuotaReconciliationReadService } from "../../src/lib/quota/reconciliationReadService.js";

const minute = 60_000;
const midnight = Date.UTC(2026, 0, 2);
const dayEnd = midnight + 1440 * minute;
const defaultTime = midnight + 2 * minute;
const orgId = "fixture-org-alpha";
const groupId = "fixture-group";
const org = {
  id: orgId, provider: "openai", externalId: "fixture-provider-organization",
  credentialRef: "ref:invented-secret-location", enabled: true,
  config: { groups: [{ id: groupId, limit: 1000, models: ["fixture-chat-v1"] }] },
};

let tempDir, db, repo, service, clock;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-read-service-"));
  db = createBetterSqliteAdapter(path.join(tempDir, "fixture.sqlite"));
  for (const name of ["providerConnections", "usageHistory", "usageDaily", "quotaOrganizations", "quotaConnectionBindings",
    "quotaBuckets", "quotaCollectionState"]) {
    db.exec(buildCreateTableSql(name, TABLES[name]));
    for (const sql of TABLES[name].indexes ?? []) db.exec(sql);
  }
  clock = defaultTime;
  repo = createQuotaRepository(db, { now: () => clock });
  service = createQuotaReconciliationReadService(db, { now: () => clock });
  repo.putOrganization(org);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function connection(id = "fixture-connection") {
  db.run(`INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt)
    VALUES (?, 'openai', 'apikey', ?, 'fixture', 'fixture')`, [id, JSON.stringify({ apiKey: "fixture-inference-secret" })]);
}

function bind(overrides = {}) {
  return repo.bindConnection({ organizationId: orgId, connectionId: "fixture-connection",
    apiKeyId: "fixture-admin-key-id", projectId: "fixture-admin-project-id", validFrom: midnight, ...overrides });
}

function usage({ timestamp = midnight + 1000, connectionId = "fixture-connection", model = "fixture-chat-v1",
  tokens = { prompt_tokens: 19, completion_tokens: 144, reasoning_tokens: 128, cached_tokens: 7 } } = {}) {
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, tokens, meta)
    VALUES (?, 'openai', ?, ?, 'fixture-client-secret', '/fixture-path', ?, 'fixture-payload')`,
  [new Date(timestamp).toISOString(), model, connectionId, JSON.stringify(tokens)]);
}

function row(overrides = {}) {
  return {
    model: "fixture-chat-v1", service_tier: "incentivized-tier", project_id: "fixture-admin-project-id",
    api_key_id: "fixture-admin-key-id", incentive: "incentivized", input_tokens: 300,
    output_tokens: 300, input_cached_tokens: 17, num_model_requests: 4, ...overrides,
  };
}

function bucket(start, end, rows = [row()]) {
  return { start: start / 1000, end: end / 1000, rows };
}

function collect({ start = midnight, end = clock, resolution = "1d", filters, groupBy, dataAsOf = null,
  buckets = [bucket(start, resolution === "1d" ? dayEnd : end)], organizationId = orgId } = {}) {
  return repo.collect(organizationId, {
    source: "usage", start: start / 1000, end: end / 1000, resolution, filters, groupBy,
  }, {
    collect: async query => ({ query, startedAt: clock, collectedAt: clock, dataAsOf, buckets }),
  });
}

function read(options = {}) {
  return service.read({ organizationId: orgId, groupId, ...options });
}

describe("quota reconciliation local read service", () => {
  it("uses dimensional snapshots and the half-open UTC history window without leaking secrets", async () => {
    connection();
    bind();
    usage();
    usage({ timestamp: midnight - 1 });
    usage({ timestamp: clock });
    db.run("INSERT INTO usageDaily(dateKey,data) VALUES (?, ?)", ["2026-01-01", JSON.stringify({ promptTokens: 987654 })]);
    await collect();

    const changesBeforeRead = db.get("SELECT total_changes() AS count").count;
    const result = read();
    expect(db.get("SELECT total_changes() AS count").count).toBe(changesBeforeRead);
    expect(result).toMatchObject({
      status: "available",
      policyBasis: "current_config_only",
      provenance: {
        remote: { provider: "openai", source: "usage", groupBy: ["api_key_id", "model", "project_id", "service_tier"],
          buckets: [{ bucketWindow: { start: midnight, end: dayEnd }, observedWindow: { start: midnight, end: clock },
            scope: { unit: "tokens" }, dataAsOf: null, revisionRef: expect.any(String),
            rows: [{ model: "fixture-chat-v1", serviceTier: "incentivized-tier", cachedInputTokens: "17",
              inputTokens: "300", outputTokens: "300", requests: "4", amount: "600" }] }] },
        local: { events: [{ source: "usageHistory", identity: "history_row", incentive: "unknown", state: "observed",
          amount: "163", knownAt: clock, timestamp: midnight + 1000, unit: "tokens" }], totals: { observed: "163" } },
      },
      result: {
        scope: { organizationId: orgId, groupId, unit: "tokens" },
        quality: { temporal: { status: "full" }, collection: { status: "recent" }, completeness: { status: "unknown" },
          local: { status: "partial" } },
        remote: { incentivized: "600" },
        indicative: { amount: null, blockers: [{ code: "local_coverage_partial" }] },
      },
    });
    const [local] = result.provenance.local.events;
    const [remote] = result.provenance.remote.buckets[0].rows;
    expect(local.bindingAtRecordedTime.apiKeyId).toBe(remote.apiKeyId);
    expect(local.bindingAtRecordedTime.projectId).toBe(remote.projectId);
    expect(local).not.toHaveProperty("attemptId");
    expect(result.result).not.toHaveProperty("consideredSubtotal");
    expect(result.result.indicative).not.toHaveProperty("consideredSubtotal");
    expect(result.result).not.toHaveProperty("overlap");
    const serialized = JSON.stringify(result);
    for (const value of ["fixture-inference-secret", "fixture-client-secret", "fixture-payload", "/fixture-path",
      "fixture-provider-organization", "invented-secret-location", "fixture-admin-key-id",
      "fixture-admin-project-id", "987654"]) expect(serialized).not.toContain(value);
  });

  it("keeps estimates and unknowns distinct from measured usage and counts explicit zero", async () => {
    connection();
    bind();
    usage({ tokens: { prompt_tokens: 0, completion_tokens: 0 } });
    usage({ tokens: { prompt_tokens: 4, completion_tokens: 5, estimated: true } });
    usage({ tokens: { prompt_tokens: 0 } });
    await collect({ buckets: [bucket(midnight, dayEnd, [row({ input_tokens: 0, output_tokens: 0 })])], dataAsOf: clock });
    expect(read()).toMatchObject({
      provenance: { local: { events: [
        { state: "observed", amount: "0" }, { state: "estimated", amount: "9" }, { state: "unknown", amount: null },
      ], totals: { observed: "0", estimated: "9", unknownEvents: 1 } } },
      result: { remote: { incentivized: "0" }, quality: { completeness: { status: "complete" } }, indicative: { amount: null } },
    });
  });

  it("does not assign unbound rows or infer an empty local ledger from an empty selection", async () => {
    connection();
    connection("fixture-unbound");
    bind({ validFrom: midnight + minute });
    usage({ timestamp: midnight + 1 });
    usage({ connectionId: "fixture-unbound" });
    usage({ connectionId: null });
    await collect();
    expect(read()).toMatchObject({
      provenance: { local: { events: [], reasons: expect.arrayContaining(["unattributed_history_possible"]),
        totals: { observed: null, estimated: null } } },
      result: { quality: { local: { status: "unknown" } }, indicative: { amount: null } },
    });
  });

  it("applies same-organization key rotation at the row timestamp without claiming a dispatch binding", async () => {
    const rotation = midnight + minute;
    connection();
    bind();
    bind({ validFrom: rotation, apiKeyId: "fixture-replacement-key-id" });
    usage({ timestamp: rotation - 1 });
    usage({ timestamp: rotation });
    await collect({ buckets: [bucket(midnight, dayEnd, [row(), row({ api_key_id: "fixture-replacement-key-id" })])] });
    const result = read();
    const [oldKey, newKey] = result.provenance.remote.buckets[0].rows.map(item => item.apiKeyId);
    expect(result.provenance.local.events.map(event => event.bindingAtRecordedTime)).toEqual([
      { apiKeyId: oldKey, projectId: expect.any(String), validFrom: midnight, validTo: rotation },
      { apiKeyId: newKey, projectId: expect.any(String), validFrom: rotation, validTo: null },
    ]);
    expect(oldKey).not.toBe(newKey);
    expect(result.provenance.local.reasons).toContain("no_dispatch_binding");
  });

  it("excludes connections shared across organizations when their dispatch attribution cannot be reconstructed", async () => {
    const other = "fixture-org-beta";
    repo.putOrganization({ ...org, id: other, externalId: "fixture-provider-other" });
    connection();
    bind();
    bind({ organizationId: other, validFrom: midnight + minute });
    usage({ timestamp: midnight + 1 });
    usage({ timestamp: midnight + minute });
    await collect();
    await collect({ organizationId: other, buckets: [bucket(midnight, dayEnd, [row({ input_tokens: 500 })])] });
    const first = read();
    const second = read({ organizationId: other });
    expect(first.provenance.local.events).toEqual([]);
    expect(second.provenance.local.events).toEqual([]);
    expect(first.result.remote.incentivized).toBe("600");
    expect(second.result.remote.incentivized).toBe("800");
    expect(first.provenance.remote.buckets[0].rows[0].apiKeyId).not.toBe(second.provenance.remote.buckets[0].rows[0].apiKeyId);
  });

  it("preserves unknown models and tiers and includes external-looking rows without inventing their origin", async () => {
    connection();
    bind();
    usage({ model: "fixture-unknown-version" });
    await collect({ buckets: [bucket(midnight, dayEnd, [
      row({ api_key_id: "fixture-external-key-id" }),
      row({ api_key_id: null, project_id: null, input_tokens: 50, output_tokens: 10 }),
      row({ model: "fixture-unknown-version", input_tokens: 5, output_tokens: 5 }),
      row({ service_tier: "default", incentive: "other", input_tokens: 20, output_tokens: 10 }),
    ])] });
    expect(read()).toMatchObject({
      provenance: {
        local: { events: [{ model: "fixture-unknown-version", group: "unknown", incentive: "unknown" }] },
        remote: { buckets: [{ rows: [
          { origin: "unknown", apiKeyId: expect.any(String) }, { origin: "unknown", apiKeyId: null, projectId: null },
          { model: "fixture-unknown-version", incentive: "incentivized" },
          { serviceTier: "default", incentive: "unknown" },
        ] }] },
      },
      result: {
        remote: { incentivized: "660", originUnknown: "660", external: null, gateway: null, unclassifiedModel: "10", unclassifiedTier: "30" },
        quality: { external: { status: "unreported_possible", reportedOriginUnknown: "660", attribution: "unknown", reported: null } },
        indicative: { amount: null, blockers: expect.arrayContaining([{ code: "remote_model_unclassified" }, { code: "remote_tier_unclassified" }]) },
      },
    });
  });

  it("reads one exact scope and one resolution and rejects ambiguous duplicate dimensional rows", async () => {
    await collect();
    await collect({ filters: { api_key_ids: ["fixture-admin-key-id"] }, buckets: [bucket(midnight, dayEnd, [row({ input_tokens: 900 })])] });
    await collect({ groupBy: ["model", "service_tier"], buckets: [bucket(midnight, dayEnd, [row({ input_tokens: 950 })])] });
    await collect({ resolution: "1m", buckets: [bucket(midnight, midnight + minute, [row({ input_tokens: 20, output_tokens: 10 })])] });
    expect(read().result.remote.incentivized).toBe("600");
    expect(read({ resolution: "1m" }).result.remote.incentivized).toBe("30");

    clock += minute;
    await collect({ buckets: [bucket(midnight, dayEnd, [row(), row({ input_tokens: 999 })])] });
    expect(read()).toMatchObject({
      provenance: { remote: { buckets: [{ status: "unusable", rows: [], issue: "duplicate_remote_dimensions" }] } },
      result: { remote: null, indicative: { amount: null } },
    });
  });

  it("uses the newest materialized revision, including downward correction, without replacing its identity", async () => {
    await collect();
    const [first] = read().provenance.remote.buckets;
    clock += minute;
    await collect({ buckets: [bucket(midnight, dayEnd, [row({ input_tokens: 100 })])] });
    const second = read();
    expect(second.provenance.remote.buckets).toMatchObject([
      { id: first.id, observedWindow: { end: clock }, bucketWindow: first.bucketWindow },
    ]);
    expect(second.provenance.remote.buckets[0].revisionRef).not.toBe(first.revisionRef);
    expect(second.result.remote.incentivized).toBe("400");
  });

  it("preserves omission provenance, drops omitted counters and keeps collection age distinct from completeness", async () => {
    const firstMinute = midnight + minute;
    await collect({ resolution: "1m", buckets: [bucket(midnight, firstMinute), bucket(firstMinute, defaultTime)] });
    const original = read({ resolution: "1m" }).provenance.remote.buckets;
    clock += minute;
    await collect({ resolution: "1m", buckets: [bucket(firstMinute, defaultTime, [row({ input_tokens: 10, output_tokens: 20 })])] });
    const current = read({ resolution: "1m" });
    const [omitted, kept] = current.provenance.remote.buckets;
    expect(omitted).toMatchObject({ id: original[0].id, status: "omitted", rows: [] });
    expect(omitted.revisionRef).toBe(kept.revisionRef);
    expect(current.result.remote.incentivized).toBe("30");
    expect(current.result.indicative.amount).toBeNull();

    clock += 6 * minute;
    expect(read({ resolution: "1m" }).result.quality).toMatchObject({
      collection: { status: "stale" }, completeness: { status: "unknown" },
    });
  });

  it("returns explicit zero for an empty observed bucket and unknown when the new UTC window is missing", async () => {
    await collect({ buckets: [bucket(midnight, dayEnd, [])] });
    expect(read().result.remote.incentivized).toBe("0");
    clock = dayEnd + minute;
    expect(read()).toMatchObject({
      provenance: { remote: { buckets: [] }, local: { totals: { observed: null } } },
      result: { remote: null, indicative: { amount: null }, quality: { temporal: { status: "missing" } } },
    });
  });

  it("refuses to backdate visibility and uses a later read only for an explicit retrospective horizon", async () => {
    const past = midnight + minute;
    connection();
    bind();
    await collect({ end: past });
    usage({ timestamp: midnight + 1 });
    usage({ timestamp: past + 1 });
    expect(read({ evaluatedAt: past, knowledgeAt: past })).toMatchObject({
      status: "unavailable", reason: "historical_state_unavailable", result: null,
    });
    const reconstructed = read({ evaluatedAt: past });
    expect(reconstructed).toMatchObject({
      status: "available",
      result: { evaluation: { mode: "retrospective" }, remote: { incentivized: "600" }, indicative: { amount: null } },
      provenance: { remote: { buckets: [{ knownAt: clock }] }, local: { events: [{ timestamp: midnight + 1, knownAt: clock }] } },
    });
    expect(read({ evaluatedAt: midnight - 1 })).toMatchObject({
      status: "unavailable", reason: "historical_state_unavailable", result: null,
    });
  });

  it("does not crop counters from a materialized revision beyond a requested horizon", async () => {
    await collect();
    const result = read({ evaluatedAt: midnight + minute });
    expect(result).toMatchObject({
      provenance: { remote: { buckets: [{ observedWindow: { end: clock }, dataAsOf: null }] } },
      result: { remote: null, indicative: { amount: null, blockers: expect.arrayContaining([
        expect.objectContaining({ code: "remote_counters_cross_evaluation_window" }),
      ]) } },
    });
  });

  it("does not use a collection dated beyond the actual read cutoff", async () => {
    await collect();
    clock -= minute;
    expect(read()).toMatchObject({
      provenance: { remote: { issue: "collector_state_after_read_cutoff", buckets: [] } },
      result: { remote: null, indicative: { amount: null } },
    });
  });

  it("marks a failed collection stale only when that failure is already known", async () => {
    const observedAt = clock;
    await collect();
    clock += minute;
    await collect({ buckets: [] });
    expect(read().result.quality).toMatchObject({
      collection: { status: "stale" }, completeness: { status: "unknown" },
    });
    clock = observedAt;
    expect(read().result.quality).toMatchObject({
      collection: { status: "recent" }, completeness: { status: "unknown" },
    });
  });
});
