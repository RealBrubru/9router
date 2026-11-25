import { randomUUID } from "node:crypto";
import { normalizeQuotaQuery, quotaBucketWidth } from "../../quota/query.js";
import { QuotaCollectionError } from "../../quota/errors.js";

// One collector process per data directory. Prevent overlapping reads across window
// or grouping changes even when different callers construct their own repository.
const inFlight = new Set();
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const looksLikeOpenAISecret = value => /(?:^|:)sk-/i.test(value);
const isIdentifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) &&
  !looksLikeOpenAISecret(value);

function normalizeConfig({
  groups = [], renewalTime = "00:00", timeZone = "UTC", usageIntervalMs = 60_000,
  costsIntervalMs = 3_600_000, usageStaleAfterMs = 300_000, costsStaleAfterMs = 7_200_000,
  safetyMargin = 0.10,
} = {}) {
  if (typeof timeZone !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(renewalTime) ||
      ![usageIntervalMs, costsIntervalMs, usageStaleAfterMs, costsStaleAfterMs].every(value => isTime(value) && value > 0) ||
      !Number.isFinite(safetyMargin) || safetyMargin < 0 || safetyMargin >= 1 || !Array.isArray(groups)) {
    throw new TypeError("Invalid quota organization config");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new TypeError("Invalid quota renewal timezone");
  }

  const groupIds = new Set();
  const seenModels = new Set();
  const classifiedGroups = groups.map(group => {
    const { id, limit, models, unit = "tokens" } = group || {};
    if (!isIdentifier(id) || groupIds.has(id) || !Number.isFinite(limit) || limit < 0 ||
        (unit === "tokens" && !Number.isSafeInteger(limit)) || !isIdentifier(unit) ||
        !Array.isArray(models) || models.some(model => typeof model !== "string" || !model.trim() ||
          looksLikeOpenAISecret(model.trim()))) {
      throw new TypeError("Invalid quota group");
    }
    groupIds.add(id);
    const uniqueModels = [...new Set(models)];
    for (const model of uniqueModels) {
      if (seenModels.has(model)) throw new TypeError("Quota model belongs to multiple groups");
      seenModels.add(model);
    }
    return { id, limit, unit, models: uniqueModels };
  });

  return {
    groups: classifiedGroups, renewalTime, timeZone, usageIntervalMs, costsIntervalMs,
    usageStaleAfterMs, costsStaleAfterMs, safetyMargin,
  };
}

function assertObservation(observation, query) {
  const returned = observation?.query;
  if (returned?.source !== query.source || returned.scope !== query.scope ||
      returned.start !== query.start || returned.end !== query.end || !Array.isArray(observation.buckets) ||
      !isTime(observation.startedAt) || !isTime(observation.collectedAt) ||
      observation.collectedAt < observation.startedAt ||
      (observation.dataAsOf != null && !isTime(observation.dataAsOf))) {
    throw new QuotaCollectionError("invalid_observation");
  }

  let previousEnd = 0;
  for (const bucket of observation.buckets) {
    if (!bucket || !isTime(bucket.start) || !isTime(bucket.end) || bucket.start < previousEnd ||
        bucket.end <= bucket.start || bucket.end <= query.start || bucket.start >= query.end ||
        bucket.end - bucket.start > quotaBucketWidth(query.source, query.resolution) ||
        !Array.isArray(bucket.rows)) throw new QuotaCollectionError("invalid_observation");
    previousEnd = bucket.end;
  }
}

// Coverage reports bucket intervals seen in the response, not the provider's
// completeness watermark. An explicit empty bucket still contributes coverage.
function gapsInWindow(window, snapshot) {
  const gaps = [];
  let cursor = window.start;
  if (snapshot) {
    for (const bucket of snapshot.buckets) {
      const start = Math.max(bucket.start, snapshot.window.start, window.start);
      const end = Math.min(bucket.end, snapshot.window.end, window.end);
      if (end <= start) continue;
      if (start > cursor) gaps.push({ start: cursor, end: start });
      cursor = Math.max(cursor, end);
    }
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

function decodeBucket(bucket) {
  const { rows, window, dataAsOf } = JSON.parse(bucket.data);
  return {
    start: bucket.bucketStart, end: bucket.bucketEnd, rows,
    collectedAt: bucket.collectedAt, observedWindow: window, dataAsOf,
  };
}

export function createQuotaRepository(db, { now = Date.now } = {}) {
  function getOrganization(id) {
    const row = db.get("SELECT * FROM quotaOrganizations WHERE id = ?", [id]);
    return row ? { ...row, enabled: row.enabled === 1, config: JSON.parse(row.config) } : null;
  }

  function putOrganization({ id, provider, externalId, credentialRef, enabled = false, config }) {
    if (![id, provider, externalId].every(isIdentifier) || typeof enabled !== "boolean" ||
        typeof credentialRef !== "string" || !/^ref:[A-Za-z0-9_.-]{1,120}$/.test(credentialRef) ||
        looksLikeOpenAISecret(credentialRef)) {
      throw new TypeError("Invalid quota organization");
    }
    const normalized = normalizeConfig(config);
    return db.transaction(() => {
      const existing = getOrganization(id);
      if (existing && (existing.provider !== provider || existing.externalId !== externalId)) {
        throw new TypeError("Quota organization identity cannot change");
      }
      db.run(`INSERT INTO quotaOrganizations(id, provider, externalId, credentialRef, enabled, config)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET credentialRef = excluded.credentialRef,
          enabled = excluded.enabled, config = excluded.config`,
      [id, provider, externalId, credentialRef, Number(enabled), JSON.stringify(normalized)]);
      return getOrganization(id);
    });
  }

  function bindConnection({ organizationId, connectionId, apiKeyId, projectId = null, validFrom }) {
    if (![organizationId, connectionId, apiKeyId].every(isIdentifier) ||
        (projectId !== null && !isIdentifier(projectId)) || !isTime(validFrom)) {
      throw new TypeError("Invalid quota connection binding");
    }
    return db.transaction(() => {
      const org = getOrganization(organizationId);
      const connection = db.get("SELECT provider FROM providerConnections WHERE id = ?", [connectionId]);
      if (!org || connection?.provider !== org.provider) throw new TypeError("Invalid quota binding provider");

      const latest = db.get(`SELECT * FROM quotaConnectionBindings
        WHERE connectionId = ? ORDER BY validFrom DESC LIMIT 1`, [connectionId]);
      if (latest?.validFrom === validFrom && latest.organizationId === organizationId &&
          latest.apiKeyId === apiKeyId && latest.projectId === projectId) return latest;
      if (latest && latest.validFrom >= validFrom) throw new TypeError("Invalid quota binding order");
      if (latest) {
        db.run("UPDATE quotaConnectionBindings SET validTo = ? WHERE connectionId = ? AND validFrom = ?",
          [validFrom, connectionId, latest.validFrom]);
      }
      db.run(`INSERT INTO quotaConnectionBindings
        (organizationId, connectionId, apiKeyId, projectId, validFrom) VALUES (?, ?, ?, ?, ?)`,
      [organizationId, connectionId, apiKeyId, projectId, validFrom]);
      return { organizationId, connectionId, apiKeyId, projectId, validFrom, validTo: null };
    });
  }

  function getConnectionBinding(organizationId, connectionId, at = now()) {
    if (!isTime(at)) throw new TypeError("Invalid quota binding time");
    return db.get(`SELECT * FROM quotaConnectionBindings
      WHERE organizationId = ? AND connectionId = ? AND validFrom <= ?
        AND (validTo IS NULL OR validTo > ?) ORDER BY validFrom DESC LIMIT 1`,
    [organizationId, connectionId, at, at]) ?? null;
  }

  function classifyModel(organizationId, model) {
    const group = getOrganization(organizationId)?.config.groups.find(item => item.models.includes(model));
    return group ? { status: "classified", groupId: group.id } : { status: "unknown" };
  }

  function recordAttempt(key, attempt, success = null) {
    db.run(`INSERT INTO quotaCollectionState(organizationId, source, scope, lastAttempt, lastSuccess)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(organizationId, source, scope) DO UPDATE SET
      lastAttempt = excluded.lastAttempt, lastSuccess = COALESCE(excluded.lastSuccess, quotaCollectionState.lastSuccess)`,
    [...key, JSON.stringify(attempt), success ? JSON.stringify(success) : null]);
  }

  function publish(key, observation, attempt) {
    const collectionId = randomUUID();
    const success = {
      collectionId, window: attempt.window, collectedAt: observation.collectedAt,
      dataAsOf: observation.dataAsOf ?? null,
    };
    db.transaction(() => {
      for (const bucket of observation.buckets) {
        db.run(`INSERT INTO quotaBuckets
          (organizationId, source, scope, bucketStart, bucketEnd, collectionId, collectedAt, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(organizationId, source, scope, bucketStart) DO UPDATE SET
          bucketEnd = excluded.bucketEnd, collectionId = excluded.collectionId,
          collectedAt = excluded.collectedAt, data = excluded.data`,
        [...key, bucket.start, bucket.end, collectionId, observation.collectedAt,
          JSON.stringify({ version: 1, rows: bucket.rows, window: success.window, dataAsOf: success.dataAsOf })]);
      }
      recordAttempt(key, attempt, success);
    });
  }

  async function collect(organizationId, input, adapter) {
    const query = normalizeQuotaQuery(input);
    const organization = getOrganization(organizationId);
    if (!organization?.enabled) throw new QuotaCollectionError("configuration");
    const key = [organizationId, query.source, query.scope];
    const lock = JSON.stringify([organization.provider, organization.externalId, query.source]);
    if (inFlight.has(lock)) throw new QuotaCollectionError("in_progress");
    inFlight.add(lock);
    const attempt = { window: { start: query.start, end: query.end }, startedAt: now() };
    try {
      const observation = await adapter.collect({
        ...query, organizationId: organization.externalId, credentialRef: organization.credentialRef,
      });
      assertObservation(observation, query);
      const finished = { ...attempt, finishedAt: now() };
      if (!observation.buckets.length) {
        recordAttempt(key, { ...finished, outcome: "no_data" });
        return { outcome: "no_data" };
      }
      try {
        publish(key, observation, { ...finished, outcome: "success" });
      } catch {
        throw new QuotaCollectionError("persistence");
      }
      return { outcome: "success", bucketCount: observation.buckets.length };
    } catch (err) {
      const error = err instanceof QuotaCollectionError ? err : new QuotaCollectionError("collection_failed");
      try {
        recordAttempt(key, {
          ...attempt, finishedAt: now(), outcome: "error", error: {
            code: error.code, status: error.status, retryAfterMs: error.retryAfterMs,
          },
        });
      } catch {
        throw new QuotaCollectionError("persistence");
      }
      throw error;
    } finally {
      inFlight.delete(lock);
    }
  }

  function readSnapshot(organizationId, input) {
    const query = normalizeQuotaQuery(input);
    const window = { start: query.start, end: query.end };
    const key = [organizationId, query.source, query.scope];
    const organization = getOrganization(organizationId);
    if (!organization) return null;
    return db.transaction(() => {
      const state = db.get(`SELECT lastAttempt, lastSuccess FROM quotaCollectionState
        WHERE organizationId = ? AND source = ? AND scope = ?`, key);
      const lastAttempt = state ? JSON.parse(state.lastAttempt) : null;
      const success = state?.lastSuccess ? JSON.parse(state.lastSuccess) : null;
      let lastSuccess = null;
      if (success) {
        const { collectionId, ...metadata } = success;
        const buckets = db.all(`SELECT bucketStart, bucketEnd, collectedAt, data FROM quotaBuckets
          WHERE organizationId = ? AND source = ? AND scope = ? AND collectionId = ?
          ORDER BY bucketStart`, [...key, collectionId]);
        lastSuccess = {
          ...metadata,
          buckets: buckets.map(decodeBucket),
        };
      }
      const gaps = gapsInWindow(window, lastSuccess);
      const hasObservation = gaps.length !== 1 || gaps[0].start !== window.start || gaps[0].end !== window.end;
      const staleAfterMs = organization.config[query.source === "usage" ? "usageStaleAfterMs" : "costsStaleAfterMs"];
      const failedInWindow = lastAttempt && lastAttempt.outcome !== "success" &&
        lastAttempt.window.start < window.end && lastAttempt.window.end > window.start;
      const status = !hasObservation ? "unknown"
        : failedInWindow || now() - lastSuccess.collectedAt >= staleAfterMs ? "stale" : "valid";
      const coverage = !hasObservation ? "missing" : gaps.length ? "partial" : "full";
      return { status, coverage, window, gaps, lastAttempt, lastSuccess };
    });
  }

  function listObservedBuckets(organizationId, input) {
    const query = normalizeQuotaQuery(input);
    return db.all(`SELECT bucketStart, bucketEnd, collectedAt, data FROM quotaBuckets
      WHERE organizationId = ? AND source = ? AND scope = ? AND bucketStart < ? AND bucketEnd > ?
      ORDER BY bucketStart`, [organizationId, query.source, query.scope, query.end, query.start])
      .map(decodeBucket);
  }

  return { putOrganization, bindConnection, getConnectionBinding, classifyModel, collect, readSnapshot, listObservedBuckets };
}
