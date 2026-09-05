import type { ThalovantEvent } from "./events.js";

export class ThalovantError extends Error {}
export class ThalovantIdentityError extends ThalovantError {}
export class ThalovantConnectionError extends ThalovantError {}
export class ThalovantTimeoutError extends ThalovantError {}
export class ThalovantRuntimeError extends ThalovantError {}
export class ThalovantApiError extends ThalovantError {}
export class ThalovantUnsupportedProtocolError extends ThalovantError {}

/**
 * The hub refused a message type this connection may not publish.
 *
 * The hub answers `hive.policy.denied` at once, naming the type and the list
 * it does allow; raising here saves the caller a timeout and tells the
 * operator exactly what to add to the connection's allow-list.
 */
export class ThalovantPolicyDeniedError extends ThalovantRuntimeError {
  /** The message type the hub refused, for example `ovos.intent.list`. */
  readonly deniedType: string;
  /** The hub's code, `acl_disallowed_type` for an allow-list refusal. */
  readonly code: string;
  readonly reason: string;
  /** The types the connection may publish, as the hub reported them. */
  readonly allowed: readonly string[];

  constructor(deniedType: string, options: { code?: string; reason?: string; allowed?: readonly string[] } = {}) {
    const detail = options.reason || options.code || "refused by the hub's policy";
    super(
      `The hub refused "${deniedType}": ${detail}. Allow this connection to publish ` +
        `"${deniedType}" in the dashboard's connection settings.`,
    );
    this.deniedType = deniedType;
    this.code = options.code ?? "";
    this.reason = options.reason ?? "";
    this.allowed = [...(options.allowed ?? [])];
  }

  /** Build the error from a `hive.policy.denied` event as the hub sends it. */
  static fromEvent(event: Pick<ThalovantEvent, "data">): ThalovantPolicyDeniedError {
    const data = event.data ?? {};
    const inner = isRecord(data.data) ? data.data : {};
    const allowed = Array.isArray(inner.allowed) ? inner.allowed.map(item => String(item)) : [];
    return new ThalovantPolicyDeniedError(String(data.denied_type ?? ""), {
      code: String(data.code ?? ""),
      reason: String(data.reason ?? ""),
      allowed,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
