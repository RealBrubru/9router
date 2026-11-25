import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import { createQuotaRepository } from "../../src/lib/db/repos/quotaRepo.js";
import { createAttemptRegistryRepository } from "../../src/lib/db/repos/attemptRegistryRepo.js";
import initial from "../../src/lib/db/migrations/001-initial.js";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = 1000;
const epochId = id(1);
const ownerId = id(2);
const requestId = id(3);
const attemptId = id(4);
const evidenceId = id(5);
const request = { id: requestId, route: "chat_completions", requestedModel: "openai/fixture-model", receivedAt: origin };
const epoch = {
  id: epochId, instanceId: ownerId, instrumentationVersion: "pilot-v1", route: request.route,
  operation: "chat", transport: "http", barrierCertified: true, openedAt: origin,
};
const measured = { quality: "measured", source: "provider", completeness: "complete", inputTokens: "19", outputTokens: "144" };
let tempDir, file, db, repo, clock, inactive;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-registry-"));
  file = path.join(tempDir, "fixture.sqlite");
  db = createBetterSqliteAdapter(file);
  db.transaction(() => initial.up(db));
  clock = origin;
  inactive = new Set();
  repo = repository(db);
  repo.openEpoch(epoch);
});

afterEach(() => {
  db?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function repository(adapter) {
  return createAttemptRegistryRepository(adapter, {
    now: () => clock,
    verifyInactiveInstance: async proof => inactive.has(proof.instanceId) && proof.evidenceId === evidenceId,
  });
}

function makePrepare(overrides = {}) {
  return {
    request,
    attempt: { id: attemptId, epochId, provider: "openai", connectionId: "fixture-connection", purpose: "primary" },
    eventId: id(11), occurredAt: origin, knownAt: origin, ...overrides,
  };
}

function update(version, n, more = {}) {
  return { attemptId, eventId: id(n), expectedVersion: version, occurredAt: clock, knownAt: clock, ...more };
}

function dispatch(more = {}) {
  return repo.markDispatchPossible(update(1, 12, { sentModel: "fixture-model-v1", binding: { status: "unknown" }, ...more }));
}

function acknowledge(more = {}) {
  return repo.acknowledge(update(2, 13, { source: "transport", providerAccepted: "unknown", httpStatus: 200, ...more }));
}

function read(target = attemptId, cutoff = repo.captureReadCutoff()) {
  return repo.readAsKnownAt(target, cutoff);
}

describe("Attempt Registry state machine", () => {
  it("persists preparation, dispatch, response and stream before closing with independent usage", () => {
    repo.prepare(makePrepare());
    expect(read()).toMatchObject({ attempt: { state: "prepared", version: 1 }, dispatch: null, usage: { quality: "unknown" } });
    clock++;
    dispatch();
    expect(read()).toMatchObject({ attempt: { state: "dispatch_possible" }, dispatch: { sentModel: "fixture-model-v1" }, acknowledgment: null });
    acknowledge();
    repo.markInProgress(update(3, 14, { mode: "stream" }));
    repo.observeReturnedModel(update(4, 15, { returnedModel: "fixture-model-build" }));
    repo.recordUsage(update(5, 16, { usage: measured }));
    repo.finish(update(6, 17, { state: "closed", outcome: "completed" }));
    expect(read()).toMatchObject({
      request: { id: requestId, requestedModel: "openai/fixture-model" },
      attempt: { id: attemptId, state: "closed", outcome: "completed", version: 7 },
      acknowledgment: { httpStatus: 200, providerAccepted: "unknown" },
      returnedModel: "fixture-model-build",
      usage: { ...measured, explicitZero: false },
    });
  });

  it("rejects invalid transitions and does not infer acceptance or zero from an HTTP error", () => {
    repo.prepare(makePrepare());
    expect(() => acknowledge({ expectedVersion: 1 })).toThrow("invalid_transition");
    expect(() => repo.recordUsage(update(1, 16, { usage: measured }))).toThrow("invalid_transition");
    dispatch();
    expect(() => repo.finish(update(2, 17, { state: "not_sent", outcome: "cancelled" }))).toThrow("invalid_transition");
    expect(() => acknowledge({ providerAccepted: "confirmed" })).toThrow("invalid_input");
    acknowledge({ httpStatus: 429 });
    repo.finish(update(3, 17, { state: "closed", outcome: "provider_error" }));
    expect(read()).toMatchObject({
      acknowledgment: { httpStatus: 429, providerAccepted: "unknown" },
      attempt: { state: "closed", outcome: "provider_error" }, usage: { quality: "unknown", explicitZero: false },
    });
  });

  it("records a separate confirmation only with explicit provider evidence", () => {
    repo.prepare(makePrepare());
    dispatch();
    acknowledge({ source: "provider", providerAccepted: "confirmed", evidenceId, httpStatus: 202 });
    expect(read().acknowledgment).toMatchObject({ source: "provider", providerAccepted: "confirmed", evidenceId });
  });

  it("distinguishes pre-dispatch cancellation from a timeout after possible dispatch", () => {
    repo.prepare(makePrepare());
    repo.finish(update(1, 12, { state: "not_sent", outcome: "cancelled" }));
    expect(read()).toMatchObject({ attempt: { state: "not_sent" }, usage: { quality: "not_applicable", explicitZero: false } });
    const retryId = id(20);
    const retry = { ...makePrepare().attempt, id: retryId, previousAttemptId: attemptId, purpose: "retry" };
    repo.prepare(makePrepare({ attempt: retry }));
    dispatch({ attemptId: retryId });
    repo.finish(update(2, 13, { attemptId: retryId, state: "uncertain", outcome: "timeout" }));
    expect(read(retryId)).toMatchObject({ attempt: { state: "uncertain", outcome: "timeout" }, usage: { quality: "unknown" } });
  });

  it("uses distinct identities for inference retries and one event for persistence retries", () => {
    const initial = makePrepare();
    expect(repo.prepare(initial)).toEqual(repo.prepare(initial));
    const command = update(1, 12, { binding: { status: "unknown" }, sentModel: "fixture-model" });
    expect(repo.markDispatchPossible(command)).toEqual(repo.markDispatchPossible(command));
    expect(() => repo.markDispatchPossible({ ...command, sentModel: "different" })).toThrow("identity_conflict");
    expect(() => repo.prepare({ ...initial, eventId: id(19) })).toThrow("identity_conflict");
    expect(() => repo.prepare({ ...initial, request: { ...request, requestedModel: "different" } })).toThrow("identity_conflict");
    expect(() => repo.prepare({ ...initial, attempt: { ...initial.attempt, id: requestId } })).toThrow("invalid_input");
    const retry = { ...initial.attempt, id: id(20), previousAttemptId: attemptId, purpose: "retry" };
    repo.prepare({ ...initial, attempt: retry });
    expect(read(retry.id).attempt).toMatchObject({ requestId, previousAttemptId: attemptId, purpose: "retry" });
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceRequests").n).toBe(1);
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceAttempts").n).toBe(2);
    expect(read().events).toHaveLength(2);
  });

  it("requires a causal predecessor to belong to the same request", () => {
    const initial = makePrepare();
    repo.prepare(initial);
    const previous = { ...initial.attempt, id: id(20), purpose: "fallback", previousAttemptId: attemptId };
    expect(() => repo.prepare({ ...initial, attempt: previous, request: { ...request, id: id(99) } })).toThrow("invalid_causality");
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceRequests").n).toBe(1);
  });

  it("allows only one finalization for two callbacks using the same version", async () => {
    repo.prepare(makePrepare());
    dispatch();
    acknowledge();
    const second = createBetterSqliteAdapter(file);
    try {
      const callback = update(3, 14, { state: "closed", outcome: "completed" });
      const results = await Promise.allSettled([
        Promise.resolve().then(() => repo.finish(callback)),
        Promise.resolve().then(() => repository(second).finish(update(3, 15, { state: "uncertain", outcome: "cancelled" }))),
      ]);
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(results[1].reason.code).toBe("version_conflict");
      expect(repository(second).finish(callback)).toEqual(results[0].value);
      expect(read().events.filter(event => event.kind === "finish")).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("does not publish uncommitted events to a separate reader and allows retry after SQLite contention", () => {
    repo.prepare(makePrepare());
    const second = createBetterSqliteAdapter(file);
    try {
      second.exec("PRAGMA busy_timeout = 0");
      const other = repository(second);
      const dispatchCommand = update(1, 12, { sentModel: "fixture-model", binding: { status: "unknown" } });
      let committed;
      db.transaction(() => {
        committed = repo.markDispatchPossible(dispatchCommand);
        expect(other.captureReadCutoff().throughSequence).toBe(committed.sequence - 1);
        expect(() => other.markDispatchPossible(dispatchCommand)).toThrow(/locked|busy/i);
      });
      expect(other.markDispatchPossible(dispatchCommand)).toEqual(committed);
      expect(other.captureReadCutoff().throughSequence).toBe(committed.sequence);
    } finally {
      second.close();
    }
  });

  it("keeps delayed usage evidence and downward revisions without rewriting the failure", () => {
    repo.prepare(makePrepare());
    dispatch();
    const atDispatch = clock;
    clock += 3;
    repo.finish(update(2, 13, { state: "uncertain", outcome: "timeout" }));
    const expired = repo.captureReadCutoff();
    repo.recordUsage(update(3, 14, { occurredAt: atDispatch, usage: {
      quality: "measured", source: "provider", completeness: "partial", inputTokens: "23",
    } }));
    expect(read()).toMatchObject({ usage: { completeness: "partial", inputTokens: "23", outputTokens: null } });
    repo.recordUsage(update(4, 15, { usage: measured }));
    repo.recordUsage(update(5, 16, { usage: { ...measured, inputTokens: "17" } }));
    expect(read()).toMatchObject({
      attempt: { state: "uncertain", outcome: "timeout" },
      usage: { inputTokens: "17", outputTokens: "144" },
    });
    expect(read(attemptId, expired).usage.quality).toBe("unknown");
    expect(() => repo.recordUsage(update(6, 17, { usage: { ...measured, quality: "estimated", source: "gateway" } }))).toThrow("usage_regression");
  });

  it("distinguishes estimated zero from explicitly measured zero", () => {
    repo.prepare(makePrepare());
    dispatch();
    const zero = { ...measured, inputTokens: "0", outputTokens: "0" };
    repo.recordUsage(update(2, 13, { usage: { ...zero, quality: "estimated", source: "gateway" } }));
    expect(read().usage).toMatchObject({ quality: "estimated", explicitZero: false });
    repo.recordUsage(update(3, 14, { usage: zero }));
    expect(read().usage).toMatchObject({ quality: "measured", explicitZero: true });
    expect(() => repo.recordUsage(update(4, 15, { usage: { ...zero, reasoningTokens: "1" } }))).toThrow("invalid_input");
  });

  it("orders lifecycle transitions separately from evidence that was learned out of occurrence order", () => {
    repo.prepare(makePrepare());
    dispatch();
    acknowledge();
    const terminalAt = clock + 1;
    clock += 2;
    repo.recordUsage(update(3, 14, { usage: measured }));
    clock++;
    repo.finish(update(4, 15, { state: "closed", outcome: "completed", occurredAt: terminalAt }));
    expect(read().events.slice(-2)).toMatchObject([
      { kind: "usage", occurredAt: terminalAt + 1 }, { kind: "finish", occurredAt: terminalAt, knownAt: clock },
    ]);
  });

  it("uses both knowledge time and the captured availability sequence at the same millisecond", () => {
    repo.prepare(makePrepare());
    const before = repo.captureReadCutoff();
    dispatch();
    const possible = repo.captureReadCutoff();
    clock++;
    acknowledge();
    const after = repo.captureReadCutoff();
    expect(before.knownAt).toBe(possible.knownAt);
    expect(read(attemptId, before).attempt.state).toBe("prepared");
    expect(read(attemptId, possible).attempt.state).toBe("dispatch_possible");
    expect(read(attemptId, { ...after, knownAt: before.knownAt }).attempt.state).toBe("dispatch_possible");
    expect(read(attemptId, { ...before, throughSequence: 0 })).toBeNull();
  });

  it("captures the binding selected at dispatch, including a later rotation", () => {
    db.exec(`INSERT INTO providerConnections(id,provider,authType,data,createdAt,updatedAt)
      VALUES ('fixture-connection','openai','apikey','{}','fixture','fixture')`);
    const quota = createQuotaRepository(db);
    quota.putOrganization({ id: "fixture-org", provider: "openai", externalId: "fixture-external", credentialRef: "ref:fixture", enabled: true });
    const binding = { organizationId: "fixture-org", connectionId: "fixture-connection", apiKeyId: "fixture-admin-id",
      projectId: "fixture-project", validFrom: origin };
    quota.bindConnection(binding);
    repo.prepare(makePrepare());
    dispatch({ binding: { status: "configured", organizationId: "fixture-org", validFrom: origin } });
    clock++;
    quota.bindConnection({ ...binding, validFrom: clock, apiKeyId: "fixture-rotated-id" });
    const retry = { ...makePrepare().attempt, id: id(20), previousAttemptId: attemptId, purpose: "retry" };
    repo.prepare(makePrepare({ attempt: retry, occurredAt: clock, knownAt: clock }));
    const proof = { status: "confirmed", organizationId: "fixture-org", validFrom: clock, credentialVersionId: id(25), evidenceId };
    expect(() => dispatch({ attemptId: retry.id, binding: { ...proof, validFrom: origin } })).toThrow("binding_unavailable");
    dispatch({ attemptId: retry.id, binding: proof });
    expect(read().dispatch.binding).toEqual({ status: "configured", organizationId: "fixture-org", validFrom: origin });
    expect(read(retry.id).dispatch.binding).toEqual(proof);
    const stored = JSON.stringify(db.all("SELECT details FROM inferenceAttemptEvents"));
    expect(stored).not.toMatch(/fixture-admin-id|fixture-rotated-id|fixture-project|ref:fixture/);
  });

  it("records only typed metadata and leaves usageHistory and usageDaily unchanged", () => {
    const initial = makePrepare();
    expect(() => repo.prepare({ ...initial, request: { ...request, prompt: "fixture-content" } })).toThrow("invalid_input");
    expect(() => repo.prepare({ ...initial, request: { ...request, requestedModel: "https://fixture.invalid/full-url" } })).toThrow("invalid_input");
    repo.prepare(initial);
    expect(() => dispatch({ binding: { status: "unknown", credential: "fixture-secret" } })).toThrow("invalid_input");
    dispatch();
    expect(() => acknowledge({ headers: { Authorization: "fixture-token" } })).toThrow("invalid_input");
    acknowledge();
    repo.recordUsage(update(3, 14, { usage: measured }));
    expect(() => repo.finish(update(4, 15, { state: "closed", outcome: "completed", error: "fixture-raw-error" }))).toThrow("invalid_input");
    repo.finish(update(4, 15, { state: "closed", outcome: "completed" }));
    db.exec(`INSERT INTO usageHistory(id, timestamp, provider, connectionId, apiKey, endpoint, tokens)
      VALUES (1, 'fixture', 'openai', 'fixture-connection', 'fixture-client-key', 'fixture-endpoint', '{}');
      INSERT INTO usageDaily(dateKey, data) VALUES ('fixture', '{"requests":7}')`);
    const history = db.get("SELECT * FROM usageHistory WHERE id = 1");
    const linked = { attemptId, usageHistoryId: 1, evidenceId };
    expect(repo.linkUsageHistory(linked)).toEqual(repo.linkUsageHistory(linked));
    expect(() => repo.linkUsageHistory({ ...linked, evidenceId: id(99) })).toThrow("usage_link_conflict");
    expect(db.get("SELECT * FROM usageHistory WHERE id = 1")).toEqual(history);
    expect(db.get("SELECT data FROM usageDaily").data).toBe('{"requests":7}');
    expect(JSON.stringify(read())).not.toMatch(/fixture-content|fixture-token|fixture-secret|fixture-raw-error|fixture-client-key|fixture-endpoint/);
    db.run("DELETE FROM usageHistory WHERE id = 1");
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceUsageLinks").n).toBe(0);
    expect(read().attempt.state).toBe("closed");
  });
});

describe("Attempt Registry recovery and coverage", () => {
  const proof = { instanceId: ownerId, evidenceId, evidenceKind: "confirmed_exit" };
  const revisit = () => repo.recoverOpen({ ...proof, occurredAt: clock, knownAt: clock });

  it("does not recover a live instance solely because the attempt is old", async () => {
    repo.prepare(makePrepare());
    dispatch();
    clock += 2000000;
    await expect(revisit()).rejects.toThrow("owner_inactivity_unconfirmed");
    expect(read()).toMatchObject({ attempt: { state: "dispatch_possible" } });
    expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "unknown", closedAt: null });
  });

  it("recovers after reopening without dispatching and distinguishes both sides of the barrier", async () => {
    const initial = makePrepare();
    repo.prepare(initial);
    const second = { ...initial.attempt, id: id(20) };
    repo.prepare({ ...initial, attempt: second });
    dispatch({ attemptId: second.id });
    const otherEpoch = { ...epoch, id: id(21), instanceId: id(22) };
    repo.openEpoch(otherEpoch);
    repo.prepare({ ...initial, attempt: { ...second, id: id(23), epochId: otherEpoch.id } });
    db.close();
    db = createBetterSqliteAdapter(file);
    repo = repository(db);

    inactive.add(ownerId);
    clock++;
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fixture network disabled"));
    try {
      expect(await revisit()).toMatchObject([
        { attemptId, kind: "recover", state: "not_sent" },
        { attemptId: second.id, kind: "recover", state: "uncertain" },
      ]);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
    expect(await revisit()).toEqual([]);
    expect(read()).toMatchObject({ attempt: { outcome: "process_exit" }, usage: { quality: "not_applicable" } });
    expect(read(second.id)).toMatchObject({ attempt: { outcome: "process_exit" }, usage: { quality: "unknown" } });
    expect(read(id(23)).attempt.state).toBe("prepared");
    expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "gap", gapAt: origin, closedAt: clock, ownerExitEvidenceId: evidenceId });
    expect(() => repo.openEpoch({ ...epoch, id: id(24), openedAt: clock })).toThrow("owner_inactive");
  });

  it("keeps a prepared attempt uncertain when the path cannot certify the barrier", async () => {
    const uncertified = { ...epoch, id: id(20), transport: "browser", barrierCertified: false };
    repo.openEpoch(uncertified);
    const initial = makePrepare();
    repo.prepare({ ...initial, attempt: { ...initial.attempt, epochId: uncertified.id } });
    expect(() => repo.finish(update(1, 13, { state: "not_sent", outcome: "cancelled" }))).toThrow("invalid_transition");
    inactive.add(ownerId);
    clock++;
    expect(await revisit()).toMatchObject([{ state: "uncertain" }]);
    expect(read().usage.quality).toBe("unknown");
  });

  it("rolls back a failed event write and never claims full coverage during storage failures", () => {
    repo.prepare(makePrepare());
    const cutoff = repo.captureReadCutoff();
    db.exec(`CREATE TRIGGER fixture_fail_event BEFORE INSERT ON inferenceAttemptEvents
      WHEN NEW.kind = 'dispatch' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;
      CREATE TRIGGER fixture_fail_gap BEFORE UPDATE ON inferenceCoverageEpochs
      BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
    expect(() => dispatch()).toThrow("fixture write failure");
    expect(read().attempt).toMatchObject({ state: "prepared", version: 1 });
    expect(repo.captureReadCutoff()).toEqual(cutoff);
    expect(() => repo.markCoverageGap({ id: epochId, occurredAt: clock, reason: "storage_failure" })).toThrow("fixture write failure");
    expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "unknown", gapAt: null });

    db.exec("DROP TRIGGER fixture_fail_gap");
    db.exec("DROP TRIGGER fixture_fail_event");
    expect(repo.markCoverageGap({ id: epochId, occurredAt: clock, reason: "storage_failure" }))
      .toMatchObject({ coverage: "gap", gapAt: clock, gapReason: "storage_failure" });
    expect(() => dispatch()).toThrow("unavailable_epoch");
    expect(repo.closeEpoch({ id: epochId, occurredAt: clock }).coverage).toBe("gap");
  });

  it("rolls back recovery of the epoch if a recovery event cannot be appended", async () => {
    repo.prepare(makePrepare());
    dispatch();
    inactive.add(ownerId);
    db.exec(`CREATE TRIGGER fixture_fail_recovery BEFORE INSERT ON inferenceAttemptEvents
      WHEN NEW.kind = 'recover' BEGIN SELECT RAISE(ABORT, 'fixture recovery failure'); END`);
    await expect(revisit()).rejects.toThrow("fixture recovery failure");
    expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "unknown", closedAt: null, ownerExitKnownAt: null });
    expect(read().attempt.state).toBe("dispatch_possible");
  });

  it("keeps even a clean epoch indeterminate and scopes open epochs by instrumentation path", () => {
    expect(() => repo.openEpoch({ ...epoch, id: id(23) })).toThrow();
    expect(repo.openEpoch({ ...epoch, id: id(24), transport: "http2" }).coverage).toBe("unknown");
    clock++;
    expect(repo.closeEpoch({ id: epochId, occurredAt: clock })).toMatchObject({ coverage: "unknown", closedAt: clock });
    expect(repo.openEpoch({ ...epoch, id: id(25), openedAt: clock }).coverage).toBe("unknown");
  });
});
