import { randomUUID } from "node:crypto";
import { fields, opaqueId, OPEN_STATES, PURPOSES, requireValue, textId, timestamp, tokenUsage, transition, usageRank } from "./attemptRegistryState.js";

const LABEL = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
const LOCAL_ID = /^[a-z0-9_-]{1,160}$/i;
const MODEL = /^[a-z0-9][a-z0-9_.:/-]{0,199}$/i;
const EVENT_FIELDS = ["attemptId", "eventId", "expectedVersion", "occurredAt", "knownAt"];
const OPEN_STATES_SQL = OPEN_STATES.map(() => "?").join(", ");
const GAP_REASONS = ["storage_failure", "uninstrumented_dispatch", "unknown"];
const INITIAL_USAGE = Object.freeze({ quality: "unknown", source: null, completeness: "unknown",
  inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, evidenceId: null, explicitZero: false });
const NOT_APPLICABLE = Object.freeze({ ...INITIAL_USAGE, quality: "not_applicable", completeness: "not_applicable" });

function modelId(value) {
  requireValue(value == null || (typeof value === "string" && !value.includes("//")));
  return textId(value, MODEL, true);
}

function sameFields(row, values) {
  return Object.keys(values).every(key => row[key] === values[key]);
}

function normalizeBinding(binding) {
  fields(binding, ["status", "organizationId", "validFrom", "credentialVersionId", "evidenceId"]);
  const { status } = binding;
  requireValue(["unknown", "configured", "confirmed"].includes(status));
  if (status === "unknown") {
    requireValue(Object.keys(binding).length === 1);
    return { status };
  }
  const organizationId = textId(binding.organizationId, LOCAL_ID);
  const validFrom = timestamp(binding.validFrom);
  if (status === "configured") {
    requireValue(binding.credentialVersionId == null && binding.evidenceId == null);
    return { status, organizationId, validFrom };
  }
  return { status, organizationId, validFrom, credentialVersionId: opaqueId(binding.credentialVersionId), evidenceId: opaqueId(binding.evidenceId) };
}

function eventTimes(input, now) {
  const occurredAt = timestamp(input.occurredAt);
  const knownAt = timestamp(input.knownAt);
  const recordedAt = timestamp(now());
  requireValue(occurredAt <= knownAt && knownAt <= recordedAt, "invalid_time_order");
  return { occurredAt, knownAt, recordedAt };
}

function decodeEvent(event) {
  return { ...event, details: JSON.parse(event.details) };
}

function publicEpoch(row) {
  if (!row) return null;
  return { ...row, barrierCertified: row.barrierCertified === 1, coverage: row.gapAt === null ? "unknown" : "gap" };
}

/** SQLite-only infrastructure. The caller provides trusted lifecycle and binding evidence. */
export function createAttemptRegistryRepository(db, { now = Date.now, verifyInactiveInstance = async () => false } = {}) {
  const transact = fn => db.transaction(fn);
  const read = fn => (db.readTransaction ?? db.transaction).call(db, fn);
  const getEpoch = id => db.get("SELECT * FROM inferenceCoverageEpochs WHERE id = ?", [id]);
  const getAttempt = id => db.get("SELECT * FROM inferenceAttempts WHERE id = ?", [id]);
  const getRequest = id => db.get("SELECT * FROM inferenceRequests WHERE id = ?", [id]);
  const getEvent = (id, eventId) => db.get("SELECT * FROM inferenceAttemptEvents WHERE attemptId = ? AND eventId = ?", [id, eventId]);

  function openEpoch(input) {
    fields(input, ["id", "instanceId", "instrumentationVersion", "route", "operation", "transport", "barrierCertified", "openedAt"]);
    requireValue(typeof input.barrierCertified === "boolean");
    requireValue(!input.barrierCertified || db.driver !== "sql.js", "barrier_durability_unavailable");
    const identity = {
      id: opaqueId(input.id),
      instanceId: opaqueId(input.instanceId),
      instrumentationVersion: textId(input.instrumentationVersion, LABEL),
      route: textId(input.route, LABEL),
      operation: textId(input.operation, LABEL),
      transport: textId(input.transport, LABEL),
      barrierCertified: Number(input.barrierCertified),
      openedAt: timestamp(input.openedAt),
    };
    requireValue(identity.openedAt <= timestamp(now()), "invalid_time_order");
    return transact(() => {
      const existing = getEpoch(identity.id);
      if (existing) {
        requireValue(sameFields(existing, identity), "identity_conflict");
        return publicEpoch(existing);
      }
      requireValue(!db.get(`SELECT 1 FROM inferenceCoverageEpochs
        WHERE instanceId = ? AND ownerExitKnownAt IS NOT NULL LIMIT 1`, [identity.instanceId]), "owner_inactive");
      db.run(`INSERT INTO inferenceCoverageEpochs(id, instanceId, instrumentationVersion, route, operation, transport, barrierCertified, openedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, Object.values(identity));
      return publicEpoch(getEpoch(identity.id));
    });
  }

  function updateEpoch(id, at, reason) {
    const epoch = getEpoch(id);
    requireValue(epoch, "unknown_epoch");
    requireValue(at >= epoch.openedAt && at <= timestamp(now()), "invalid_time_order");
    if (reason === null) {
      if (epoch.closedAt !== null) requireValue(epoch.closedAt === at, "epoch_closed");
      else db.run("UPDATE inferenceCoverageEpochs SET closedAt = ? WHERE id = ?", [at, id]);
    } else {
      requireValue(epoch.closedAt === null || at <= epoch.closedAt, "invalid_time_order");
      if (epoch.gapAt === null || at < epoch.gapAt) {
        db.run("UPDATE inferenceCoverageEpochs SET closedAt = COALESCE(closedAt, ?), gapAt = ?, gapReason = ? WHERE id = ?",
          [at, at, reason, id]);
      }
    }
    return publicEpoch(getEpoch(id));
  }

  function closeEpoch({ id, occurredAt }) {
    return transact(() => updateEpoch(opaqueId(id), timestamp(occurredAt), null));
  }

  function markCoverageGap({ id, occurredAt, reason }) {
    requireValue(GAP_REASONS.includes(reason));
    return transact(() => updateEpoch(opaqueId(id), timestamp(occurredAt), reason));
  }

  function readCoverage(id) {
    return publicEpoch(getEpoch(opaqueId(id)));
  }

  function insertEvent(attemptId, eventId, version, kind, state, outcome, times, details) {
    db.run(`INSERT INTO inferenceAttemptEvents(attemptId, eventId, version, kind, state, outcome, occurredAt, knownAt, recordedAt, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [attemptId, eventId, version, kind, state, outcome, times.occurredAt, times.knownAt, times.recordedAt, JSON.stringify(details)]);
    return decodeEvent(getEvent(attemptId, eventId));
  }

  function prepare(input) {
    fields(input, ["request", "attempt", "eventId", "occurredAt", "knownAt"]);
    fields(input.request, ["id", "route", "requestedModel", "receivedAt"]);
    fields(input.attempt, ["id", "epochId", "previousAttemptId", "provider", "connectionId", "purpose"]);
    const request = {
      id: opaqueId(input.request.id),
      route: textId(input.request.route, LABEL),
      requestedModel: modelId(input.request.requestedModel),
      receivedAt: timestamp(input.request.receivedAt),
    };
    const attempt = {
      id: opaqueId(input.attempt.id),
      requestId: request.id,
      epochId: opaqueId(input.attempt.epochId),
      previousAttemptId: input.attempt.previousAttemptId == null ? null : opaqueId(input.attempt.previousAttemptId),
      provider: textId(input.attempt.provider, LABEL),
      connectionId: textId(input.attempt.connectionId, LOCAL_ID, true),
      purpose: input.attempt.purpose,
    };
    const eventId = opaqueId(input.eventId);
    requireValue(attempt.id !== request.id && attempt.id !== attempt.previousAttemptId && PURPOSES.includes(attempt.purpose));
    requireValue(!["retry", "fallback", "continuation"].includes(attempt.purpose) || attempt.previousAttemptId);
    const times = eventTimes(input, now);
    requireValue(request.receivedAt <= times.occurredAt, "invalid_time_order");

    return transact(() => {
      const existingRequest = getRequest(request.id);
      requireValue(!existingRequest || sameFields(existingRequest, request), "identity_conflict");
      const existing = getAttempt(attempt.id);
      if (existing) {
        const original = getEvent(attempt.id, eventId);
        requireValue(original?.kind === "prepare" && sameFields(existing, attempt) &&
          original.occurredAt === times.occurredAt && original.knownAt === times.knownAt, "identity_conflict");
        return decodeEvent(original);
      }
      const epoch = getEpoch(attempt.epochId);
      requireValue(epoch && epoch.closedAt === null && epoch.route === request.route, "unavailable_epoch");
      requireValue(epoch.openedAt <= times.occurredAt, "invalid_time_order");
      if (attempt.previousAttemptId) {
        const previous = getAttempt(attempt.previousAttemptId);
        requireValue(previous?.requestId === request.id, "invalid_causality");
      }

      if (!existingRequest) db.run("INSERT INTO inferenceRequests(id, route, requestedModel, receivedAt) VALUES (?, ?, ?, ?)", Object.values(request));
      db.run(`INSERT INTO inferenceAttempts(id, requestId, epochId, previousAttemptId, provider, connectionId, purpose, state, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', 1)`, Object.values(attempt));
      return insertEvent(attempt.id, eventId, 1, "prepare", "prepared", null, times, {});
    });
  }

  function validateDispatchBinding(attempt, binding, at) {
    if (binding.status === "unknown") return;
    const match = db.get(`SELECT 1 FROM quotaConnectionBindings
      WHERE connectionId = ? AND organizationId = ? AND validFrom = ? AND validFrom <= ?
        AND (validTo IS NULL OR validTo > ?)`,
    [attempt.connectionId, binding.organizationId, binding.validFrom, at, at]);
    requireValue(match, "binding_unavailable");
  }

  function latestUsage(attemptId) {
    const row = db.get(`SELECT details FROM inferenceAttemptEvents WHERE attemptId = ? AND kind = 'usage'
      ORDER BY version DESC LIMIT 1`, [attemptId]);
    return row ? JSON.parse(row.details) : INITIAL_USAGE;
  }

  function apply(input, kind, details) {
    const { attemptId, eventId, expectedVersion } = input;
    const times = eventTimes(input, now);
    const already = getEvent(attemptId, eventId);
    if (already) {
      requireValue(already.kind === kind && already.occurredAt === times.occurredAt &&
        already.knownAt === times.knownAt && already.details === JSON.stringify(details), "identity_conflict");
      return decodeEvent(already);
    }

    const attempt = getAttempt(attemptId);
    requireValue(attempt, "unknown_attempt");
    requireValue(attempt.version === expectedVersion, "version_conflict");
    const previous = db.get("SELECT knownAt FROM inferenceAttemptEvents WHERE attemptId = ? AND version = ?",
      [attemptId, expectedVersion]);
    const isEvidence = kind === "usage" || kind === "returned_model";
    requireValue(times.knownAt >= previous.knownAt, "invalid_time_order");
    if (!isEvidence) {
      const lifecycle = db.get(`SELECT occurredAt FROM inferenceAttemptEvents WHERE attemptId = ?
        AND kind NOT IN ('usage', 'returned_model') ORDER BY version DESC LIMIT 1`, [attemptId]);
      requireValue(times.occurredAt >= lifecycle.occurredAt, "invalid_time_order");
    }
    const epoch = getEpoch(attempt.epochId);
    const state = transition(attempt.state, kind, details, epoch.barrierCertified === 1);
    if (kind === "dispatch") {
      requireValue(epoch.closedAt === null, "unavailable_epoch");
      validateDispatchBinding(attempt, details.binding, times.occurredAt);
    }
    if (isEvidence) requireValue(attempt.dispatchAt !== null && times.occurredAt >= attempt.dispatchAt, "invalid_time_order");
    if (kind === "usage") requireValue(usageRank(details) >= usageRank(latestUsage(attemptId)), "usage_regression");
    const outcome = kind === "finish" ? details.outcome : kind === "recover" ? "process_exit" : attempt.outcome;
    const organizationId = kind === "dispatch" ? details.binding.organizationId ?? null : attempt.organizationId;
    const dispatchAt = kind === "dispatch" ? times.occurredAt : attempt.dispatchAt;
    const updated = db.run(`UPDATE inferenceAttempts SET state = ?, outcome = ?, organizationId = ?, dispatchAt = ?, version = version + 1
      WHERE id = ? AND version = ?`, [state, outcome, organizationId, dispatchAt, attemptId, expectedVersion]);
    requireValue(Number(updated.changes) === 1, "version_conflict");
    return insertEvent(attemptId, eventId, expectedVersion + 1, kind, state, outcome, times, details);
  }

  function change(input, kind, details) {
    opaqueId(input.attemptId);
    opaqueId(input.eventId);
    requireValue(timestamp(input.expectedVersion) >= 1);
    return transact(() => apply(input, kind, details));
  }

  function markDispatchPossible(input) {
    fields(input, [...EVENT_FIELDS, "sentModel", "binding"]);
    return change(input, "dispatch", { sentModel: modelId(input.sentModel), binding: normalizeBinding(input.binding) });
  }

  function acknowledge(input) {
    fields(input, [...EVENT_FIELDS, "source", "providerAccepted", "httpStatus", "returnedModel", "evidenceId"]);
    const { source, providerAccepted } = input;
    requireValue(["transport", "provider"].includes(source) && ["unknown", "confirmed"].includes(providerAccepted));
    const evidenceId = input.evidenceId == null ? null : opaqueId(input.evidenceId);
    requireValue(providerAccepted !== "confirmed" || (source === "provider" && evidenceId));
    const httpStatus = input.httpStatus ?? null;
    requireValue(httpStatus === null || (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599));
    return change(input, "acknowledge", { source, providerAccepted, httpStatus, returnedModel: modelId(input.returnedModel), evidenceId });
  }

  function markInProgress(input) {
    fields(input, [...EVENT_FIELDS, "mode"]);
    requireValue(["stream", "job"].includes(input.mode));
    return change(input, "in_progress", { mode: input.mode });
  }

  function recordUsage(input) {
    fields(input, [...EVENT_FIELDS, "usage"]);
    return change(input, "usage", tokenUsage(input.usage));
  }

  function observeReturnedModel(input) {
    fields(input, [...EVENT_FIELDS, "returnedModel"]);
    const returnedModel = modelId(input.returnedModel);
    requireValue(returnedModel !== null);
    return change(input, "returned_model", { returnedModel });
  }

  function finish(input) {
    fields(input, [...EVENT_FIELDS, "state", "outcome"]);
    return change(input, "finish", { state: input.state, outcome: input.outcome });
  }

  async function recoverOpen(input) {
    fields(input, ["instanceId", "evidenceId", "evidenceKind", "occurredAt", "knownAt"]);
    const instanceId = opaqueId(input.instanceId);
    const evidenceId = opaqueId(input.evidenceId);
    const { evidenceKind } = input;
    requireValue(["confirmed_exit", "exclusive_owner_replaced"].includes(evidenceKind));
    requireValue(await verifyInactiveInstance({ instanceId, evidenceId, evidenceKind }) === true, "owner_inactivity_unconfirmed");
    const times = eventTimes(input, now);
    return transact(() => {
      const epochs = db.all("SELECT * FROM inferenceCoverageEpochs WHERE instanceId = ? AND closedAt IS NULL", [instanceId]);
      for (const epoch of epochs) {
        requireValue(times.occurredAt >= epoch.openedAt, "invalid_time_order");
        db.run("UPDATE inferenceCoverageEpochs SET closedAt = ?, gapAt = openedAt, gapReason = 'owner_exit' WHERE id = ?",
          [times.occurredAt, epoch.id]);
      }
      db.run(`UPDATE inferenceCoverageEpochs SET ownerExitKnownAt = ?, ownerExitEvidenceId = ?
        WHERE instanceId = ? AND ownerExitKnownAt IS NULL`, [times.knownAt, evidenceId, instanceId]);
      const attempts = db.all(`SELECT a.id, a.version FROM inferenceAttempts AS a
        JOIN inferenceCoverageEpochs AS e ON e.id = a.epochId
        WHERE e.instanceId = ? AND a.state IN (${OPEN_STATES_SQL}) ORDER BY a.id`, [instanceId, ...OPEN_STATES]);
      return attempts.map(attempt => apply({
        ...times, attemptId: attempt.id, expectedVersion: attempt.version, eventId: randomUUID(),
      }, "recover", { evidenceKind, evidenceId }));
    });
  }

  function captureReadCutoff() {
    const throughSequence = read(() => db.get("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM inferenceAttemptEvents").sequence);
    return { throughSequence: timestamp(throughSequence), knownAt: timestamp(now()) };
  }

  function readAsKnownAt(attemptId, cutoff) {
    opaqueId(attemptId);
    fields(cutoff, ["knownAt", "throughSequence"]);
    const { knownAt, throughSequence } = cutoff;
    requireValue(timestamp(knownAt) <= timestamp(now()));
    timestamp(throughSequence);
    return read(() => {
      const events = db.all(`SELECT * FROM inferenceAttemptEvents WHERE attemptId = ? AND knownAt <= ? AND sequence <= ?
        ORDER BY version`, [attemptId, knownAt, throughSequence]).map(decodeEvent);
      if (events.length === 0) return null;
      const { state, outcome, version } = events.at(-1);
      const { requestId, epochId, previousAttemptId, provider, connectionId, purpose } = getAttempt(attemptId);
      const acknowledgment = events.find(event => event.kind === "acknowledge")?.details ?? null;
      return {
        attempt: { id: attemptId, requestId, epochId, previousAttemptId, provider, connectionId, purpose, state, outcome, version },
        request: getRequest(requestId),
        dispatch: events.find(event => event.kind === "dispatch")?.details ?? null,
        acknowledgment,
        returnedModel: events.findLast(event => event.kind === "returned_model")?.details.returnedModel ?? acknowledgment?.returnedModel ?? null,
        usage: state === "not_sent" ? NOT_APPLICABLE : events.findLast(event => event.kind === "usage")?.details ?? INITIAL_USAGE,
        events,
      };
    });
  }

  function linkUsageHistory(input) {
    fields(input, ["attemptId", "usageHistoryId", "evidenceId"]);
    const attemptId = opaqueId(input.attemptId);
    const evidenceId = opaqueId(input.evidenceId);
    const usageHistoryId = timestamp(input.usageHistoryId);
    requireValue(usageHistoryId > 0);
    return transact(() => {
      const attempt = getAttempt(attemptId);
      const usage = db.get("SELECT provider, connectionId FROM usageHistory WHERE id = ?", [usageHistoryId]);
      requireValue(attempt?.state === "closed" && usageRank(latestUsage(attemptId)) > 0 &&
        usage?.provider === attempt.provider && usage.connectionId === attempt.connectionId, "usage_link_unavailable");
      const existing = db.get("SELECT * FROM inferenceUsageLinks WHERE attemptId = ? OR usageHistoryId = ?", [attemptId, usageHistoryId]);
      const link = { attemptId, usageHistoryId, evidenceId };
      requireValue(!existing || sameFields(existing, link), "usage_link_conflict");
      if (!existing) db.run("INSERT INTO inferenceUsageLinks(attemptId, usageHistoryId, evidenceId) VALUES (?, ?, ?)", Object.values(link));
      return link;
    });
  }

  return {
    openEpoch, closeEpoch, markCoverageGap, readCoverage,
    prepare, markDispatchPossible, acknowledge, markInProgress, observeReturnedModel, recordUsage, finish, recoverOpen,
    captureReadCutoff, readAsKnownAt, linkUsageHistory,
  };
}
