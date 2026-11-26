import { randomUUID } from "node:crypto";
import { getAdapterSync } from "../db/driver.js";
import { createAttemptRegistryRepository } from "../db/repos/attemptRegistryRepo.js";

const ROUTE = "chat_completions";
const MAX_SSE_LINE = 256 * 1024;
const modelId = value => typeof value === "string" && /^[a-z0-9][a-z0-9_.:/-]{0,199}$/i.test(value) &&
  value.trim() === value && !value.includes("//") && !/(?:^|[:/])(?:sk-|gh[pousr]_|github_pat_)/i.test(value) ? value : null;
const tokens = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function normalizeUsage(usage) {
  const input = tokens(usage?.prompt_tokens);
  const output = tokens(usage?.completion_tokens);
  if (usage?.estimated === true || (input === null && output === null)) return null;
  const cache = tokens(usage?.prompt_tokens_details?.cached_tokens);
  const reasoning = tokens(usage?.completion_tokens_details?.reasoning_tokens);
  return {
    inputTokens: input === null ? null : String(input),
    outputTokens: output === null ? null : String(output),
    cachedInputTokens: input !== null && cache !== null && cache <= input ? String(cache) : null,
    reasoningTokens: output !== null && reasoning !== null && reasoning <= output ? String(reasoning) : null,
  };
}

function configuredBinding(db, connectionId, at) {
  const matches = db.all(`SELECT organizationId, validFrom FROM quotaConnectionBindings
    WHERE connectionId = ? AND validFrom <= ? AND (validTo IS NULL OR validTo > ?) LIMIT 2`, [connectionId, at, at]);
  return matches.length === 1 ? { status: "configured", ...matches[0] } : { status: "unknown" };
}

function attemptObserver({ write, now, db, connectionId, sentModel, onResponse, onOpaqueDispatch }) {
  let submitted = false;
  let finished = false;
  let streamStarted = false;
  let model = null;
  let usage = null;
  let completeUsage = false;
  let buffer = "";
  let skipLine = false;
  const decoder = new TextDecoder();

  function finish(state, outcome) {
    if (finished) return;
    finished = true;
    buffer = "";
    const usageDetails = usage && {
      usage: { ...usage, quality: "measured", source: "provider", completeness: completeUsage ? "complete" : "partial" },
    };
    // Both observations are ready here. Commit the evidence before the separate
    // outcome so recovery can still retain measured usage after a crash.
    if (model && usageDetails) write("recordModelAndUsage", {
      returnedModel: model, usageEventId: randomUUID(), ...usageDetails,
    });
    else if (model) write("observeReturnedModel", { returnedModel: model });
    else if (usageDetails) write("recordUsage", usageDetails);
    write("finish", {
      state, outcome, ...(state === "not_sent" ? { noSendEvidence: "before_transport_invocation" } : {}),
    });
  }

  function observeUsage(value, final) {
    const observed = normalizeUsage(value);
    if (!observed) return;
    const nextComplete = final && observed.inputTokens !== null && observed.outputTokens !== null;
    if (completeUsage && !nextComplete) return;
    completeUsage = nextComplete;
    if (!usage || nextComplete) usage = observed;
    else {
      // Provider frames are cumulative snapshots. Retain each side's associated
      // breakdown only when that side is absent from the newer partial frame.
      for (const [total, subset] of [["inputTokens", "cachedInputTokens"], ["outputTokens", "reasoningTokens"]]) {
        if (observed[total] !== null) {
          usage[total] = observed[total];
          usage[subset] = observed[subset];
        }
      }
    }
  }

  function line(value) {
    const text = value.trim();
    if (!text.startsWith("data:")) return;
    const payload = text.slice(5).trim();
    if (payload === "[DONE]") {
      finish("closed", "completed");
      return;
    }
    try {
      const event = JSON.parse(payload);
      model ||= modelId(event?.model);
      observeUsage(event?.usage, Array.isArray(event?.choices) && event.choices.length === 0);
      if (event?.error) finish("closed", "provider_error");
    } catch {
      // Malformed lines have no evidentiary value. The client parser owns their handling.
    }
  }

  function feed(text) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && !finished; i++) {
      const value = lines[i];
      const last = i === lines.length - 1;
      if (!skipLine && buffer.length + value.length <= MAX_SSE_LINE) buffer += value;
      else {
        buffer = "";
        skipLine = true;
      }
      if (!last) {
        if (!skipLine) line(buffer);
        buffer = "";
        skipLine = false;
      }
    }
  }

  return {
    beforeSend(usesConfiguredKey) {
      submitted = true;
      write("markDispatchPossible", () => {
        const at = now();
        const binding = usesConfiguredKey ? configuredBinding(db, connectionId, at) : { status: "unknown" };
        return { sentModel: modelId(sentModel), binding, occurredAt: at, usageHistoryLink: "unverified" };
      });
    },
    observeResponse(value) {
      if (value.redirected) {
        finish("uncertain", "transport_error");
        onOpaqueDispatch();
        return;
      }
      onResponse(value);
      write("acknowledge", { source: "transport", providerAccepted: "unknown", httpStatus: value.status });
      if (!value.ok) finish("closed", "provider_error");
    },
    errorBody(text) {
      try {
        const value = JSON.parse(text);
        if (!value?.error) return;
        const returnedModel = modelId(value.model);
        if (returnedModel) write("observeReturnedModel", { returnedModel });
        const measured = normalizeUsage(value.usage);
        if (measured) write("recordUsage", {
          usage: { ...measured, quality: "measured", source: "provider", completeness: "partial" },
        });
      } catch {
        // Only normalized metadata from an already consumed error body is evidence.
      }
    },
    failure(outcome) {
      if (!submitted) finish("not_sent", outcome === "transport_error" ? "internal_error" : outcome);
      else finish("uncertain", outcome);
    },
    json(value) {
      if (!Array.isArray(value?.choices) && !value?.error) {
        finish("uncertain", "transport_error");
        return;
      }
      model = modelId(value?.model);
      observeUsage(value?.usage, true);
      finish("closed", value?.error ? "provider_error" : "completed");
    },
    sseChunk(chunk) {
      if (finished) return;
      if (!streamStarted) {
        streamStarted = true;
        write("markInProgress", { mode: "stream" });
      }
      feed(decoder.decode(chunk, { stream: true }));
    },
    sseEof() {
      if (finished) return;
      feed(decoder.decode());
      if (!skipLine && buffer) line(buffer);
      if (!finished) finish("uncertain", "transport_error");
    },
  };
}

export function createOpenAiDirectAttemptPilot({ openDb = () => getAdapterSync(), env = process.env, now = Date.now,
  reportGap = () => console.warn("[Attempt Registry] OpenAI direct pilot coverage is indeterminate") } = {}) {
  let current;
  let pendingRetirement;
  let enabled = false;
  let generation = 0;
  const instanceId = randomUUID();

  function flushRetirement(db) {
    if (pendingRetirement?.epoch.db !== db) return;
    const { epoch, occurredAt, reason } = pendingRetirement;
    if (reason) epoch.repo.markCoverageGap({ id: epoch.id, occurredAt, reason });
    else epoch.repo.closeEpoch({ id: epoch.id, occurredAt });
    pendingRetirement = null;
  }

  function retire(epoch, reason) {
    current = null;
    pendingRetirement = { epoch, occurredAt: now(), reason };
    try { flushRetirement(epoch.db); } catch {}
  }

  function warnCoverageGap() {
    try { reportGap(); } catch {}
  }

  function prepare(requestId, receivedAt, requestedModel, {
    connectionId, sentModel, purpose, submissionCause, previousAttemptId, onResponse, onOpaqueDispatch,
  }) {
    let epoch = current;
    let version;
    const attemptId = randomUUID();
    let failed = false;
    function gap() {
      if (failed) return;
      failed = true;
      if (epoch && current === epoch) retire(epoch, "storage_failure");
      warnCoverageGap();
    }
    try {
      const db = openDb();
      flushRetirement(db);
      if (current?.db !== db) {
        epoch = { db, id: randomUUID(), repo: createAttemptRegistryRepository(db, { now }) };
        epoch.repo.openEpoch({
          id: epoch.id, instanceId, instrumentationVersion: "openai-direct-v3", route: ROUTE, operation: "chat",
          transport: "http", barrierCertified: false, openedAt: now(),
        });
        current = epoch;
      }
      epoch = current;
      const at = now();
      version = epoch.repo.prepare({
        request: { id: requestId, route: ROUTE, requestedModel: modelId(requestedModel), receivedAt },
        attempt: { id: attemptId, epochId: epoch.id, provider: "openai", connectionId, purpose, previousAttemptId, submissionCause },
        eventId: randomUUID(), occurredAt: at, knownAt: at,
      }).version;
    } catch {
      gap();
      return null;
    }

    function write(method, details) {
      if (failed) return;
      try {
        const at = now();
        const extra = typeof details === "function" ? details() : details;
        version = epoch.repo[method]({
          attemptId, eventId: randomUUID(), expectedVersion: version, occurredAt: at, knownAt: now(), ...extra,
        }).version;
      } catch { gap(); }
    }
    return { id: attemptId, observer: attemptObserver({ write, now, db: epoch.db, connectionId, sentModel, onResponse, onOpaqueDispatch }) };
  }

  return function begin() {
    if (env.ATTEMPT_REGISTRY_OPENAI_DIRECT !== "true") {
      if (enabled) {
        enabled = false;
        generation++;
        if (current) retire(current, null);
        if (pendingRetirement && !pendingRetirement.reason) warnCoverageGap();
      }
      return null;
    }
    enabled = true;
    const requestGeneration = generation;
    const requestId = randomUUID();
    const receivedAt = now();
    return {
      forModel(requestedModel) {
        let previousAttemptId = null;
        const responses = new WeakMap();
        return {
          skip() { previousAttemptId = null; },
          forResponse(response) { return responses.get(response); },
          execution(cause) {
            let currentObserver;
            return {
              skip() { previousAttemptId = null; currentObserver = null; },
              current() { return currentObserver; },
              prepare(details, submissionCause = cause) {
                if (requestGeneration !== generation) return null;
                const purpose = !submissionCause ? "primary" : submissionCause === "connection_fallback" ? "fallback" : "retry";
                const attempt = prepare(requestId, receivedAt, requestedModel, {
                  ...details, purpose, submissionCause, previousAttemptId,
                  onResponse: response => responses.set(response, attempt.observer),
                  onOpaqueDispatch: () => { previousAttemptId = null; },
                });
                previousAttemptId = attempt?.id ?? null;
                currentObserver = attempt?.observer;
                return currentObserver;
              },
            };
          },
        };
      },
    };
  };
}

export const beginOpenAiDirectAttempt = createOpenAiDirectAttemptPilot();
