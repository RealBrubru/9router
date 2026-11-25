import { getDashboardAuthSession } from "../auth/dashboardSession.js";
import { getAdapter } from "../db/driver.js";
import { createQuotaRepository } from "../db/repos/quotaRepo.js";
import { quotaBucketWidth } from "./query.js";
import { quotaDailyStart } from "./scheduler.js";
import { quotaCollectorStartedAt, quotaSchedulerEnabled } from "./runtime.js";

const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_PAGE_ROWS = 100;
const MAX_OFFSET = 100_000;
const MAX_WINDOW = { "1d": 31, "1m": 120 };

function response(body, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function principalOf(session) {
  if (session?.authenticated !== true) return null;
  if (session.oidc === true && session.saml !== true &&
      typeof session.oidcIssuer === "string" && session.oidcIssuer &&
      typeof session.oidcSub === "string" && session.oidcSub) {
    return { issuer: session.oidcIssuer, subject: session.oidcSub };
  }
  // The shared password represents the installation operator. SAML does not
  // currently provide a stable issuer + subject in the dashboard session.
  if (session.oidc !== true && session.saml !== true) return { localAdmin: true };
  return null;
}

function canRead(principal, organization) {
  return principal.localAdmin === true || organization.config.oidcReaders.some(reader =>
    reader.subject === principal.subject && reader.issuer === principal.issuer);
}

function integerParam(params, name, minimum, maximum, fallback) {
  if (!params.has(name)) return fallback;
  const value = params.get(name);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new TypeError("Invalid quota query parameters");
  }
  return number;
}

function parsePagination(params, names) {
  const allowed = new Set(["offset", "limit", ...names]);
  const seen = new Set();
  for (const name of params.keys()) {
    if (!allowed.has(name) || seen.has(name)) throw new TypeError("Invalid quota query parameters");
    seen.add(name);
  }
  return {
    offset: integerParam(params, "offset", 0, MAX_OFFSET, 0),
    limit: integerParam(params, "limit", 1, MAX_PAGE_ROWS, 50),
  };
}

function windowParams(params, now) {
  const source = params.get("source") ?? "usage";
  const resolution = params.get("resolution") ?? "1d";
  if (!["usage", "costs"].includes(source) || !Object.hasOwn(MAX_WINDOW, resolution) ||
      (source === "costs" && resolution !== "1d")) throw new TypeError("Invalid quota query parameters");
  const width = quotaBucketWidth(source, resolution);
  const nowSeconds = Math.floor(now / 1000);
  const currentStart = resolution === "1d" ? quotaDailyStart(nowSeconds)
    : Math.max(0, (Math.floor(nowSeconds / width) - 10) * width);
  const start = integerParam(params, "start", 0, nowSeconds, currentStart);
  // At midnight, the first second of the new day remains unknown.
  const end = integerParam(params, "end", 1, Math.max(nowSeconds, currentStart + 1),
    Math.max(nowSeconds, currentStart + 1));
  if (start % width || (params.has("end") && end % width && end !== nowSeconds) ||
      end <= start || end - start > width * MAX_WINDOW[resolution]) throw new TypeError("Invalid quota query window");
  return { source, resolution, start, end };
}

function page(items, { offset, limit }) {
  const data = items.slice(offset, offset + limit);
  const next = offset + data.length;
  return { data, nextOffset: next < items.length && next <= MAX_OFFSET ? next : null };
}

function publicOrganization({ id, provider, enabled, config }) {
  return { id, provider, enabled, groupCount: config.groups.length };
}

function publicGroups(groups) {
  return groups.slice(0, 50).map(({ id, limit, unit, models }) => ({
    id, limit, unit, models: models.slice(0, 100).map(model => model.slice(0, 200)),
    modelCount: models.length,
  }));
}

function scheduleStatus(repository, organization, query, enabled, runningSince) {
  const scheduled = enabled && organization.enabled && organization.provider === "openai" &&
    (query.resolution !== "1m" || organization.config.minuteEnabled);
  const state = scheduled ? repository.readSchedule(organization.id, query.source, query.resolution) : null;
  return {
    enabled: scheduled,
    runningSince: scheduled ? runningSince : null,
    nextAt: runningSince === null ? state?.nextAt ?? null : null,
    consecutiveFailures: state?.failures ?? 0,
  };
}

function usageRollup(buckets) {
  const totals = new Map();
  const counters = ["input_tokens", "output_tokens", "input_cached_tokens", "num_model_requests"];
  for (const bucket of buckets) {
    for (const row of bucket.rows) {
      const model = row.model ?? null;
      const serviceTier = row.service_tier ?? null;
      const key = JSON.stringify([model, serviceTier]);
      let total = totals.get(key);
      if (!total) {
        total = { model: model?.slice(0, 200) ?? null, serviceTier: serviceTier?.slice(0, 100) ?? null, incentive: row.incentive };
        for (const field of counters) total[field] = 0;
        totals.set(key, total);
      }
      for (const field of counters) {
        const sum = total[field] === null || row[field] == null ? null : total[field] + row[field];
        total[field] = Number.isSafeInteger(sum) ? sum : null;
      }
    }
  }
  return [...totals.values()];
}

function costRows(buckets) {
  return buckets.flatMap(bucket => bucket.rows.map(row => ({
    bucketStart: bucket.start,
    lineItem: row.line_item?.slice(0, 200) ?? null,
    amount: row.amount ?? null,
    quantity: row.quantity ?? null,
    quantityUnit: row.quantity_unit?.slice(0, 80) ?? null,
  })));
}

export function createQuotaReadApi({
  resolveSession = getDashboardAuthSession,
  openRepository = async () => createQuotaRepository(await getAdapter()),
  now = Date.now,
  schedulerEnabled = quotaSchedulerEnabled,
} = {}) {
  async function authenticate(request) {
    return principalOf(await resolveSession(request.cookies?.get("auth_token")?.value));
  }

  async function list(request) {
    const principal = await authenticate(request);
    if (!principal) return response({ error: "Unauthorized" }, 401);
    let pagination;
    try {
      pagination = parsePagination(new URL(request.url).searchParams, []);
    } catch {
      return response({ error: "Invalid quota query" }, 400);
    }
    try {
      const repository = await openRepository();
      const organizations = repository.listOrganizations().filter(org => canRead(principal, org));
      return response(page(organizations.map(publicOrganization), pagination));
    } catch {
      return response({ error: "Quota data unavailable" }, 503);
    }
  }

  async function snapshots(request, orgId) {
    const principal = await authenticate(request);
    if (!principal) return response({ error: "Unauthorized" }, 401);
    if (typeof orgId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(orgId)) {
      return response({ error: "Invalid quota query" }, 400);
    }
    let query, pagination;
    try {
      const params = new URL(request.url).searchParams;
      pagination = parsePagination(params, ["source", "resolution", "start", "end"]);
      query = windowParams(params, now());
    } catch {
      return response({ error: "Invalid quota query" }, 400);
    }
    try {
      const repository = await openRepository();
      const org = repository.getOrganization(orgId);
      if (!org || !canRead(principal, org)) return response({ error: "Organization not found" }, 404);
      const { observations, lastSuccess, ...snapshot } = repository.readSnapshot(orgId, query, { history: true });
      const covered = observations.filter(bucket => !bucket.omitted);
      const records = query.source === "usage" ? usageRollup(covered) : costRows(covered);
      return response({
        organization: publicOrganization(org),
        groups: publicGroups(org.config.groups),
        source: query.source,
        resolution: query.resolution,
        schedule: scheduleStatus(repository, org, query, schedulerEnabled(),
          quotaCollectorStartedAt(orgId, query.source, query.resolution)),
        ...snapshot,
        lastSuccess: lastSuccess && {
          window: lastSuccess.window, collectedAt: lastSuccess.collectedAt, dataAsOf: lastSuccess.dataAsOf,
        },
        buckets: observations.map(({ rows, observationId, ...bucket }) => ({ ...bucket, empty: rows.length === 0 })),
        records: page(records, pagination),
      });
    } catch {
      return response({ error: "Quota data unavailable" }, 503);
    }
  }
  return { list, snapshots };
}
