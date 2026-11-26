import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAttemptRegistryRepository } from "../../src/lib/db/repos/attemptRegistryRepo.js";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import { createNodeSqliteAdapter } from "../../src/lib/db/adapters/nodeSqliteAdapter.js";
import { createSqlJsAdapter } from "../../src/lib/db/adapters/sqljsAdapter.js";
import initial from "../../src/lib/db/migrations/001-initial.js";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const epoch = { id: id(1), instanceId: id(2), route: "chat", operation: "chat", transport: "http",
  instrumentationVersion: "fixture", barrierCertified: false, openedAt: 1 };
const preparation = {
  request: { id: id(3), route: "chat", receivedAt: 1, requestedModel: "fixture" },
  attempt: { id: id(4), epochId: epoch.id, provider: "openai", purpose: "primary" },
  eventId: id(5), occurredAt: 2, knownAt: 2,
};

async function withDatabase(open, action) {
  const directory = await mkdtemp(join(tmpdir(), "attempt-event-insert-"));
  const previousEmit = process.emit;
  let db;
  try {
    db = await open(join(directory, "fixture.sqlite"));
    db.transaction(() => initial.up(db));
    return await action(db);
  } finally {
    db?.close();
    process.emit = previousEmit;
    await rm(directory, { recursive: true, force: true });
  }
}

function exercise(db, supportsInsertReturning) {
  let clock = 10;
  const operations = [];
  const adapter = { ...db, supportsInsertReturning,
    get(sql, params) {
      if (sql.includes("inferenceAttemptEvents")) operations.push(sql.trim().split(/\s+/)[0]);
      return db.get(sql, params);
    },
  };
  const repo = createAttemptRegistryRepository(adapter, { now: () => clock });
  repo.openEpoch(epoch);
  const prepared = repo.prepare(preparation);
  const dispatch = { attemptId: id(4), eventId: id(6), expectedVersion: 1, occurredAt: 3, knownAt: 4,
    binding: { status: "unknown" } };
  const dispatched = repo.markDispatchPossible(dispatch);
  expect(repo.prepare(preparation)).toEqual(prepared);
  expect(repo.markDispatchPossible(dispatch)).toEqual(dispatched);
  expect(() => repo.markDispatchPossible({ ...dispatch, sentModel: "different" })).toThrow("identity_conflict");
  expect(() => repo.acknowledge({ attemptId: id(4), expectedVersion: 1, eventId: id(99), occurredAt: 5, knownAt: 5, source: "transport", providerAccepted: "unknown" })).toThrow("version_conflict");
  const acknowledged = repo.acknowledge({ attemptId: id(4), eventId: id(7), expectedVersion: 2, occurredAt: 5, knownAt: 5,
    source: "transport", providerAccepted: "unknown" });

  const finish = { attemptId: id(4), eventId: id(8), expectedVersion: 3, occurredAt: 7, knownAt: 7,
    state: "uncertain", outcome: "transport_error" };
  db.exec(`CREATE TRIGGER fixture_failure BEFORE INSERT ON inferenceAttemptEvents WHEN NEW.kind = 'finish'
      BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`);
  expect(() => repo.finish(finish)).toThrow("fixture persistence failure");
  expect(repo.readAsKnownAt(id(4), repo.captureReadCutoff()).attempt).toMatchObject({ version: 3, state: "response_observed" });
  db.exec("DROP TRIGGER fixture_failure");

  const terminal = repo.finish(finish);
  const beforeEvidence = repo.captureReadCutoff();
  clock = 12;
  const evidence = repo.recordUsage({ attemptId: id(4), eventId: id(9), expectedVersion: 4, occurredAt: 6, knownAt: 11,
    usage: { quality: "measured", source: "provider", completeness: "complete", inputTokens: "12", outputTokens: "5" } });
  const prior = repo.readAsKnownAt(id(4), beforeEvidence);
  const current = repo.readAsKnownAt(id(4), repo.captureReadCutoff());
  expect(current.events).toEqual([prepared, dispatched, acknowledged, terminal, evidence]);
  expect(current.events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(evidence).toMatchObject({ occurredAt: 6, knownAt: 11, recordedAt: 12 });
  expect(prior.usage.quality).toBe("unknown");
  expect(current.usage.outputTokens).toBe("5");
  return { prior, current, insertsWithReturn: operations.filter(operation => operation === "INSERT").length };
}

it.each([
  ["better-sqlite3", createBetterSqliteAdapter, true],
  ["node:sqlite", createNodeSqliteAdapter, true],
  ["sql.js", createSqlJsAdapter, false],
])("returns the persisted shape and preserves the timeline on %s", async (_label, open, nativeReturning) => {
  const optimized = await withDatabase(open, db => {
    expect(Boolean(db.supportsInsertReturning)).toBe(nativeReturning);
    return exercise(db, db.supportsInsertReturning);
  });
  const legacy = await withDatabase(open, db => exercise(db, false));
  expect(optimized.insertsWithReturn).toBe(nativeReturning ? 6 : 0);
  expect(legacy.insertsWithReturn).toBe(0);
  expect(optimized.prior).toEqual(legacy.prior);
  expect(optimized.current).toEqual(legacy.current);
});

it("uses readback if a custom trigger can change the final stored event", async () => {
  await withDatabase(createBetterSqliteAdapter, db => {
    db.exec(`CREATE TEMP TRIGGER fixture_rewrite AFTER INSERT ON main.inferenceAttemptEvents
      BEGIN UPDATE inferenceAttemptEvents SET details = '{"fixture":true}' WHERE sequence = NEW.sequence; END`);
    const repo = createAttemptRegistryRepository(db, { now: () => 10 });
    repo.openEpoch(epoch);
    const returned = repo.prepare(preparation);
    expect(returned.details).toEqual({ fixture: true });
    expect(returned).toEqual(repo.readAsKnownAt(id(4), repo.captureReadCutoff()).events[0]);
  });
});
