export const quotaOrganizationsUrl = "/api/quota/organizations";
const pageSize = 100;
const daySeconds = 86_400;

export function snapshotUrl(organizationId, source, { previousDayStart, offset = 0 } = {}) {
  const search = new URLSearchParams({ source, resolution: "1d", offset, limit: source === "usage" ? 1 : pageSize });
  if (previousDayStart != null) {
    search.set("start", previousDayStart - daySeconds);
    search.set("end", previousDayStart);
  }
  return `${quotaOrganizationsUrl}/${encodeURIComponent(organizationId)}/snapshots?${search}`;
}

export function reconciliationUrl(organizationId, groupId) {
  return `${quotaOrganizationsUrl}/${encodeURIComponent(organizationId)}/groups/${encodeURIComponent(groupId)}/reconciliation`;
}

export async function readQuotaDashboard(url, signal, fetchImpl = fetch) {
  async function read(path) {
    const response = await fetchImpl(path, { signal, credentials: "same-origin", cache: "no-store" });
    if (response.status === 422 && path.endsWith("/reconciliation")) {
      const result = await response.json();
      if (["unsupported_quota_scope", "unsupported_policy_precision"].includes(result.reason)) return result;
    }
    if (!response.ok) {
      const error = new Error("Quota data unavailable");
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  if (url !== quotaOrganizationsUrl) return read(url);

  const organizations = [];
  const seen = new Set();
  let offset = 0;
  // Bound a manual refresh even for unusually large installations.
  for (let page = 0; page < 10; page++) {
    const { data, nextOffset } = await read(`${url}?limit=${pageSize}&offset=${offset}`);
    for (const organization of data) {
      if (!seen.has(organization.id)) {
        seen.add(organization.id);
        organizations.push(organization);
      }
    }
    if (nextOffset == null) return { organizations, truncated: false };
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) break;
    offset = nextOffset;
  }
  return { organizations, truncated: true };
}

export function quotaIndicators(reconciliation, group) {
  const result = reconciliation?.status === "available" ? reconciliation : null;
  const registry = result?.local.registry;
  const indicative = result?.indicative;
  return {
    incentivized: group?.modelCount > 0 ? result?.remote?.incentivized ?? null : null,
    unclassified: result?.remote?.unclassifiedModel ?? null,
    indicative: indicative?.amount != null && ["current", "historical"].includes(indicative.status)
      ? indicative : null,
    observed: registry?.totals.observed ?? null,
    legacy: result?.local.totals.observed ?? null,
    counts: registry?.counts ?? null,
  };
}
