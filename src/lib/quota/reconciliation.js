// See docs/fork/QUOTA-RECONCILIATION.md for the normalized input contract.
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const OBSERVATION_STATES = ["observed", "stale", "omitted"];
const COVERAGE_STATES = ["complete", "partial", "unknown"];
const LOCAL_STATES = ["observed", "estimated", "pending", "unknown"];
const INCENTIVES = ["incentivized", "not-incentivized", "unknown"];
const ORIGINS = ["gateway", "external", "unknown"];
const KEY_USES = ["exclusive", "shared", "unknown"];
const SCOPE_FIELDS = ["organizationId", "groupId", "policyRevision", "unit"];

const isId = value => typeof value === "string" && value.trim().length > 0;
const isTime = value => Number.isSafeInteger(value) && value >= 0;
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const max = (a, b) => a > b ? a : b;
const contains = (outer, inner) => outer.start <= inner.start && inner.end <= outer.end;
const intersects = (a, b) => Math.max(a.start, b.start) < Math.min(a.end, b.end);
const copyWindow = ({ start, end }) => ({ start, end });

function assert(condition, field) {
  if (!condition) throw new TypeError(`Invalid reconciliation input: ${field}`);
}

function assertWindow(window, field) {
  assert(window && isTime(window.start) && isTime(window.end) && window.start < window.end, field);
}

function assertScope(scope) {
  assert(scope && SCOPE_FIELDS.every(key => isId(scope[key])), "scope");
}

function sameScope(a, b) {
  return a && SCOPE_FIELDS.every(key => a[key] === b[key]);
}

function exactDecimal(value, scale, field) {
  const parsed = typeof value === "string" && DECIMAL.exec(value);
  assert(parsed && (parsed[2]?.length ?? 0) <= scale, field);
  return BigInt(parsed[1] + (parsed[2] ?? "").padEnd(scale, "0"));
}

function formatDecimal(value, scale) {
  if (value === null) return null;
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
}

function uniqueIndex(items, field) {
  const index = new Map();
  for (const item of items) {
    assert(isId(item?.id) && !index.has(item.id), field);
    index.set(item.id, item);
  }
  return index;
}

function uncovered(window, intervals) {
  let cursor = window.start;
  const gaps = [];
  for (const interval of intervals) {
    if (interval.start >= window.end) break;
    if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < window.end) gaps.push({ start: cursor, end: window.end });
  return gaps;
}

function modelClass(policy, row) {
  assert(row.model == null || isId(row.model), "model");
  const incentive = row.incentive ?? "unknown";
  assert(INCENTIVES.includes(incentive), "incentive");
  if (incentive === "not-incentivized") return "notIncentivized";
  if (policy.excludedModels.includes(row.model)) return "outsideGroup";
  if (!policy.models.includes(row.model)) return "unclassifiedModel";
  return incentive === "incentivized" ? "incentivized" : "unclassifiedTier";
}

function visibleAt(records, knowledgeAt, field) {
  return records.filter(record => {
    assert(isTime(record?.knownAt), field);
    return record.knownAt <= knowledgeAt;
  });
}

function selectObservations(policy, observations, window, blockers) {
  const revisions = new Map();
  const ignored = [];
  for (const snapshot of observations) {
    assert(isId(snapshot?.id) && isTime(snapshot.revision) && isId(snapshot.resolution), "observation identity");
    if (!sameScope(snapshot.scope, policy.scope) || snapshot.source !== "usage") {
      addReason(blockers, "remote_scope_incompatible");
      continue;
    }
    if (snapshot.resolution !== policy.resolution) {
      ignored.push({ id: snapshot.id, revision: snapshot.revision, reason: "alternative_resolution" });
      continue;
    }
    if (snapshot.usageScope !== policy.usageScope) {
      addReason(blockers, "remote_scope_incompatible");
      continue;
    }
    assert(COVERAGE_STATES.includes(snapshot.populationCoverage), "observation population");
    assertWindow(snapshot.bucketWindow, "nominal bucket window");
    assertWindow(snapshot.observedWindow, "observed bucket window");
    assert(contains(snapshot.bucketWindow, snapshot.observedWindow), "observed window outside nominal bucket");
    assert(OBSERVATION_STATES.includes(snapshot.status) && isTime(snapshot.collectedAt) &&
      snapshot.collectedAt >= snapshot.observedWindow.end && snapshot.collectedAt <= snapshot.knownAt &&
      (snapshot.dataAsOf === null || (isTime(snapshot.dataAsOf) && snapshot.dataAsOf <= snapshot.collectedAt)) &&
      Array.isArray(snapshot.rows) && (snapshot.status !== "omitted" || snapshot.rows.length === 0), "observation metadata");
    const versions = revisions.get(snapshot.id) ?? new Map();
    assert(!versions.has(snapshot.revision), "duplicate observation revision");
    const sample = versions.values().next().value;
    assert(!sample || (sample.bucketWindow.start === snapshot.bucketWindow.start &&
      sample.bucketWindow.end === snapshot.bucketWindow.end), "observation nominal window changed");
    versions.set(snapshot.revision, snapshot);
    revisions.set(snapshot.id, versions);
  }

  const selected = [];
  for (const versions of revisions.values()) {
    const sorted = [...versions.values()].sort((a, b) => b.revision - a.revision);
    assert(sorted.every((snapshot, i) => i === 0 || snapshot.knownAt <= sorted[i - 1].knownAt), "observation revision chronology");
    if (!intersects(window, sorted[0].bucketWindow)) continue;
    selected.push(sorted[0]);
    for (const snapshot of sorted.slice(1)) {
      ignored.push({ id: snapshot.id, revision: snapshot.revision, reason: "superseded_revision" });
    }
  }
  selected.sort((a, b) => a.bucketWindow.start - b.bucketWindow.start || byId(a, b));
  for (let i = 1; i < selected.length; i++) {
    assert(selected[i - 1].bucketWindow.end <= selected[i].bucketWindow.start, "overlapping primary observations");
  }
  ignored.sort((a, b) => byId(a, b) || a.revision - b.revision);
  return { selected, ignored };
}

function addReason(reasons, code, subject) {
  if (subject === undefined && reasons.some(reason => reason.code === code && reason.subject === undefined)) return;
  reasons.push(subject === undefined ? { code } : { code, subject });
}

function readRemote(policy, snapshots, window, knowledgeAt, quantity, blockers) {
  const observed = snapshots.filter(snapshot => {
    if (snapshot.status === "omitted" || !intersects(window, snapshot.observedWindow)) return false;
    if (contains(window, snapshot.observedWindow)) return true;
    addReason(blockers, "remote_counters_cross_evaluation_window", snapshot.id);
    return false;
  });
  const intervals = observed.map(snapshot => snapshot.observedWindow);
  const referenceWindow = observed.length ? { start: window.start, end: intervals.at(-1).end } : null;
  const gaps = uncovered(window, intervals);
  const referenceGaps = referenceWindow ? uncovered(referenceWindow, intervals) : [];
  const coverage = observed.length === 0 ? "missing" : gaps.length === 0 ? "full" : "partial";
  if (!referenceWindow) addReason(blockers, "remote_coverage_missing");
  else if (referenceGaps.length) addReason(blockers, "remote_coverage_partial");
  const populationCoverage = observed.length === 0 || observed.some(snapshot => snapshot.populationCoverage === "unknown")
    ? "unknown" : observed.some(snapshot => snapshot.populationCoverage === "partial") ? "partial" : "complete";
  if (populationCoverage !== "complete") addReason(blockers, `remote_population_${populationCoverage}`);
  const collection = collectionQuality(observed, knowledgeAt, policy.maxCollectionAgeMs);
  const completeness = completenessQuality(observed, referenceWindow, policy.maxReportingLagMs, blockers);

  const totals = {
    incentivized: 0n, notIncentivized: 0n, outsideGroup: 0n,
    unclassifiedModel: 0n, unclassifiedTier: 0n, gateway: 0n, external: 0n, originUnknown: 0n,
  };
  const indexed = new Map();
  for (const snapshot of observed) {
    for (const row of uniqueIndex(snapshot.rows, "remote row id").values()) {
      const amount = quantity(row.amount, "remote amount");
      const classification = modelClass(policy, row);
      const origin = row.origin ?? "unknown";
      assert(ORIGINS.includes(origin) && KEY_USES.includes(row.keyUse ?? "unknown"), "remote origin or key use");
      totals[classification] += amount;
      if (classification === "incentivized") {
        totals[origin === "unknown" ? "originUnknown" : origin] += amount;
        indexed.set(JSON.stringify([snapshot.id, snapshot.revision, row.id]), { snapshot, row, amount });
      }
    }
  }
  if (totals.unclassifiedModel > 0n) addReason(blockers, "remote_model_unclassified");
  if (totals.unclassifiedTier > 0n) addReason(blockers, "remote_tier_unclassified");
  if (referenceWindow && completeness.status === "unknown" && !Object.values(totals).some(amount => amount > 0n)) {
    addReason(blockers, "remote_zero_without_completeness");
  }
  return { totals, indexed, coverage, populationCoverage, gaps, referenceGaps, referenceWindow, collection, completeness };
}

function collectionQuality(observed, knowledgeAt, maxAgeMs) {
  const stale = observed.filter(snapshot => snapshot.status === "stale" || knowledgeAt - snapshot.collectedAt > maxAgeMs);
  const lastCollectedAt = observed.reduce((latest, snapshot) => Math.max(latest, snapshot.collectedAt), 0);
  return {
    status: observed.length === 0 ? "unknown" : stale.length ? "stale" : "recent",
    lastCollectedAt: observed.length ? lastCollectedAt : null,
    maxAgeMs,
    staleObservationIds: stale.map(snapshot => snapshot.id),
  };
}

function completenessQuality(observed, reference, maxLagMs, blockers) {
  if (!reference) return { status: "unknown", requiredThrough: null, gaps: [] };
  const requiredThrough = Math.max(reference.start, reference.end - maxLagMs);
  const effective = [];
  let unknown = false;
  let materialGap = false;
  for (const { observedWindow, dataAsOf } of observed) {
    if (dataAsOf === null) {
      unknown = true;
      continue;
    }
    const end = Math.min(dataAsOf, observedWindow.end);
    if (end > observedWindow.start) effective.push({ start: observedWindow.start, end });
    if (observedWindow.start < requiredThrough && end < Math.min(requiredThrough, observedWindow.end)) materialGap = true;
  }
  if (materialGap || (!unknown && !effective.length)) addReason(blockers, "remote_completeness_material_gap");
  const gaps = uncovered(reference, effective);
  return { status: unknown ? "unknown" : gaps.length ? "partial" : "complete", requiredThrough, gaps };
}

function selectAttempts(policy, attempts, blockers) {
  const latest = new Map();
  const revisions = new Set();
  for (const attempt of attempts) {
    if (!sameScope(attempt.scope, policy.scope)) {
      addReason(blockers, "local_scope_incompatible");
      continue;
    }
    assert(isId(attempt.id), "local attempt id");
    const key = JSON.stringify([attempt.id, attempt.knownAt]);
    assert(!revisions.has(key), "duplicate attempt state");
    revisions.add(key);
    if (!latest.has(attempt.id) || latest.get(attempt.id).knownAt < attempt.knownAt) latest.set(attempt.id, attempt);
  }
  return [...latest.values()].sort(byId);
}

function readLocal(policy, attempts, window, quantity, reasons) {
  const totals = { observed: 0n, estimated: 0n, reserved: 0n, unreservedBound: 0n };
  const counts = { observed: 0, estimated: 0, pending: 0, unknown: 0, outsideScope: 0, crossesWindow: 0 };
  const bounds = [];
  const indexed = new Map();
  for (const attempt of attempts) {
    assertWindow(attempt.window, "attempt window");
    assert(LOCAL_STATES.includes(attempt.state), "attempt state");
    if (!intersects(window, attempt.window)) continue;
    const classification = modelClass(policy, attempt);
    if (classification === "outsideGroup" || classification === "notIncentivized") {
      counts.outsideScope++;
      continue;
    }

    const measured = attempt.state === "observed";
    const reported = measured || attempt.state === "estimated";
    assert(reported || attempt.amount == null, "amount on unmeasured attempt");
    assert(!measured || (attempt.upperBound == null && attempt.reserved == null), "bound or reservation on measured attempt");
    const amount = reported ? quantity(attempt.amount, "local amount") : null;
    const reserved = attempt.reserved == null ? 0n : quantity(attempt.reserved, "reserved amount");
    const upperBound = attempt.upperBound == null ? null : quantity(attempt.upperBound.amount, "upper bound");
    const defensible = upperBound !== null && isId(attempt.upperBound.reference) && (amount === null || upperBound >= amount);

    if (classification === "unclassifiedModel" && (amount !== 0n || reserved > 0n || (upperBound ?? 0n) > 0n)) {
      addReason(reasons, "local_model_unclassified", attempt.id);
    }
    if (!contains(policy.window, attempt.window)) counts.crossesWindow++;
    counts[attempt.state]++;
    if (reported) totals[attempt.state] += amount;
    totals.reserved += reserved;
    if (measured) {
      if (classification !== "unclassifiedModel") indexed.set(attempt.id, { attempt, amount });
    } else if (defensible) {
      const unreserved = max(0n, upperBound - reserved);
      totals.unreservedBound += unreserved;
      bounds.push({ attemptId: attempt.id, state: attempt.state, reference: attempt.upperBound.reference,
        amount: upperBound, reserved, unreserved });
    } else {
      addReason(reasons, upperBound === null ? "local_without_upper_bound" : "local_invalid_upper_bound", attempt.id);
    }
  }
  return { totals, counts, bounds, indexed };
}

function reviewEvidence(evidence, remote, local, quantity) {
  const idCounts = new Map();
  for (const entry of evidence) {
    assert(isId(entry?.id), "evidence id");
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  }

  const checked = [];
  for (const entry of [...evidence].sort(byId)) {
    const { id, basis, reference, attemptId, attemptKnownAt, observationId, revision, rowId, knownAt } = entry;
    const remoteKey = JSON.stringify([observationId, revision, rowId]);
    const target = remote.get(remoteKey);
    const source = local.get(attemptId);
    let amount;
    let reason;
    if (idCounts.get(id) > 1) reason = "duplicate_evidence";
    else if (!isId(reference) || !["verified-attempt", "verified-exclusive-aggregate"].includes(basis)) reason = "missing_verification";
    else if (!target || !source) reason = "observation_or_attempt_unavailable";
    else {
      const { row, snapshot } = target;
      const { attempt } = source;
      if (attempt.knownAt !== attemptKnownAt || knownAt < Math.max(attempt.knownAt, snapshot.knownAt)) reason = "evidence_chronology";
      else if (!isId(row.apiKeyId) || !isId(row.projectId) || !isId(row.serviceTier) ||
        row.apiKeyId !== attempt.apiKeyId || row.projectId !== attempt.projectId ||
        row.model !== attempt.model || (attempt.serviceTier != null && row.serviceTier !== attempt.serviceTier) ||
        !contains(snapshot.observedWindow, attempt.window)) reason = "incompatible_dimensions";
      else if (row.origin === "external" || (row.attemptId != null && row.attemptId !== attemptId) ||
        (basis === "verified-attempt" && row.attemptId == null) ||
        (basis === "verified-exclusive-aggregate" && (row.keyUse !== "exclusive" || row.origin !== "gateway"))) reason = "unproven_attribution";
      else {
        try {
          amount = quantity(entry.amount, "overlap amount");
          if (amount === 0n || amount > target.amount || amount > source.amount) reason = "overlap_out_of_bounds";
        } catch {
          reason = "invalid_overlap_amount";
        }
      }
    }
    if (reason === "duplicate_evidence" && checked.at(-1)?.id === id) continue;
    checked.push(reason ? { id, reason } :
      { id, basis, reference, attemptId, attemptKnownAt, observationId, revision, rowId, knownAt, remoteKey, amount });
  }
  return checked;
}

function reconcileEvidence(evidence, remote, local, quantity, format) {
  const checked = reviewEvidence(evidence, remote, local, quantity);
  const localClaims = new Map();
  const remoteClaims = new Map();
  for (const claim of checked.filter(item => !item.reason)) {
    localClaims.set(claim.attemptId, (localClaims.get(claim.attemptId) ?? 0) + 1);
    remoteClaims.set(claim.remoteKey, (remoteClaims.get(claim.remoteKey) ?? 0n) + claim.amount);
  }
  let overlap = 0n;
  const accepted = [];
  const rejected = [];
  for (const { remoteKey, amount, ...claim } of checked) {
    if (claim.reason) rejected.push(claim);
    else if (localClaims.get(claim.attemptId) > 1 ||
      remoteClaims.get(remoteKey) > remote.get(remoteKey).amount) {
      rejected.push({ id: claim.id, reason: "overlap_conflict" });
    } else {
      overlap += amount;
      accepted.push({ ...claim, amount: format(amount) });
    }
  }
  return { overlap, accepted, rejected };
}

function makeIndicative({ policy, evaluation, window, remote, blockers, localNotProvenIncluded, threshold, subtotal, format }) {
  const { referenceWindow, collection, completeness, coverage, populationCoverage } = remote;
  const unreportedExternalPossible = coverage !== "full" || populationCoverage !== "complete" || completeness.status !== "complete";
  const assumptions = [];
  const limitations = [];
  if (unreportedExternalPossible) assumptions.push("external_usage_only_as_reported");
  if (localNotProvenIncluded > 0n && remote.totals.incentivized > 0n) limitations.push("local_overlap_may_remain");
  if (completeness.status !== "complete") limitations.push(`provider_completeness_${completeness.status}`);
  if (collection.status === "stale") limitations.push("remote_collection_stale");
  if (referenceWindow && referenceWindow.end < window.end) limitations.push("remote_tail_unobserved");
  if (evaluation.mode === "retrospective") limitations.push("retrospective_knowledge");

  const historical = evaluation.mode === "retrospective" || evaluation.evaluatedAt >= policy.window.end ||
    collection.status === "stale" || (referenceWindow && window.end - referenceWindow.end > policy.maxObservationTailMs);
  const usable = referenceWindow && blockers.length === 0;
  return {
    indicative: {
      amount: usable ? format(max(0n, threshold - subtotal)) : null,
      excess: usable ? format(max(0n, subtotal - threshold)) : null,
      consideredSubtotal: referenceWindow ? format(subtotal) : null,
      status: usable ? historical ? "historical" : "current" : "unknown",
      referenceWindow,
      assumptions,
      limitations,
      blockers,
    },
    external: {
      status: unreportedExternalPossible ? "unreported_possible" : "reported_through_reference",
      reported: referenceWindow ? format(remote.totals.external) : null,
      reportedOriginUnknown: referenceWindow ? format(remote.totals.originUnknown) : null,
    },
  };
}

/** Calculates a passive, non-guaranteed quota indication using normalized evidence. */
export function reconcileQuota({ policy, evaluatedAt, knowledgeAt = evaluatedAt, localCoverage, observations = [], attempts = [], evidence = [] }) {
  assertScope(policy?.scope);
  assertWindow(policy.window, "policy window");
  assert(isTime(evaluatedAt) && isTime(knowledgeAt) && knowledgeAt >= evaluatedAt, "evaluation clocks");
  assert(isTime(policy.knownAt) && isTime(policy.validFrom) &&
    (policy.validTo === null || (isTime(policy.validTo) && policy.validTo > policy.validFrom)), "policy validity");
  const window = { start: policy.window.start, end: Math.max(policy.window.start, Math.min(evaluatedAt, policy.window.end)) };
  const evaluation = { mode: knowledgeAt === evaluatedAt ? "contemporaneous" : "retrospective", evaluatedAt, knowledgeAt };
  const context = {
    scope: Object.fromEntries(SCOPE_FIELDS.map(key => [key, policy.scope[key]])),
    window: copyWindow(policy.window),
    evaluatedWindow: window,
    evaluation,
  };
  const blockers = [];
  if (policy.knownAt > knowledgeAt) addReason(blockers, "policy_not_known_at_cutoff");
  if (policy.validFrom > policy.window.start || (policy.validTo !== null && policy.validTo < policy.window.end)) {
    addReason(blockers, "policy_not_valid_for_window");
  }
  if (blockers.length) {
    return {
      ...context,
      resolution: null,
      quality: null,
      observations: [],
      ignoredObservations: [],
      limit: null,
      marginWithheld: null,
      thresholdAfterMargin: null,
      remote: null,
      local: null,
      overlap: { amount: null, accepted: [], rejected: [] },
      consideredSubtotal: null,
      indicative: {
        amount: null, excess: null, consideredSubtotal: null, status: "unknown", referenceWindow: null,
        assumptions: [], limitations: [], blockers,
      },
    };
  }
  assert(isId(policy.resolution) && isId(policy.usageScope) &&
    Number.isInteger(policy.scale) && policy.scale >= 0 && policy.scale <= 18 &&
    [policy.maxReportingLagMs, policy.maxCollectionAgeMs, policy.maxObservationTailMs].every(isTime), "evaluation policy");
  assert(Array.isArray(policy.models) && policy.models.every(isId) &&
    Array.isArray(policy.excludedModels) && policy.excludedModels.every(model => isId(model) && !policy.models.includes(model)), "policy models");
  assert([observations, attempts, evidence].every(Array.isArray), "input collections");
  assert(localCoverage == null || (COVERAGE_STATES.includes(localCoverage.status) && isTime(localCoverage.knownAt)), "local coverage");
  const localQuality = localCoverage && localCoverage.knownAt <= knowledgeAt
    ? { status: localCoverage.status, knownAt: localCoverage.knownAt } : { status: "unknown", knownAt: null };

  const quantity = (value, field) => exactDecimal(value, policy.scale, field);
  const format = value => formatDecimal(value, policy.scale);
  const limit = quantity(policy.limit, "limit");
  const marginScale = 10n ** 18n;
  const margin = exactDecimal(policy.safetyMargin, 18, "safety margin");
  assert(margin < marginScale, "safety margin");
  // Round only the withheld margin, up to the policy's smallest accounting unit.
  const withheld = (limit * margin + marginScale - 1n) / marginScale;
  const threshold = limit - withheld;

  const { selected, ignored } = selectObservations(policy, visibleAt(observations, knowledgeAt, "observation knownAt"), window, blockers);
  const remote = readRemote(policy, selected, window, knowledgeAt, quantity, blockers);
  if (localQuality.status !== "complete") addReason(blockers, `local_coverage_${localQuality.status}`);
  const selectedAttempts = selectAttempts(policy, visibleAt(attempts, knowledgeAt, "attempt knownAt"), blockers);
  const local = readLocal(policy, selectedAttempts, window, quantity, blockers);
  const proofs = reconcileEvidence(visibleAt(evidence, knowledgeAt, "evidence knownAt"), remote.indexed, local.indexed, quantity, format);

  const localNotProvenIncluded = local.totals.observed - proofs.overlap;
  const subtotal = totals => remote.totals.incentivized + totals.observed - proofs.overlap + totals.reserved + totals.unreservedBound;
  // A trailing remote gap can only support a number for the observed reference horizon.
  const reference = remote.referenceWindow && remote.referenceWindow.end < window.end
    ? readLocal(policy, selectedAttempts, remote.referenceWindow, quantity, []).totals : local.totals;
  const { indicative, external } = makeIndicative({
    policy, evaluation, window, remote, blockers, localNotProvenIncluded: reference.observed - proofs.overlap,
    threshold, subtotal: subtotal(reference), format,
  });
  const formatTotals = totals => Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, format(value)]));

  return {
    ...context,
    resolution: policy.resolution,
    quality: {
      temporal: { status: remote.coverage, gaps: remote.gaps, referenceGaps: remote.referenceGaps },
      population: remote.populationCoverage,
      collection: remote.collection,
      completeness: remote.completeness,
      local: localQuality,
      external,
    },
    observations: selected.map(({ id, revision, bucketWindow, observedWindow, collectedAt, knownAt, dataAsOf, status }) =>
      ({ id, revision, bucketWindow: copyWindow(bucketWindow), observedWindow: copyWindow(observedWindow), collectedAt, knownAt, dataAsOf, status })),
    ignoredObservations: ignored,
    limit: format(limit),
    marginWithheld: format(withheld),
    thresholdAfterMargin: format(threshold),
    remote: remote.referenceWindow ? formatTotals(remote.totals) : null,
    local: {
      ...formatTotals(local.totals),
      counts: local.counts,
      bounds: local.bounds.map(({ amount, reserved, unreserved, ...bound }) =>
        ({ ...bound, amount: format(amount), reserved: format(reserved), unreserved: format(unreserved) })),
      notProvenIncluded: format(localNotProvenIncluded),
    },
    overlap: { amount: format(proofs.overlap), accepted: proofs.accepted, rejected: proofs.rejected },
    consideredSubtotal: format(subtotal(local.totals)),
    indicative,
  };
}
