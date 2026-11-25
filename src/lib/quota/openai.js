import { QuotaCollectionError } from "./errors.js";
import { normalizeQuotaQuery, quotaBucketWidth } from "./query.js";
import { setTimeout as delay } from "node:timers/promises";

const ENDPOINTS = {
  usage: "/v1/organization/usage/completions",
  costs: "/v1/organization/costs",
};
const ORIGIN = "https://api.openai.com";
const REQUIRED_USAGE = ["input_tokens", "output_tokens", "num_model_requests"];
const OPTIONAL_USAGE = [
  "input_cached_tokens", "input_cache_write_tokens", "input_cache_write_30m_tokens",
  "input_cache_write_12h_tokens", "input_uncached_tokens", "input_text_tokens",
  "input_cached_text_tokens", "input_audio_tokens", "input_cached_audio_tokens",
  "input_image_tokens", "input_cached_image_tokens", "output_text_tokens",
  "output_audio_tokens", "output_image_tokens",
];
const DIMENSIONS = {
  usage: ["model", "service_tier", "project_id", "api_key_id", "user_id", "api_source", "batch"],
  costs: ["line_item", "project_id", "api_key_id", "user_id", "api_source", "quantity_unit"],
};
const RESULT_TYPES = {
  usage: "organization.usage.completions.result",
  costs: "organization.costs.result",
};

function invalid() {
  return new QuotaCollectionError("invalid_response");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeText(value, credential) {
  if (typeof value !== "string" || !value.trim() || value.includes(credential) ||
      /\bsk-(?:admin-|proj-)/i.test(value)) throw invalid();
  return value;
}

function normalizeUsage(raw, row) {
  for (const field of REQUIRED_USAGE) {
    if (!count(raw[field])) throw invalid();
    row[field] = raw[field];
  }
  for (const field of OPTIONAL_USAGE) {
    if (!Object.hasOwn(raw, field)) continue;
    if (raw[field] !== null && !count(raw[field])) throw invalid();
    row[field] = raw[field];
  }
  row.incentive = raw.service_tier === "incentivized-tier" ? "incentivized"
    : raw.service_tier == null ? "unknown" : "other";
}

function normalizeCosts(raw, row, credential) {
  if (Object.hasOwn(raw, "amount")) {
    if (raw.amount === null) {
      row.amount = null;
    } else {
      if (!record(raw.amount)) throw invalid();
      const { value, currency } = raw.amount;
      if (!Number.isFinite(value) || !/^[a-z]{3}$/i.test(safeText(currency, credential))) throw invalid();
      row.amount = { value: String(value), currency };
    }
  }
  if (Object.hasOwn(raw, "quantity")) {
    if (raw.quantity !== null && !Number.isFinite(raw.quantity)) throw invalid();
    row.quantity = raw.quantity;
  }
}

function normalizeBucket(bucket, query, credential) {
  if (!record(bucket) || bucket.object !== "bucket" ||
      !count(bucket.start_time) || !count(bucket.end_time) ||
      bucket.end_time <= bucket.start_time ||
      bucket.end_time - bucket.start_time > quotaBucketWidth(query.source, query.resolution) ||
      bucket.start_time >= query.end || bucket.end_time <= query.start ||
      !Array.isArray(bucket.results)) throw invalid();

  const rows = bucket.results.map(raw => {
    if (!record(raw) || raw.object !== RESULT_TYPES[query.source]) throw invalid();
    const row = {};
    for (const field of DIMENSIONS[query.source]) {
      if (!Object.hasOwn(raw, field)) continue;
      const value = raw[field];
      if (field === "batch" && value !== null && typeof value !== "boolean") throw invalid();
      row[field] = value === null || field === "batch" ? value : safeText(value, credential);
    }
    if (query.source === "usage") normalizeUsage(raw, row);
    else normalizeCosts(raw, row, credential);
    return row;
  });
  return { start: bucket.start_time, end: bucket.end_time, rows };
}

function retryAfter(header, now) {
  if (!header) return null;
  const ms = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function httpError(response, now) {
  const { status } = response;
  if (status === 401 || status === 403) return new QuotaCollectionError("authorization", status);
  if (status === 429) {
    return new QuotaCollectionError("rate_limited", status, retryAfter(response.headers.get("retry-after"), now));
  }
  return new QuotaCollectionError("http_error", Number.isInteger(status) ? status : null);
}

async function cancellable(run, signal) {
  if (!signal) return run();
  if (signal.aborted) throw new QuotaCollectionError("cancelled");
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(new QuotaCollectionError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function requestPage(fetchImpl, url, credentials, timeoutMs, now, signal) {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new QuotaCollectionError("timeout"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const request = async () => {
      let response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${credentials.apiKey}`,
            "OpenAI-Organization": credentials.organizationId,
            Accept: "application/json",
          },
        });
      } catch {
        throw new QuotaCollectionError("transport");
      }
      if (!response.ok) {
        const error = httpError(response, now());
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      try {
        return await response.json();
      } catch {
        throw invalid();
      }
    };
    return await cancellable(() => Promise.race([request(), deadline]), signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAIQuotaAdapter({
  resolveCredential,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  timeoutMs = 10_000,
  maxRetries = 2,
  maxPages = 200,
  backoffMs = 250,
  maxRetryDelayMs = 30_000,
} = {}) {
  if (typeof resolveCredential !== "function" || typeof fetchImpl !== "function" ||
      ![timeoutMs, maxPages, backoffMs, maxRetryDelayMs].every(value => count(value) && value > 0 && value <= 2_147_483_647) ||
      !count(maxRetries) || maxRetries > 5) throw new TypeError("Invalid OpenAI quota adapter options");

  async function fetchPage(url, credentials, signal) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await requestPage(fetchImpl, url, credentials, timeoutMs, now, signal);
      } catch (err) {
        const retryable = ["timeout", "transport", "rate_limited"].includes(err.code) ||
          (err.status >= 500 && err.status <= 599);
        if (!retryable || attempt >= maxRetries || err.retryAfterMs > maxRetryDelayMs) throw err;
        try {
          const wait = Math.max(err.retryAfterMs ?? 0, Math.min(maxRetryDelayMs, backoffMs * 2 ** attempt));
          await cancellable(() => signal ? sleep(wait, signal) : sleep(wait), signal);
        } catch {
          throw new QuotaCollectionError(signal?.aborted ? "cancelled" : "transport");
        }
      }
    }
  }

  return {
    async collect({ organizationId, credentialRef, signal, ...input }) {
      const query = normalizeQuotaQuery(input);
      if (typeof organizationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(organizationId) ||
          typeof credentialRef !== "string" || !credentialRef) throw new QuotaCollectionError("configuration");

      let apiKey;
      try {
        apiKey = await cancellable(() => resolveCredential(credentialRef), signal);
      } catch {
        throw new QuotaCollectionError(signal?.aborted ? "cancelled" : "configuration");
      }
      if (typeof apiKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(apiKey) || organizationId.includes(apiKey)) {
        throw new QuotaCollectionError("configuration");
      }

      const url = new URL(ENDPOINTS[query.source], ORIGIN);
      url.searchParams.set("start_time", query.start);
      url.searchParams.set("end_time", query.end);
      url.searchParams.set("bucket_width", query.resolution);
      for (const group of query.groupBy) url.searchParams.append("group_by", group);
      for (const [filter, items] of Object.entries(query.filters)) {
        for (const item of items) url.searchParams.append(filter, safeText(item, apiKey));
      }
      const startedAt = now();
      const buckets = [];
      const cursors = new Set();
      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const page = await fetchPage(new URL(url), { organizationId, apiKey }, signal);
        if (!record(page) || page.object !== "page" || !Array.isArray(page.data) ||
            typeof page.has_more !== "boolean") throw invalid();
        buckets.push(...page.data.map(bucket => normalizeBucket(bucket, query, apiKey)));

        if (!page.has_more) {
          if (page.next_page != null) throw invalid();
          buckets.sort((a, b) => a.start - b.start);
          if (buckets.some((bucket, i) => i > 0 && buckets[i - 1].end > bucket.start)) throw invalid();
          return {
            query, buckets, startedAt, collectedAt: now(),
            // Usage and Costs do not supply a completeness watermark.
            dataAsOf: null,
          };
        }

        const cursor = safeText(page.next_page, apiKey);
        if (cursor.length > 4096 || cursors.has(cursor)) throw invalid();
        cursors.add(cursor);
        url.searchParams.set("page", cursor);
      }
      throw new QuotaCollectionError("pagination_limit");
    },
  };
}
