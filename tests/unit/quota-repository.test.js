import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const start = 86400;
const end = start + 86400;
const day = { source: "usage", start, end };
const nextDay = { ...day, start: end, end: end + 86400 };
const record = {
  object: "organization.usage.completions.result",
  input_tokens: 32, output_tokens: 9, num_model_requests: 2, service_tier: "incentivized-tier",
};
const adminCredential = "invented-admin-only-fixture";
let tempDir, db, repo, clock, createOpenAIQuotaAdapter;

const fixtureOrg = {
  id: "local-alpha", provider: "openai", externalId: "fixture-org-alpha", credentialRef: "ref:alpha", enabled: true,
  config: { groups: [{ id: "first", limit: 850, models: ["fixture-model"] }] },
};
function reply(results = [record], query = day, next = null) {
  const data = results === null ? [] : [{ object: "bucket", start_time: query.start, end_time: query.end, results }];
  return Response.json({ data, object: "page", has_more: next !== null, next_page: next });
}
function adapter(fetchImpl) {
  return createOpenAIQuotaAdapter({
    fetchImpl, resolveCredential: async () => adminCredential, maxRetries: 0, now: () => clock,
  });
}
async function openRepo() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { createQuotaRepository } = await import("@/lib/db/repos/quotaRepo.js");
  ({ createOpenAIQuotaAdapter } = await import("../../src/lib/quota/openai.js"));
  db = await getAdapter();
  repo = createQuotaRepository(db, { now: () => clock });
}

function closeRepo() {
  db?.close();
  db = undefined;
  delete global._dbAdapter;
  vi.resetModules();
}

function addConnection(id) {
  db.run(`INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt)
    VALUES (?, 'openai', 'apikey', '{}', 'fixture', 'fixture')`, [id]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-repo-"));
  vi.stubEnv("DATA_DIR", tempDir);
  closeRepo();
  clock = 10_000;
});
afterEach(() => {
  closeRepo();
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("quota SQLite repository", () => {
  it("removes the native adapter shutdown listeners after repeated closes", async () => {
    const events = ["beforeExit", "SIGINT", "SIGTERM"];
    const before = events.map(event => process.listenerCount(event));
    await openRepo();
    const nativeDriver = db.driver === "better-sqlite3";
    closeRepo();
    if (nativeDriver) expect(events.map(event => process.listenerCount(event))).toEqual(before);
  });

  it("creates the new schema, reopens it and keeps only the credential reference", async () => {
    await openRepo();
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("2");
    expect(() => repo.putOrganization({ ...fixtureOrg, credentialRef: adminCredential })).toThrow();
    expect(() => repo.putOrganization({ ...fixtureOrg, credentialRef: "ref:sk-admin-fixture" })).toThrow();
    repo.putOrganization(fixtureOrg);
    await repo.collect(fixtureOrg.id, day, adapter(async () => reply()));
    const snapshot = repo.readSnapshot(fixtureOrg.id, day);
    expect(snapshot.status).toBe("valid");
    expect(snapshot.lastSuccess).toMatchObject({ window: { start, end }, collectedAt: clock, dataAsOf: null });
    expect(snapshot.lastSuccess.buckets[0].rows[0].input_tokens).toBe(32);
    const { DATA_FILE } = await import("@/lib/db/paths.js");
    closeRepo();
    expect(fs.readFileSync(DATA_FILE).includes(adminCredential)).toBe(false);
    await openRepo();
    expect(repo.readSnapshot(fixtureOrg.id, day)).toEqual(snapshot);
    expect(db.get("SELECT credentialRef FROM quotaOrganizations").credentialRef).toBe("ref:alpha");
  });

  it("upgrades an actual legacy-shaped file and retains a usable pre-change backup", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { TABLES, buildCreateTableSql } = await import("@/lib/db/schema.js");
    const { DATA_FILE, BACKUPS_DIR, ensureDirs } = await import("@/lib/db/paths.js");
    ensureDirs();
    const old = new DatabaseSync(DATA_FILE);
    for (const [name, def] of Object.entries(TABLES)) {
      if (!name.startsWith("quota")) old.exec(buildCreateTableSql(name, def));
    }
    old.exec(`INSERT INTO _meta(key,value) VALUES('schemaVersion','1'),('backupSchemaVersion','2');
      INSERT INTO usageHistory(timestamp,promptTokens,completionTokens) VALUES('fixture', 32, 9);
      INSERT INTO usageDaily(dateKey,data) VALUES('fixture','{}');`);
    const priorUsageSchema = old.prepare("SELECT sql FROM sqlite_master WHERE name IN ('usageHistory','usageDaily') ORDER BY name").all();
    old.close();

    await openRepo();
    expect(db.get("SELECT value FROM _meta WHERE key = 'backupSchemaVersion'").value).toBe("3");
    expect(db.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value).toBe("2");
    expect(db.all("SELECT sql FROM sqlite_master WHERE name IN ('usageHistory','usageDaily') ORDER BY name")).toEqual(priorUsageSchema);
    expect(db.get("SELECT promptTokens FROM usageHistory").promptTokens).toBe(32);
    expect(db.get("SELECT dateKey FROM usageDaily").dateKey).toBe("fixture");
    repo.putOrganization(fixtureOrg);

    const backupDir = fs.readdirSync(BACKUPS_DIR).find(name => name.startsWith("schema-2-to-3"));
    expect(backupDir).toBeTruthy();
    const restoredPath = path.join(tempDir, "restored.sqlite");
    fs.copyFileSync(path.join(BACKUPS_DIR, backupDir, "data.sqlite"), restoredPath);
    const restored = new DatabaseSync(restoredPath);
    expect(restored.prepare("SELECT completionTokens FROM usageHistory").get().completionTokens).toBe(9);
    expect(restored.prepare("SELECT value FROM _meta WHERE key = 'schemaVersion'").get().value).toBe("1");
    expect(restored.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'quota%'").all()).toEqual([]);
    restored.close();

    closeRepo();
    await openRepo();
    expect(db.get("SELECT COUNT(*) AS n FROM quotaOrganizations").n).toBe(1);
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(1);
    expect(fs.readdirSync(BACKUPS_DIR).filter(name => name.startsWith("schema-2-to-3"))).toHaveLength(1);
  });

  it("reapplies a query without duplicates and replaces all rows in a revised bucket", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    const first = adapter(async () => reply([record, { ...record, service_tier: "default" }]));
    await repo.collect(fixtureOrg.id, day, first);
    await repo.collect(fixtureOrg.id, day, first);
    expect(db.get("SELECT COUNT(*) AS n FROM quotaBuckets").n).toBe(1);
    clock += 31;
    await repo.collect(fixtureOrg.id, day, adapter(async () => reply([{ ...record, input_tokens: 35 }])));
    const snapshot = repo.readSnapshot(fixtureOrg.id, day);
    expect(snapshot.lastSuccess.buckets[0].rows).toEqual([{
      input_tokens: 35, output_tokens: 9, num_model_requests: 2, service_tier: "incentivized-tier", incentive: "incentivized",
    }]);
    expect(snapshot.lastSuccess.collectedAt).toBe(clock);
    expect(snapshot.gaps).toEqual([]);
  });

  it("rolls back bucket writes if the snapshot marker fails and retains the previous observation", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    await repo.collect(fixtureOrg.id, day, adapter(async () => reply()));
    const before = repo.readSnapshot(fixtureOrg.id, day).lastSuccess;
    db.exec(`CREATE TRIGGER fail_quota_publish BEFORE INSERT ON quotaCollectionState
      WHEN NEW.lastSuccess IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic write error'); END`);
    await expect(repo.collect(fixtureOrg.id, day, adapter(async () => reply([{ ...record, input_tokens: 99 }]))))
      .rejects.toMatchObject({ code: "persistence" });
    const state = repo.readSnapshot(fixtureOrg.id, day);
    expect(state.status).toBe("stale");
    expect(state.lastAttempt.error.code).toBe("persistence");
    expect(state.lastSuccess).toEqual(before);
    expect(db.get("SELECT data FROM quotaBuckets").data).not.toContain('"input_tokens":99');
  });

  it("keeps a previous snapshot after an intermediate page fails", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    const query = { ...day, resolution: "1m", end: start + 120 };
    const firstMinute = { ...query, end: start + 60 };
    await repo.collect(fixtureOrg.id, query, adapter(async () => reply([record], firstMinute)));
    const before = repo.readSnapshot(fixtureOrg.id, query).lastSuccess;
    const fetch = vi.fn().mockResolvedValueOnce(reply([{ ...record, input_tokens: 99 }], firstMinute, "fixture-next"))
      .mockResolvedValueOnce(new Response(adminCredential, { status: 403 }));
    await expect(repo.collect(fixtureOrg.id, query, adapter(fetch))).rejects.toMatchObject({ status: 403 });
    expect(repo.readSnapshot(fixtureOrg.id, query).lastSuccess).toEqual(before);
    expect(JSON.stringify(db.get("SELECT lastAttempt FROM quotaCollectionState"))).not.toContain(adminCredential);
  });

  it("treats a new day as unknown until observed and distinguishes omission from an empty bucket", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    await repo.collect(fixtureOrg.id, day, adapter(async () => reply()));
    const old = repo.readSnapshot(fixtureOrg.id, day).lastSuccess;
    expect(repo.readSnapshot(fixtureOrg.id, nextDay)).toMatchObject({ status: "unknown", lastSuccess: old });
    expect(await repo.collect(fixtureOrg.id, nextDay, adapter(async () => reply(null, nextDay))))
      .toEqual({ outcome: "no_data" });
    expect(repo.readSnapshot(fixtureOrg.id, nextDay)).toMatchObject({
      status: "unknown", gaps: [{ start: nextDay.start, end: nextDay.end }], lastSuccess: old,
    });
    await repo.collect(fixtureOrg.id, nextDay, adapter(async () => reply([], nextDay)));
    const empty = repo.readSnapshot(fixtureOrg.id, nextDay);
    expect(empty).toMatchObject({ status: "valid", gaps: [], lastSuccess: { buckets: [{ rows: [] }] } });
    expect(repo.listObservedBuckets(fixtureOrg.id, day)).toEqual(old.buckets);
    clock += 300_000;
    expect(repo.readSnapshot(fixtureOrg.id, nextDay).status).toBe("stale");
  });

  it("limits coverage to the requested window even when a provider bucket ends later", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    const partial = { ...day, end: start + 260 };
    await repo.collect(fixtureOrg.id, partial, adapter(async () => reply()));
    expect(repo.readSnapshot(fixtureOrg.id, day)).toMatchObject({
      status: "valid", coverage: "partial", gaps: [{ start: partial.end, end }],
      lastSuccess: { dataAsOf: null, window: { start, end: partial.end } },
    });
  });

  it("keeps zero and unknown amounts distinct, separately from Usage", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    const query = { ...day, source: "costs" };
    const cost = { object: "organization.costs.result", line_item: "fixture", quantity: 9 };
    await repo.collect(fixtureOrg.id, query, adapter(async () => reply([
      { ...cost, amount: { value: 0, currency: "usd" } }, cost,
    ], query)));
    expect(repo.readSnapshot(fixtureOrg.id, query).lastSuccess.buckets[0].rows.map(row => row.amount))
      .toEqual([{ value: "0", currency: "usd" }, undefined]);
    expect(repo.readSnapshot(fixtureOrg.id, day)).toMatchObject({ status: "unknown", lastSuccess: null });
  });

  it("isolates organizations and query scopes and blocks same-endpoint concurrent collections", async () => {
    await openRepo();
    repo.putOrganization(fixtureOrg);
    const beta = { ...fixtureOrg, id: "local-beta", externalId: "fixture-org-beta", credentialRef: "ref:beta" };
    repo.putOrganization(beta);
    const slowFetch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    let finish;
    const pending = repo.collect(fixtureOrg.id, day, adapter(slowFetch));
    await expect(repo.collect(fixtureOrg.id, { ...day, groupBy: [] }, adapter(slowFetch)))
      .rejects.toMatchObject({ code: "in_progress" });
    await repo.collect(beta.id, day, adapter(async () => reply([{ ...record, input_tokens: 15 }])));
    finish(reply());
    await pending;
    expect(repo.readSnapshot(fixtureOrg.id, day).lastSuccess.buckets[0].rows[0].input_tokens).toBe(32);
    expect(repo.readSnapshot(beta.id, day).lastSuccess.buckets[0].rows[0].input_tokens).toBe(15);
    expect(repo.readSnapshot(fixtureOrg.id, { ...day, filters: { api_key_ids: ["other-key"] } }).status).toBe("unknown");
    expect(repo.readSnapshot("missing-org", day)).toBeNull();
  });

  it("tracks key rotations and allows multiple connections to share the same key ID", async () => {
    await openRepo();
    const { id: organizationId } = repo.putOrganization(fixtureOrg);
    addConnection("first-connection");
    addConnection("second-connection");
    const base = { organizationId, apiKeyId: "shared-fixture-key-id", validFrom: 50 };
    const first = { ...base, connectionId: "first-connection" };
    expect(repo.bindConnection(first)).toEqual(repo.bindConnection(first));
    repo.bindConnection({ ...base, connectionId: "second-connection" });
    repo.bindConnection({ ...first, apiKeyId: "replacement-fixture-key-id", validFrom: 70 });
    expect(repo.getConnectionBinding(organizationId, first.connectionId, 49)).toBeNull();
    expect(repo.getConnectionBinding(organizationId, first.connectionId, 69))
      .toMatchObject({ apiKeyId: base.apiKeyId, validTo: 70 });
    expect(repo.getConnectionBinding(organizationId, first.connectionId, 70).apiKeyId).toBe("replacement-fixture-key-id");
    expect(repo.getConnectionBinding(organizationId, "second-connection", 70).apiKeyId).toBe(base.apiKeyId);
    expect(repo.getConnectionBinding("another-org", first.connectionId, 70)).toBeNull();
    expect(() => repo.bindConnection({ ...first, validFrom: 65 })).toThrow();
    expect(repo.classifyModel(organizationId, "fixture-model")).toEqual({ status: "classified", groupId: "first" });
    expect(repo.classifyModel(organizationId, "other-model")).toEqual({ status: "unknown" });
  });
});
