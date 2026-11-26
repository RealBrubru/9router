import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import initial from "../../src/lib/db/migrations/001-initial.js";
import { createAttemptRegistryRepository } from "../../src/lib/db/repos/attemptRegistryRepo.js";
import { createQuotaRepository } from "../../src/lib/db/repos/quotaRepo.js";
import { createAttemptProfiler } from "../fixtures/attempt-registry-profiler.mjs";

it.runIf(process.env.RUN_ATTEMPT_PROFILE === "1")("inspects Registry storage, query plans and writer contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "attempt-sqlite-profile-"));
  const file = join(dir, "profile.sqlite");
  const db = createBetterSqliteAdapter(file);
  let writer;
  try {
    vi.stubEnv("DATA_DIR", dir);
    const { createOpenAiDirectAttemptPilot } = await import("../../src/lib/quota/openAiDirectAttemptPilot.js");
    db.transaction(() => initial.up(db));
    db.run(`INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt)
      VALUES ('fixture-bound', 'openai', 'apikey', 'fixture', 1, '{}', 'fixture', 'fixture')`);
    const quota = createQuotaRepository(db);
    quota.putOrganization({ id: "fixture-org", provider: "openai", externalId: "fixture-external", credentialRef: "ref:fixture", enabled: false });
    quota.bindConnection({ organizationId: "fixture-org", connectionId: "fixture-bound", apiKeyId: "fixture-key", validFrom: 0 });
    const profiler = createAttemptProfiler(db);
    const begin = createOpenAiDirectAttemptPilot({
      openDb: () => profiler.adapter, env: { ATTEMPT_REGISTRY_OPENAI_DIRECT: "true" },
    });
    function simulate(connectionId) {
      const observer = begin().forModel("openai/fixture-model").execution()
        .prepare({ connectionId, sentModel: "fixture-model" });
      observer.beforeSend(true);
      observer.observeResponse(new Response(null, { status: 200 }));
      observer.json({ model: "fixture-model", choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } });
    }
    simulate("fixture-unbound");
    simulate("fixture-bound");
    profiler.phase("load");
    for (let i = 0; i < 300; i++) for (const connection of ["fixture-unbound", "fixture-bound"]) simulate(connection);
    profiler.phase("idle");
    expect(db.get("SELECT COUNT(*) n FROM inferenceAttempts WHERE state = 'closed'").n).toBe(602);
    expect(db.get("SELECT COUNT(*) n FROM inferenceAttempts WHERE organizationId IS NOT NULL").n).toBe(301);

    const { id } = db.get("SELECT id FROM inferenceAttempts LIMIT 1");
    const plans = {
      eventIdentity: db.all("EXPLAIN QUERY PLAN SELECT * FROM inferenceAttemptEvents WHERE attemptId = ? AND eventId = ?", [id, randomUUID()]),
      latestUsage: db.all("EXPLAIN QUERY PLAN SELECT details FROM inferenceAttemptEvents WHERE attemptId = ? AND kind = 'usage' ORDER BY version DESC LIMIT 1", [id]),
      knownAt: db.all("EXPLAIN QUERY PLAN SELECT * FROM inferenceAttemptEvents WHERE attemptId = ? AND knownAt <= ? AND sequence <= ? ORDER BY version", [id, Date.now(), 10000]),
      binding: db.all("EXPLAIN QUERY PLAN SELECT organizationId, validFrom FROM quotaConnectionBindings WHERE connectionId = ? AND validFrom <= ? AND (validTo IS NULL OR validTo > ?) LIMIT 2", ["fixture-bound", Date.now(), Date.now()]),
    };
    const pages = db.all(`SELECT name, sum(pgsize) bytes FROM dbstat
      WHERE name LIKE 'inference%' OR name GLOB 'idx_i[acr]*' OR name LIKE 'sqlite_autoindex_inference%'
      GROUP BY name ORDER BY name`);
    expect(plans.eventIdentity.some(row => row.detail.includes("INDEX"))).toBe(true);
    expect(pages.find(row => row.name === "inferenceAttemptEvents").bytes).toBeGreaterThan(0);

    const repo = profiler.repository(createAttemptRegistryRepository(profiler.adapter));
    profiler.phase("coverage");
    for (let i = 0; i < 60; i++) {
      const occurredAt = Date.now();
      const epoch = repo.openEpoch({ id: randomUUID(), instanceId: randomUUID(), instrumentationVersion: "fixture",
        route: "chat_completions", operation: "chat", transport: "http", barrierCertified: false, openedAt: occurredAt });
      const retired = i % 2 ? repo.closeEpoch({ id: epoch.id, occurredAt })
        : repo.markCoverageGap({ id: epoch.id, occurredAt, reason: "storage_failure" });
      expect(retired.closedAt).toBe(occurredAt);
    }
    profiler.phase("idle");

    db.exec("CREATE TABLE profileCounter (value INTEGER); INSERT INTO profileCounter VALUES (0)");
    db.checkpoint();
    const control = { emptyBegin: [], emptyCommit: [], writeBegin: [], writeStatement: [], writeCommit: [], adapterEmpty: [], adapterWrite: [] };
    function sample(label, operation) {
      const start = performance.now();
      operation();
      control[label].push(performance.now() - start);
    }
    for (let i = 0; i < 300; i++) {
      const write = () => db.run("UPDATE profileCounter SET value = value + 1");
      sample("emptyBegin", () => db.run("BEGIN"));
      sample("emptyCommit", () => db.run("COMMIT"));
      sample("writeBegin", () => db.run("BEGIN"));
      sample("writeStatement", write);
      sample("writeCommit", () => db.run("COMMIT"));
      sample("adapterEmpty", () => db.transaction(() => {}));
      sample("adapterWrite", () => db.transaction(write));
    }
    expect(db.get("SELECT value FROM profileCounter").value).toBe(600);
    const controls = Object.fromEntries(Object.entries(control).map(([name, values]) => {
      const sorted = values.slice(1).toSorted((a, b) => a - b);
      return [name, [0.5, 0.95, 0.99].map(p => sorted[Math.ceil(p * sorted.length) - 1])];
    }));

    // A separate connection holds the lock. The shorter limit exists only in this diagnostic.
    writer = createBetterSqliteAdapter(file);
    db.exec("PRAGMA busy_timeout = 25");
    const lock = [];
    for (let i = 0; i < 3; i++) {
      writer.exec("BEGIN IMMEDIATE");
      const timerStart = performance.now();
      const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - timerStart), 0));
      const started = performance.now();
      let code;
      try { db.run("UPDATE inferenceAttempts SET version = version WHERE id = ?", [id]); }
      catch (error) { code = error.code; }
      finally { writer.exec("ROLLBACK"); }
      expect(code).toBe("SQLITE_BUSY");
      lock.push({ callMs: performance.now() - started, timerMs: await timer });
    }

    const { coverage, load } = profiler.report();
    console.log("ATTEMPT_SQLITE_PROFILE", JSON.stringify({ plans, pages, lock, controls, coverage: coverage.transaction,
      bindingValidation: load.statements["other/binding_validation"],
      bindingCandidates: load.statements["gateway/binding_candidates"],
    }));
  } finally {
    vi.unstubAllEnvs();
    writer?.close();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
