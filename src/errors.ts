import type { ThalovantEvent } from "./events.js";

export class ThalovantError extends Error {}
export class ThalovantIdentityError extends ThalovantError {}
export class ThalovantConnectionError extends ThalovantError {}
export class ThalovantTimeoutError extends ThalovantError {}
export class ThalovantRuntimeError extends ThalovantError {}
export class ThalovantApiError extends ThalovantError {
  readonly statusCode?: number;
  constructor(message?: string, options?: ErrorOptions & { statusCode?: number }) {
    super(message, options);
    this.statusCode = options?.statusCode;
  }
}
export class ThalovantUnsupportedProtocolError extends ThalovantError {}

/**
 * The numbers behind a refusal that is a spent allowance, not a policy.
 *
 * The intent-quota policy denies with `intent_quota_exceeded` and sends which
 * counter ran out (`daily`, `monthly`), what it allows, how much was used, and
 * how many seconds until it resets. Without them a caller can only say
 * "refused", which is what an app showed somebody who had used up the day.
 */
export interface ThalovantQuota {
  readonly period: string;
  readonly limit: number;
  readonly used: number;
  /** Seconds until the counter resets, or 0 when the hub did not say. */
  readonly resetAfter: number;
}

/**
 * The hub refused a message, the instant it did.
 *
 * Three different things arrive as `hive.policy.denied`, and each needs
 * something different said about it: an allow-list refusal
 * (`acl_disallowed_type`, with `allowed`), a spent allowance
 * (`intent_quota_exceeded`, with `quota`), and a hub whose agent bus is down
 * (`backend_unavailable`) -- which nothing the caller does will fix.
 */
export class ThalovantPolicyDeniedError extends ThalovantRuntimeError {
  static readonly QUOTA_EXCEEDED = "intent_quota_exceeded";
  static readonly BACKEND_UNAVAILABLE = "backend_unavailable";

  /** The message type the hub refused, for example `recognizer_loop:utterance`. */
  readonly deniedType: string;
  /** The hub's code: `acl_disallowed_type`, `intent_quota_exceeded`, `backend_unavailable`. */
  readonly code: string;
  readonly reason: string;
  /** The types the connection may publish, as the hub reported them. */
  readonly allowed: readonly string[];
  /** The numbers behind a spent quota; undefined for any other refusal. */
  readonly quota?: ThalovantQuota;

  constructor(
    deniedType: string,
    options: { code?: string; reason?: string; allowed?: readonly string[]; quota?: ThalovantQuota } = {},
  ) {
    super(refusalMessage(deniedType, options.code ?? "", options.reason ?? "", options.quota));
    this.deniedType = deniedType;
    this.code = options.code ?? "";
    this.reason = options.reason ?? "";
    this.allowed = [...(options.allowed ?? [])];
    this.quota = options.quota;
  }

  /** Build the error from a `hive.policy.denied` event as the hub sends it. */
  static fromEvent(event: Pick<ThalovantEvent, "data">): ThalovantPolicyDeniedError {
    const data = event.data ?? {};
    // The policy's own detail rides nested under data.data
    // (hivemind-core _send_policy_denied: "data": verdict.data).
    const inner = isRecord(data.data) ? data.data : {};
    // Only non-blank strings, trimmed: a number, a null or a blank in the list
    // is not a message type, and stringifying one would put "3" or "null" in
    // front of an operator reading which types to allow.
    const allowed = Array.isArray(inner.allowed)
      ? inner.allowed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const code = typeof data.code === "string" ? data.code : "";
    const quota = code === ThalovantPolicyDeniedError.QUOTA_EXCEEDED
      ? {
          period: typeof inner.period === "string" ? inner.period : "",
          limit: count(inner.limit),
          used: count(inner.used),
          resetAfter: count(inner.reset_after),
        }
      : undefined;
    return new ThalovantPolicyDeniedError(typeof data.denied_type === "string" ? data.denied_type : "", {
      code,
      reason: typeof data.reason === "string" ? data.reason : "",
      allowed,
      quota,
    });
  }
}

/**
 * The hub understood a question and has nothing for it.
 *
 * `ovos.intent.unmatched` (`complete_intent_failure` from older hubs) is
 * neither a refusal nor a fault. As a bare runtime error a caller could only
 * report that something failed.
 */
export class ThalovantUnansweredError extends ThalovantRuntimeError {
  readonly said: string;
  constructor(said = "") {
    super(said || "The hub has no skill that answers this.");
    this.said = said;
  }
}

/** A whole count from the wire, or 0: never a boolean, never a guess. */
function count(value: unknown): number {
  if (typeof value === "number") return Number.isInteger(value) ? value : 0;
  if (typeof value === "string" && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
  return 0;
}

function refusalMessage(deniedType: string, code: string, reason: string, quota?: ThalovantQuota): string {
  // Advice follows the kind of refusal. Telling somebody who used up their day
  // to "allow this connection to publish recognizer_loop:utterance" sent them
  // to a settings page that could not help.
  if (quota) {
    const used = quota.limit ? `${quota.used} of ${quota.limit}` : "all";
    const period = quota.period ? ` ${quota.period}` : "";
    const resets = quota.resetAfter ? `; it resets in ${quota.resetAfter}s` : "";
    return `The hub refused "${deniedType}": ${used}${period} questions used${resets}.`;
  }
  if (code === ThalovantPolicyDeniedError.BACKEND_UNAVAILABLE) {
    return `The hub could not reach its assistant${reason ? `: ${reason}` : ""}. Try again shortly.`;
  }
  const detail = reason || code || "refused by the hub's policy";
  return (
    `The hub refused "${deniedType}": ${detail}. Allow this connection to publish ` +
    `"${deniedType}" in the dashboard's connection settings.`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
