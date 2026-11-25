import { createHash } from "node:crypto";
import { createQuotaRepository } from "../db/repos/quotaRepo.js";
import { normalizeQuotaQuery, quotaBucketWidth } from "./query.js";
import { reconcileQuota } from "./reconciliation.js";

const DAY_MS = 86_400_000;
const MAX_HISTORY_ROWS = 10_000;
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) && !/^sk-/i.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const iso = value => new Date(value).toISOString();
const digest = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const bucketMs = ({ start, end }) => ({ start: start * 1000, end: end * 1000 });

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) &&
    !/(?:^|:)sk-/i.test(value) ? value : null;
}

function scopedReference(organizationId, kind, value) {
  const safe = identifier(value);
  return safe ? digest(organizationId, kind, safe) : null;
}

function decimalFraction(n) {
  // The configuration stores a JS number and can use exponent notation when read.
  const [mantissa, exponent] = String(n).split("e-");
  if (!exponent) return mantissa;
  const digits = mantissa.replace(".", "");
  return `0.${"0".repeat(Number(exponent) - 1)}${digits}`;
}

function makePolicy(organization, group, window, query, readAt) {
  const { groups, usageStaleAfterMs, usageIntervalMs, safetyMargin } = organization.config;
  const models = group.models.map(identifier).filter(Boolean).sort();
  const excludedModels = groups.filter(item => item.id !== group.id)
    .flatMap(item => item.models.map(identifier).filter(Boolean)).sort();
  const margin = decimalFraction(safetyMargin);
  if ((margin.split(".")[1]?.length ?? 0) > 18) return null;
  return {
    scope: {
      organizationId: organization.id,
      groupId: group.id,
      policyRevision: digest("current-quota-config", group.limit, margin, models, excludedModels, usageStaleAfterMs, usageIntervalMs),
      unit: "tokens",
    },
    window,
    knownAt: readAt,
    // An analysis window for the current configuration. The DB has no policy validity journal.
    validFrom: window.start,
    validTo: window.end,
    limit: String(group.limit),
    safetyMargin: margin,
    scale: 0,
    maxReportingLagMs: 0,
    maxCollectionAgeMs: usageStaleAfterMs,
    maxObservationTailMs: usageIntervalMs,
    models,
    excludedModels,
    usageScope: query.scope,
    resolution: query.resolution,
  };
}

function normalizeRemoteRows(rows, organizationId) {
  if (!Array.isArray(rows)) return { issue: "invalid_remote_counters" };
  const dimensions = new Set();
  const normalized = [];
  for (const row of rows) {
    if (!row || !validCount(row.input_tokens) || !validCount(row.output_tokens) || !validCount(row.num_model_requests)) {
      return { issue: "invalid_remote_counters" };
    }
    const model = identifier(row.model);
    const serviceTier = identifier(row.service_tier);
    const projectId = scopedReference(organizationId, "project", row.project_id);
    const apiKeyId = scopedReference(organizationId, "inference-key", row.api_key_id);
    const key = JSON.stringify([model, serviceTier, projectId, apiKeyId]);
    if (dimensions.has(key)) return { issue: "duplicate_remote_dimensions" };
    dimensions.add(key);
    normalized.push({
      id: digest("usage-dimension", key), model, serviceTier, projectId, apiKeyId,
      incentive: serviceTier === "incentivized-tier" && row.incentive === "incentivized" ? "incentivized" : "unknown",
      origin: "unknown",
      amount: String(BigInt(row.input_tokens) + BigInt(row.output_tokens)),
      inputTokens: String(row.input_tokens),
      outputTokens: String(row.output_tokens),
      cachedInputTokens: validCount(row.input_cached_tokens) ? String(row.input_cached_tokens) : null,
      requests: String(row.num_model_requests),
    });
  }
  return { rows: normalized };
}

function readRemote(snapshot, policy, evaluatedAt, readAt) {
  const observations = [];
  const buckets = [];
  const width = quotaBucketWidth("usage", policy.resolution);
  if (snapshot.lastSuccess?.collectedAt > readAt) {
    return { observations, buckets, issue: "collector_state_after_read_cutoff" };
  }
  const attempt = snapshot.lastAttempt;
  const failedInWindow = attempt && attempt.outcome !== "success" && validTime(attempt.finishedAt) &&
    attempt.finishedAt <= readAt && attempt.window.start * 1000 < evaluatedAt && attempt.window.end * 1000 > policy.window.start;
  for (const bucket of snapshot.observations) {
    const collection = bucket.omitted ? snapshot.lastSuccess : {
      collectionId: bucket.observationId, collectedAt: bucket.collectedAt,
      window: bucket.observedWindow, dataAsOf: bucket.dataAsOf,
    };
    if (collection.collectedAt > readAt) continue;
    const bucketWindow = bucketMs({ start: bucket.start, end: bucket.start + width });
    const providerBucketWindow = bucketMs(bucket);
    const queryWindow = bucketMs(collection.window);
    const observedWindow = {
      start: Math.max(bucketWindow.start, queryWindow.start),
      end: Math.min(bucket.omitted ? bucketWindow.end : providerBucketWindow.end, queryWindow.end),
    };
    const id = digest(policy.scope.organizationId, "usage-bucket", policy.usageScope, bucket.start);
    const normalized = bucket.omitted ? { rows: [] } : normalizeRemoteRows(bucket.rows, policy.scope.organizationId);
    const invalidWatermark = collection.dataAsOf != null &&
      (!validTime(collection.dataAsOf) || collection.dataAsOf > collection.collectedAt);
    const issue = bucket.start % width !== 0 || observedWindow.start >= observedWindow.end ||
      !validTime(observedWindow.start) || !validTime(observedWindow.end) || observedWindow.end > collection.collectedAt
      ? "invalid_remote_window" : invalidWatermark ? "invalid_remote_watermark" : normalized.issue;
    const observation = {
      id,
      // SQLite holds one materialized revision per bucket. This ordinal is local to the evaluation.
      revision: 0,
      source: "usage",
      scope: policy.scope,
      usageScope: policy.usageScope,
      resolution: policy.resolution,
      populationCoverage: "complete",
      bucketWindow,
      observedWindow,
      collectedAt: collection.collectedAt,
      knownAt: readAt,
      dataAsOf: collection.dataAsOf ?? null,
      status: bucket.omitted ? "omitted"
        : failedInWindow || readAt - collection.collectedAt >= policy.maxCollectionAgeMs ? "stale" : "observed",
      rows: normalized.rows ?? [],
    };
    if (!issue) observations.push(observation);
    buckets.push({
      ...observation,
      status: issue ? "unusable" : observation.status,
      rows: issue ? [] : observation.rows,
      revisionRef: collection.collectionId,
      providerBucketWindow,
      queryWindow,
      ...(issue ? { issue } : {}),
    });
  }
  return { observations, buckets, issue: null };
}

function historicTokens(serialized) {
  let tokens;
  try {
    tokens = JSON.parse(serialized);
  } catch {
    return { state: "unknown", amount: null };
  }
  const input = tokens?.prompt_tokens ?? tokens?.input_tokens;
  const output = tokens?.completion_tokens ?? tokens?.output_tokens;
  if (!validCount(input) || !validCount(output) || (tokens.estimated != null && typeof tokens.estimated !== "boolean")) {
    return { state: "unknown", amount: null };
  }
  return {
    state: tokens.estimated === true ? "estimated" : "observed",
    amount: String(BigInt(input) + BigInt(output)),
  };
}

function readLocalHistory(db, policy, provider, evaluatedAt, readAt) {
  const organizationId = policy.scope.organizationId;
  const end = Math.min(evaluatedAt, policy.window.end);
  const bindings = db.all(`SELECT current.connectionId, current.apiKeyId, current.projectId, current.validFrom, current.validTo
    FROM quotaConnectionBindings AS current
    WHERE current.organizationId = ? AND current.validFrom < ? AND (current.validTo IS NULL OR current.validTo > ?)
      AND NOT EXISTS (SELECT 1 FROM quotaConnectionBindings AS other
        WHERE other.connectionId = current.connectionId AND other.organizationId <> ?)
    ORDER BY current.connectionId, current.validFrom`, [organizationId, end, policy.window.start, organizationId]);
  const byConnection = new Map();
  for (const binding of bindings) {
    const matches = byConnection.get(binding.connectionId) ?? [];
    matches.push(binding);
    byConnection.set(binding.connectionId, matches);
  }

  const candidates = byConnection.size === 0 ? [] : db.all(`SELECT CAST(h.id AS TEXT) AS id, h.timestamp, h.model, h.connectionId, h.tokens
    FROM usageHistory AS h
    WHERE h.provider = ? AND h.timestamp >= ? AND h.timestamp < ?
      AND EXISTS (SELECT 1 FROM quotaConnectionBindings AS binding
        WHERE binding.organizationId = ? AND binding.connectionId = h.connectionId)
      AND NOT EXISTS (SELECT 1 FROM quotaConnectionBindings AS other
        WHERE other.connectionId = h.connectionId AND other.organizationId <> ?)
    ORDER BY h.timestamp, h.id LIMIT ?`, [provider, iso(policy.window.start), iso(end), organizationId, organizationId, MAX_HISTORY_ROWS + 1]);
  const totals = { observed: null, estimated: null };
  const events = [];
  for (const item of candidates.slice(0, MAX_HISTORY_ROWS)) {
    const timestamp = Date.parse(item.timestamp);
    if (!validTime(timestamp) || timestamp < policy.window.start || timestamp >= end) continue;
    const matches = (byConnection.get(item.connectionId) ?? []).filter(binding =>
      binding.validFrom <= timestamp && (binding.validTo === null || timestamp < binding.validTo));
    if (matches.length !== 1) continue;
    const [binding] = matches;
    const tokens = historicTokens(item.tokens);
    const model = identifier(item.model);
    const group = policy.models.includes(model) ? "configured" : policy.excludedModels.includes(model) ? "other_group" : "unknown";
    if (tokens.amount !== null && group !== "other_group") {
      totals[tokens.state] = (totals[tokens.state] ?? 0n) + BigInt(tokens.amount);
    }
    events.push({
      id: scopedReference(organizationId, "usageHistory-row", String(item.id)),
      source: "usageHistory",
      identity: "history_row",
      timestamp,
      knownAt: readAt,
      model,
      group,
      incentive: "unknown",
      unit: policy.scope.unit,
      ...tokens,
      bindingAtRecordedTime: {
        apiKeyId: scopedReference(organizationId, "inference-key", binding.apiKeyId),
        projectId: scopedReference(organizationId, "project", binding.projectId),
        validFrom: binding.validFrom,
        validTo: binding.validTo,
      },
    });
  }
  return {
    coverage: { status: events.length ? "partial" : "unknown", knownAt: readAt },
    reasons: ["no_attempt_lifecycle", "no_dispatch_binding", "unattributed_history_possible"],
    truncated: candidates.length > MAX_HISTORY_ROWS,
    events,
    totals: {
      observed: totals.observed?.toString() ?? null,
      estimated: totals.estimated?.toString() ?? null,
      unknownEvents: events.filter(event => event.state === "unknown" && event.group !== "other_group").length,
    },
  };
}

/** Internal read-only view. The caller owns access control before exposing it. */
export function createQuotaReconciliationReadService(db, { now = Date.now } = {}) {
  const repository = createQuotaRepository(db, { now });

  function read({ organizationId, groupId, resolution = "1d", evaluatedAt, knowledgeAt }) {
    if (!validId(organizationId) || !validId(groupId) || !["1d", "1m"].includes(resolution)) {
      throw new TypeError("Invalid reconciliation read scope");
    }
    return db.transaction(() => {
      // Establish the SQLite read snapshot before assigning a visibility time to its facts.
      const organization = repository.getOrganization(organizationId);
      const readAt = now();
      const target = evaluatedAt ?? readAt;
      const cutoff = knowledgeAt ?? readAt;
      if (!validTime(readAt) || !validTime(target) || !validTime(cutoff) || target > cutoff || cutoff > readAt) {
        throw new TypeError("Invalid reconciliation read clocks");
      }
      const evaluation = { evaluatedAt: target, knowledgeAt: cutoff, readAt };
      const unavailable = reason => ({ status: "unavailable", reason, evaluation, result: null });
      if (cutoff !== readAt || Math.floor(target / DAY_MS) !== Math.floor(readAt / DAY_MS)) {
        return unavailable("historical_state_unavailable");
      }
      const group = organization?.config.groups.find(item => item.id === groupId);
      if (!group) return unavailable("unknown_scope");
      if (organization.provider !== "openai" || group.unit !== "tokens" ||
          organization.config.renewalTime !== "00:00" || organization.config.timeZone !== "UTC") {
        return unavailable("unsupported_quota_scope");
      }
      const start = Math.floor(target / DAY_MS) * DAY_MS;
      const window = { start, end: start + DAY_MS };
      const query = normalizeQuotaQuery({ source: "usage", start: start / 1000, end: window.end / 1000, resolution });
      const policy = makePolicy(organization, group, window, query, readAt);
      if (!policy) return unavailable("unsupported_policy_precision");
      const snapshot = repository.readSnapshot(organizationId, query, { history: true });
      const remote = readRemote(snapshot, policy, target, readAt);
      const localHistory = readLocalHistory(db, policy, organization.provider, target, readAt);
      const result = reconcileQuota({
        policy, evaluatedAt: target, knowledgeAt: cutoff, localCoverage: localHistory.coverage, observations: remote.observations,
        // A historical row cannot identify a dispatched attempt or certify a deduction.
        attempts: [], evidence: [],
      });
      const { consideredSubtotal: _remoteOnlySubtotal, ...indicative } = result.indicative;
      return {
        status: "available",
        evaluation,
        policyBasis: "current_config_only",
        resolution,
        provenance: {
          remote: {
            provider: organization.provider, source: query.source, groupBy: query.groupBy,
            collectionStatus: result.quality.collection.status,
            issue: remote.issue, buckets: remote.buckets,
          },
          local: localHistory,
        },
        result: {
          scope: result.scope,
          window: result.window,
          evaluation: result.evaluation,
          quality: {
            ...result.quality,
            external: { ...result.quality.external, attribution: "unknown", reported: null },
          },
          remote: result.remote && { ...result.remote, gateway: null, external: null },
          indicative,
        },
      };
    });
  }
  return { read };
}
