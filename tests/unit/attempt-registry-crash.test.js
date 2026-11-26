import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import { createAttemptRegistryRepository } from "../../src/lib/db/repos/attemptRegistryRepo.js";
import { createOpenAiDirectAttemptPilot } from "../../src/lib/quota/openAiDirectAttemptPilot.js";
import initial from "../../src/lib/db/migrations/001-initial.js";

const fixture = fileURLToPath(new URL("../fixtures/attempt-registry-crash-child.mjs", import.meta.url));
let directory, file, db, workers;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "attempt-registry-crash-"));
  file = join(directory, "fixture.sqlite");
  db = createBetterSqliteAdapter(file);
  db.transaction(() => initial.up(db));
  workers = [];
});

describe("OpenAI direct pilot coverage epochs", () => {
  const activate = (env, openDb = () => db, reportGap = vi.fn(), now = Date.now) =>
    createOpenAiDirectAttemptPilot({ env, openDb, reportGap, now });
  const execution = begin => begin()?.forModel("openai/fixture-model").execution();
  const prepare = context => context?.prepare({ connectionId: "fixture-connection", sentModel: "fixture-model" });

  it("leaves an explicit interval between epochs after a disable and a later enable are observed", () => {
    const env = {};
    const openDb = vi.fn(() => db);
    let at = 10;
    const begin = activate(env, openDb, undefined, () => at);
    expect(begin()).toBeNull();
    expect(openDb).not.toHaveBeenCalled();
    env.ATTEMPT_REGISTRY_OPENAI_DIRECT = "true";
    const previousContext = execution(begin);
    const observer = prepare(previousContext);
    observer.beforeSend(true);
    observer.observeResponse(new Response());
    at = 15;
    expect(prepare(execution(begin))).toBeDefined();
    at = 20;
    env.ATTEMPT_REGISTRY_OPENAI_DIRECT = "false";
    expect(begin()).toBeNull();
    observer.json({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    at = 30;
    env.ATTEMPT_REGISTRY_OPENAI_DIRECT = "true";
    expect(prepare(previousContext)).toBeNull();
    expect(prepare(execution(begin))).toBeDefined();
    expect(db.all("SELECT openedAt, closedAt, gapAt, barrierCertified FROM inferenceCoverageEpochs ORDER BY openedAt")).toEqual([
      { openedAt: 10, closedAt: 20, gapAt: null, barrierCertified: 0 },
      { openedAt: 30, closedAt: null, gapAt: null, barrierCertified: 0 },
    ]);
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceAttempts WHERE state = 'closed'").n).toBe(1);
  });

  it("stays indeterminate when a competing SQLite writer blocks preparation and gap persistence", () => {
    const env = { ATTEMPT_REGISTRY_OPENAI_DIRECT: "true" };
    const reportGap = vi.fn();
    const begin = activate(env, undefined, reportGap);
    const repo = createAttemptRegistryRepository(db);
    prepare(execution(begin));
    const epochId = db.get("SELECT id FROM inferenceCoverageEpochs").id;
    const other = createBetterSqliteAdapter(file);
    db.exec("PRAGMA busy_timeout = 0");
    try {
      other.exec("BEGIN IMMEDIATE");
      expect(prepare(execution(begin))).toBeUndefined();
      expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "unknown", closedAt: null });
      expect(reportGap).toHaveBeenCalledTimes(1);
      expect(reportGap.mock.calls).toEqual([[]]);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
    expect(prepare(execution(begin))).toBeDefined();
    expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "gap", gapReason: "storage_failure" });
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceCoverageEpochs WHERE closedAt IS NULL").n).toBe(1);
  });

  it("retains the observed disable time when closing an epoch temporarily fails", () => {
    const env = { ATTEMPT_REGISTRY_OPENAI_DIRECT: "true" };
    const reportGap = vi.fn();
    let at = 10;
    const begin = activate(env, undefined, reportGap, () => at);
    prepare(execution(begin));
    db.exec(`CREATE TRIGGER fixture_block_close BEFORE UPDATE ON inferenceCoverageEpochs
      BEGIN SELECT RAISE(ABORT, 'fixture-private-storage-error'); END`);
    at = 20;
    env.ATTEMPT_REGISTRY_OPENAI_DIRECT = "false";
    expect(begin()).toBeNull();
    expect(reportGap.mock.calls).toEqual([[]]);
    expect(db.get("SELECT closedAt FROM inferenceCoverageEpochs").closedAt).toBeNull();
    db.exec("DROP TRIGGER fixture_block_close");
    at = 30;
    env.ATTEMPT_REGISTRY_OPENAI_DIRECT = "true";
    expect(prepare(execution(begin))).toBeDefined();
    expect(db.all("SELECT openedAt, closedAt, gapAt FROM inferenceCoverageEpochs ORDER BY openedAt")).toEqual([
      { openedAt: 10, closedAt: 20, gapAt: null },
      { openedAt: 30, closedAt: null, gapAt: null },
    ]);
  });
});

afterEach(async () => {
  await Promise.all(workers.map(worker => stop(worker)));
  db.close();
  await rm(directory, { recursive: true, force: true });
});

async function start(stage) {
  const child = fork(fixture, [file, stage, randomUUID()], { execArgv: [], env: { DATA_DIR: directory },
    stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const worker = { child, exited: false, evidenceId: randomUUID() };
  workers.push(worker);
  worker.exit = once(child, "exit").then(([code, signal]) => {
    worker.exited = true;
    return { code, signal };
  });
  worker.identity = await Promise.race([
    once(child, "message").then(([identity]) => identity),
    worker.exit.then(() => { throw new Error("fixture exited before identifying itself"); }),
  ]);
  return worker;
}

function stop(worker) {
  if (!worker.exited) worker.child.kill("SIGKILL");
  return worker.exit;
}

function recoveryRepository() {
  // A receipt represents the exit of this concrete private child handle whose
  // execution UUID arrived over IPC. A PID or its lookup is never a proof.
  return createAttemptRegistryRepository(db, {
    verifyInactiveInstance: ({ instanceId, evidenceId, evidenceKind }) => evidenceKind === "confirmed_exit" &&
      workers.some(worker => worker.exited && worker.evidenceId === evidenceId && worker.identity?.instanceId === instanceId),
  });
}

function recover(repo, worker, override = {}) {
  const knownAt = Date.now();
  return repo.recoverOpen({ instanceId: worker.identity.instanceId, evidenceId: worker.evidenceId,
    evidenceKind: "confirmed_exit", occurredAt: knownAt, knownAt, ...override });
}

describe("OpenAI direct pilot crash recovery with an observed child exit", () => {
  it.each([
    ["prepared", "prepared", 0],
    ["barrier", "dispatch_possible", 0],
    ["submitted", "dispatch_possible", 1],
    ["acknowledged", "response_observed", 1],
    ["streaming", "in_progress", 1],
    ["buffered_usage", "in_progress", 1],
  ])("recovers %s without resend or an inference about usage", async (stage, previousState, calls) => {
    const worker = await start(stage);
    const { attemptId } = worker.identity;
    expect(worker.identity.calls).toBe(calls);
    expect(await stop(worker)).toEqual({ code: null, signal: "SIGKILL" });

    db.close();
    db = createBetterSqliteAdapter(file);
    const repo = recoveryRepository();
    const before = repo.captureReadCutoff();
    const old = repo.readAsKnownAt(attemptId, before);
    expect(old.attempt.state).toBe(previousState);
    expect(old.usage.quality).toBe("unknown");

    expect(await recover(repo, worker)).toHaveLength(1);
    expect(await recover(repo, worker)).toEqual([]);
    const after = repo.readAsKnownAt(attemptId, repo.captureReadCutoff());
    expect(after).toMatchObject({ attempt: { state: "uncertain", outcome: "process_exit" },
      usage: { quality: "unknown", explicitZero: false } });
    expect(after.events.filter(event => event.kind === "recover")).toHaveLength(1);
    expect(repo.readAsKnownAt(attemptId, before)).toEqual(old);
    expect(repo.readCoverage(after.attempt.epochId)).toMatchObject({ coverage: "gap", gapReason: "owner_exit",
      barrierCertified: false, ownerExitEvidenceId: worker.evidenceId });
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceAttempts").n).toBe(1);
    expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(0);
    expect(db.get("SELECT COUNT(*) AS n FROM usageDaily").n).toBe(0);
    const events = JSON.stringify(after.events);
    for (const value of ["fixture-private-prompt", "fixture-private-response", "fixture-private-secret", "fixture-private-response-header"]) {
      expect(events).not.toContain(value);
    }
  });

  it("isolates a live owner and accepts later measured evidence for a recovered attempt", async () => {
    const dead = await start("buffered_usage");
    const live = await start("acknowledged");
    await stop(dead);
    const repo = recoveryRepository();
    await expect(recover(repo, live)).rejects.toThrow("owner_inactivity_unconfirmed");
    await expect(recover(repo, live, { evidenceId: dead.evidenceId })).rejects.toThrow("owner_inactivity_unconfirmed");
    await expect(recover(repo, dead, { evidenceKind: "exclusive_owner_replaced" })).rejects.toThrow("owner_inactivity_unconfirmed");
    await recover(repo, dead);
    const ping = once(live.child, "message");
    live.child.send("ping");
    expect((await ping)[0]).toBe("pong");
    const before = repo.captureReadCutoff();
    expect(repo.readAsKnownAt(live.identity.attemptId, before).attempt.state).toBe("response_observed");

    const previous = repo.readAsKnownAt(dead.identity.attemptId, before);
    expect(previous.usage.quality).toBe("unknown");
    const command = { attemptId: dead.identity.attemptId, expectedVersion: previous.attempt.version,
      eventId: randomUUID(), occurredAt: previous.events.find(event => event.kind === "in_progress").occurredAt, knownAt: Date.now(),
      usage: { quality: "measured", source: "provider", completeness: "complete", inputTokens: "11", outputTokens: "7", evidenceId: randomUUID() } };
    expect(repo.recordUsage(command)).toEqual(repo.recordUsage(command));
    expect(repo.readAsKnownAt(dead.identity.attemptId, before)).toEqual(previous);
    expect(repo.readAsKnownAt(dead.identity.attemptId, repo.captureReadCutoff())).toMatchObject({
      attempt: { state: "uncertain", outcome: "process_exit" }, usage: { quality: "measured", outputTokens: "7" },
    });
  });

  it("preserves usage committed before the provider terminal could be persisted", async () => {
    const worker = await start("usage_committed");
    await stop(worker);
    const repo = recoveryRepository();
    const { attemptId } = worker.identity;
    const before = repo.readAsKnownAt(attemptId, repo.captureReadCutoff());
    expect(before.attempt.state).toBe("in_progress");
    expect(before.returnedModel).toBe("fixture-model");
    expect(before.events.slice(-2).map(event => event.kind)).toEqual(["returned_model", "usage"]);
    expect(before.usage).toMatchObject({ quality: "measured", completeness: "complete", inputTokens: "11", outputTokens: "7" });
    await recover(repo, worker);
    const after = repo.readAsKnownAt(attemptId, repo.captureReadCutoff());
    expect(after.attempt).toMatchObject({ state: "uncertain", outcome: "process_exit" });
    expect(after.usage).toEqual(before.usage);
  });
});
