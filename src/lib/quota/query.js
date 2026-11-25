const SOURCES = {
  usage: {
    widths: { "1d": 86400, "1m": 60 },
    groups: ["model", "service_tier", "project_id", "api_key_id", "user_id", "batch", "api_source"],
    filters: ["api_key_ids", "project_ids", "models", "user_ids"],
  },
  costs: {
    widths: { "1d": 86400 },
    groups: ["line_item", "project_id", "api_key_id", "user_id", "api_source"],
    filters: ["api_key_ids", "project_ids", "line_items"],
  },
};

function values(input, allowed) {
  if (!Array.isArray(input) || input.some(value =>
    typeof value !== "string" || !value.trim() || /\bsk-(?:admin-|proj-)/i.test(value) ||
    (allowed && !allowed.includes(value)))) {
    throw new TypeError("Invalid quota query dimensions");
  }
  return [...new Set(input)].sort();
}

export function normalizeQuotaQuery({ source, start, end, resolution = "1d", groupBy, filters = {} }) {
  if (!Object.hasOwn(SOURCES, source)) throw new TypeError("Invalid quota source");
  const definition = SOURCES[source];
  if (!Object.hasOwn(definition.widths, resolution) ||
      !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end <= start ||
      !filters || typeof filters !== "object" || Array.isArray(filters) ||
      Object.keys(filters).some(key => !definition.filters.includes(key))) {
    throw new TypeError("Invalid quota query");
  }
  const groups = values(groupBy ?? (source === "usage"
    ? ["model", "service_tier", "project_id", "api_key_id"]
    : ["line_item"]), definition.groups);
  const canonicalFilters = Object.fromEntries(definition.filters.filter(key => Object.hasOwn(filters, key))
    .map(key => [key, values(filters[key])]).filter(([, items]) => items.length > 0));
  return {
    source, start, end, resolution, groupBy: groups, filters: canonicalFilters,
    scope: JSON.stringify([resolution, groups, canonicalFilters]),
  };
}

export function quotaBucketWidth(source, resolution) {
  return SOURCES[source].widths[resolution];
}
