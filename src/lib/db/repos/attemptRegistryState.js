const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SENSITIVE_PREFIX = /(?:^|[:/])(?:sk-|gh[pousr]_|github_pat_)/i;

export const OPEN_STATES = ["prepared", "dispatch_possible", "response_observed", "in_progress"];
export const PURPOSES = ["primary", "retry", "fallback", "panel", "judge", "classifier", "continuation", "probe"];

export class AttemptRegistryError extends Error {
  constructor(code) {
    super(`Attempt Registry: ${code}`);
    this.name = "AttemptRegistryError";
    this.code = code;
  }
}

export function requireValue(condition, code = "invalid_input") {
  if (!condition) throw new AttemptRegistryError(code);
}

export function fields(value, names) {
  requireValue(value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).every(key => names.includes(key)));
}

export function opaqueId(value) {
  requireValue(typeof value === "string" && value.trim() === value && UUID.test(value));
  return value;
}

export function textId(value, pattern, optional = false) {
  if (optional && value == null) return null;
  requireValue(typeof value === "string" && value.trim() === value && pattern.test(value) && !SENSITIVE_PREFIX.test(value));
  return value;
}

export function timestamp(value) {
  requireValue(Number.isSafeInteger(value) && value >= 0);
  return value;
}

export function tokenUsage(usage) {
  fields(usage, ["quality", "source", "completeness", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "evidenceId"]);
  const { quality, source, completeness } = usage;
  requireValue((quality === "measured" && source === "provider") || (quality === "estimated" && source === "gateway") ||
    (quality === "unknown" && source === null));
  const quantities = {};
  for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]) {
    const amount = usage[field] ?? null;
    requireValue(amount === null || (typeof amount === "string" && /^(?:0|[1-9][0-9]{0,39})$/.test(amount) && amount.trim() === amount));
    quantities[field] = amount;
  }
  const { inputTokens, outputTokens, cachedInputTokens, reasoningTokens } = quantities;
  if (quality === "unknown") {
    requireValue(completeness === "unknown" && Object.values(quantities).every(value => value === null) && usage.evidenceId == null);
  } else {
    requireValue(completeness === "complete" || completeness === "partial");
    requireValue(completeness === "complete" ? inputTokens !== null && outputTokens !== null : inputTokens !== null || outputTokens !== null);
    requireValue(cachedInputTokens === null || (inputTokens !== null && BigInt(cachedInputTokens) <= BigInt(inputTokens)));
    requireValue(reasoningTokens === null || (outputTokens !== null && BigInt(reasoningTokens) <= BigInt(outputTokens)));
  }
  return {
    quality, source, completeness, ...quantities,
    evidenceId: usage.evidenceId == null ? null : opaqueId(usage.evidenceId),
    explicitZero: quality === "measured" && completeness === "complete" && inputTokens === "0" && outputTokens === "0",
  };
}

export function usageRank(usage) {
  if (usage.quality === "measured") return usage.completeness === "complete" ? 3 : 2;
  return usage.quality === "estimated" ? 1 : 0;
}

const FINISH_OUTCOMES = {
  not_sent: ["invalid_request", "cancelled", "timeout", "internal_error", "process_exit"],
  closed: ["completed", "provider_error", "provider_cancelled"],
  uncertain: ["cancelled", "timeout", "transport_error", "provider_error", "internal_error", "process_exit"],
};

const FINISH_FROM = {
  not_sent: ["prepared"],
  closed: ["response_observed", "in_progress"],
  uncertain: ["dispatch_possible", "response_observed", "in_progress"],
};

export function transition(state, kind, details, barrierCertified) {
  switch (kind) {
    case "dispatch":
      requireValue(state === "prepared", "invalid_transition");
      return "dispatch_possible";
    case "acknowledge":
      requireValue(state === "dispatch_possible", "invalid_transition");
      return "response_observed";
    case "in_progress":
      requireValue(state === "response_observed", "invalid_transition");
      return "in_progress";
    case "usage":
      requireValue(["dispatch_possible", "response_observed", "in_progress", "closed", "uncertain"].includes(state), "invalid_transition");
      return state;
    case "returned_model":
      requireValue(["response_observed", "in_progress", "closed", "uncertain"].includes(state), "invalid_transition");
      return state;
    case "finish":
      requireValue(Object.hasOwn(FINISH_FROM, details.state) && FINISH_FROM[details.state].includes(state) &&
        FINISH_OUTCOMES[details.state].includes(details.outcome) && (details.state !== "not_sent" ||
          barrierCertified || details.noSendEvidence === "before_transport_invocation"), "invalid_transition");
      return details.state;
    case "recover":
      requireValue(OPEN_STATES.includes(state), "invalid_transition");
      return state === "prepared" && barrierCertified ? "not_sent" : "uncertain";
    default:
      throw new AttemptRegistryError("invalid_transition");
  }
}
