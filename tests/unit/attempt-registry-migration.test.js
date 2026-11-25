import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import { buildCreateTableSql, TABLES, SCHEMA_VERSION } from "../../src/lib/db/schema.js";
import initial from "../../src/lib/db/migrations/001-initial.js";
import migration from "../../src/lib/db/migrations/003-inference-attempt-registry.js";
import { createAttemptRegistryRepository } from "../../src/lib/db/repos/attemptRegistryRepo.js";

let temp, db;
const registryTables = ["inferenceRequests", "inferenceAttempts", "inferenceAttemptEvents", "inferenceCoverageEpochs", "inferenceUsageLinks"];
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-registry-migration-"));
  vi.stubEnv("DATA_DIR", temp);
  vi.resetModules();
});

afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

async function previousSchema() {
  const { DATA_FILE, BACKUPS_DIR, ensureDirs } = await import("@/lib/db/paths.js");
  ensureDirs();
  db = createBetterSqliteAdapter(DATA_FILE);
  db.transaction(() => {
    for (const [name, def] of Object.entries(TABLES)) {
      if (registryTables.includes(name)) continue;
      db.exec(buildCreateTableSql(name, def));
      for (const index of def.indexes ?? []) db.exec(index);
    }
    db.exec(`INSERT INTO _meta(key,value) VALUES ('schemaVersion','2'), ('backupSchemaVersion','3');
      INSERT INTO usageHistory(id,timestamp,provider,promptTokens,completionTokens)
        VALUES (1,'2026-01-01T00:00:00.000Z','openai',19,144);
      INSERT INTO usageDaily(dateKey,data) VALUES ('2026-01-01','{"requests":1}');
      INSERT INTO quotaOrganizations(id,provider,externalId,credentialRef,enabled,config)
        VALUES ('fixture-org','openai','fixture-admin-org','ref:fixture',0,'{}');`);
  });
  return { file: DATA_FILE, backups: BACKUPS_DIR };
}

function version(key) {
  return db.get("SELECT value FROM _meta WHERE key = ?", [key]).value;
}

function registryNames(adapter) {
  return adapter.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'inference%' ORDER BY name").map(row => row.name);
}

describe("Attempt Registry migration", () => {
  it("upgrades the Collector schema with a usable pre-migration backup and no backfill", async () => {
    const { file, backups } = await previousSchema();
    const before = ["usageHistory", "usageDaily", "quotaOrganizations"].map(table => db.all(`SELECT * FROM ${table}`));
    const legacyDefinitions = db.all(`SELECT name,sql FROM sqlite_master
      WHERE type='table' AND name IN ('usageHistory','usageDaily','quotaOrganizations') ORDER BY name`);
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    await runMigrationOnce(db);
    expect(version("schemaVersion")).toBe(String(migration.version));
    expect(version("backupSchemaVersion")).toBe(String(SCHEMA_VERSION));
    expect(registryNames(db)).toEqual([...registryTables].sort());
    expect(db.all(`SELECT name,sql FROM sqlite_master
      WHERE type='table' AND name IN ('usageHistory','usageDaily','quotaOrganizations') ORDER BY name`)).toEqual(legacyDefinitions);
    expect(["usageHistory", "usageDaily", "quotaOrganizations"].map(table => db.all(`SELECT * FROM ${table}`))).toEqual(before);
    for (const table of registryTables) expect(db.get(`SELECT COUNT(*) AS n FROM ${table}`).n).toBe(0);

    const [backup] = fs.readdirSync(backups).filter(name => name.startsWith("schema-3-to-4"));
    expect(backup).toBeTruthy();
    const restoredFile = path.join(temp, "restored.sqlite");
    fs.copyFileSync(path.join(backups, backup, "data.sqlite"), restoredFile);
    const restored = createBetterSqliteAdapter(restoredFile);
    try {
      expect(registryNames(restored)).toEqual([]);
      expect(restored.get("SELECT completionTokens FROM usageHistory").completionTokens).toBe(144);
    } finally {
      restored.close();
    }
    db.close();
    db = createBetterSqliteAdapter(file);
    await runMigrationOnce(db);
    expect(registryNames(db)).toEqual([...registryTables].sort());
    expect(fs.readdirSync(backups).filter(name => name.startsWith("schema-3-to-4"))).toHaveLength(1);
  });

  it("rolls back DDL and the version marker on a partial migration failure", async () => {
    const { file } = await previousSchema();
    const { runMigrationOnce } = await import("@/lib/db/migrate.js");
    const failing = {
      ...db,
      exec(sql) {
        if (sql.includes("idx_ia_org_dispatch")) throw new Error("fixture DDL failure");
        return db.exec(sql);
      },
    };
    await expect(runMigrationOnce(failing)).rejects.toThrow("fixture DDL failure");
    expect(version("schemaVersion")).toBe("2");
    expect(version("backupSchemaVersion")).toBe("3");
    expect(registryNames(db)).toEqual([]);
    expect(db.get("SELECT promptTokens FROM usageHistory").promptTokens).toBe(19);
    db.close();
    db = createBetterSqliteAdapter(file);
    await runMigrationOnce(db);
    expect(version("schemaVersion")).toBe("3");
  });
});

describe("Attempt Registry SQLite drivers", () => {
  it.each([
    ["node:sqlite", async file => (await import("../../src/lib/db/adapters/nodeSqliteAdapter.js")).createNodeSqliteAdapter(file)],
    ["sql.js", async file => (await import("../../src/lib/db/adapters/sqljsAdapter.js")).createSqlJsAdapter(file)],
  ])("preserves state, rollback and ordered events through a reopen on %s", async (name, open) => {
    const originalEmit = process.emit;
    const file = path.join(temp, "driver-fixture.sqlite");
    try {
      db = await open(file);
      db.transaction(() => initial.up(db));
      const repo = createAttemptRegistryRepository(db, { now: () => 10 });
      const epoch = { id: id(1), instanceId: id(2), operation: "chat", route: "chat", transport: "http",
        instrumentationVersion: "pilot", barrierCertified: true, openedAt: 1 };
      if (name === "sql.js") expect(() => repo.openEpoch(epoch)).toThrow("barrier_durability_unavailable");
      repo.openEpoch({ ...epoch, barrierCertified: name !== "sql.js" });
      repo.prepare({ eventId: id(3), occurredAt: 2, knownAt: 2,
        request: { id: id(4), route: "chat", receivedAt: 1 }, attempt: { id: id(5), epochId: id(1), provider: "openai", purpose: "primary" } });
      db.exec(`CREATE TRIGGER fixture_fail_event BEFORE INSERT ON inferenceAttemptEvents WHEN NEW.kind = 'dispatch'
        BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
      const dispatch = { attemptId: id(5), eventId: id(6), expectedVersion: 1, occurredAt: 3, knownAt: 3, binding: { status: "unknown" } };
      expect(() => repo.markDispatchPossible(dispatch)).toThrow("fixture write failure");
      expect(repo.readAsKnownAt(id(5), repo.captureReadCutoff()).attempt.version).toBe(1);
      db.exec("DROP TRIGGER fixture_fail_event");
      repo.markDispatchPossible(dispatch);
      db.close();
      db = null;
      db = await open(file);
      const reopened = createAttemptRegistryRepository(db, { now: () => 11 });
      expect(reopened.readAsKnownAt(id(5), reopened.captureReadCutoff())).toMatchObject({
        attempt: { state: "dispatch_possible", version: 2 }, events: [{ version: 1 }, { version: 2 }],
      });
    } finally {
      process.emit = originalEmit;
    }
  });
});
