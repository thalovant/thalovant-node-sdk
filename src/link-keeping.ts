/**
 * Keeping a long-lived hub link up, as pure rules every SDK shares
 * (`link-keeping-vectors.json`): which closes are the hub refusing the
 * credentials, and what to do after each outcome of an attempt.
 *
 * `HubSession.run()` follows them; a caller that runs its own loop can use
 * them directly. This module imports nothing, so the transports and the
 * session can both read it.
 */

/**
 * Seconds, using a monotonic clock. Explicit probes let the host own
 * scheduling; `HubSession.run()` keeps the link by the same numbers.
 *
 * `refusalGraceSeconds` is how long `run()` keeps trying through refusals
 * before it gives up: a connection just created is refused until its hub has
 * admitted it -- about ninety seconds -- so a refusal is only final once it has
 * lasted this long.
 */
export class HubSessionPolicy {
  constructor(
    readonly retrySeconds = 10,
    readonly retryCeilingSeconds = 120,
    readonly probeSeconds = 60,
    readonly probeDownSeconds = 5,
    readonly refusalGraceSeconds = 600,
  ) {
    if (
      ![
        retrySeconds,
        retryCeilingSeconds,
        probeSeconds,
        probeDownSeconds,
        refusalGraceSeconds,
      ].every((v) => Number.isFinite(v) && v > 0) ||
      retryCeilingSeconds < retrySeconds
    )
      throw new RangeError(
        "Session policy requires positive finite durations and an ordered retry ceiling",
      );
  }
  nextWait(current: number): number {
    return Math.min(current * 2, this.retryCeilingSeconds);
  }
}

/**
 * The close codes (RFC 6455) a hub turns credentials away with: no status at
 * all (1005) for an access key it does not know and after a Noise abort, 1008
 * for a malformed authorization, and 1000 from hubs that close politely.
 * Anything else -- 1001, 1011, 1013, a socket that ended with no close frame
 * (1006) -- is the hub's trouble or the network's.
 */
export const REFUSAL_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1005, 1008]);
/** How long after the handshake, in milliseconds, a close is still the hub's answer to it. */
export const REFUSAL_SETTLE_MS = 750;
/** How late, in milliseconds, a transport may learn a close's code and still have it count. */
export const CLOSE_CODE_GRACE_MS = 250;

/**
 * Whether a close is the hub refusing the credentials rather than a drop.
 *
 * `code` is the RFC 6455 close code, null or undefined when the socket ended
 * without one. `closedAfterHandshakeMs` is when the close happened, counted
 * from the end of the handshake -- undefined for a close during it -- so the
 * close's own time decides, not when the transport reported it.
 * `codeLateMs` is how long after the close the transport learnt the code.
 */
export function closeRefuses(
  code: number | null | undefined,
  options: { closedAfterHandshakeMs?: number; codeLateMs?: number } = {},
): boolean {
  if (code === null || code === undefined || !REFUSAL_CLOSE_CODES.has(code)) return false;
  if ((options.codeLateMs ?? 0) > CLOSE_CODE_GRACE_MS) return false;
  return options.closedAfterHandshakeMs === undefined || options.closedAfterHandshakeMs <= REFUSAL_SETTLE_MS;
}

/** What happened on one attempt to keep a link up. */
export type LinkOutcome = "up" | "dropped" | "failed" | "refused" | "key_changed";

/**
 * What to do after one outcome: `hold` (the link is up), `retry` after
 * `waitSeconds`, or `give_up` for `reason`.
 */
export interface LinkDecision {
  readonly action: "hold" | "retry" | "give_up";
  readonly waitSeconds: number;
  readonly reason?: "refused" | "key_changed";
}

/**
 * How a long-lived link is kept up, as a pure function of what happened and
 * when:
 *
 * - `up`: hold, and start the ladder and the refusal clock afresh;
 * - `dropped` (an established link went down): dial again at once;
 * - `failed`: wait the ladder's step -- `retrySeconds`, doubling to
 *   `retryCeilingSeconds` -- and stop counting refusals;
 * - `refused`: wait the ladder's step the same way until refusals have lasted
 *   `refusalGraceSeconds` since the first of them (inclusive), then give up;
 * - `key_changed`: give up at once: retrying cannot change the hub's key.
 */
export class LinkSupervisor {
  readonly policy: HubSessionPolicy;
  private wait: number;
  private refusedSince?: number;

  constructor(policy: HubSessionPolicy = new HubSessionPolicy()) {
    this.policy = policy;
    this.wait = policy.retrySeconds;
  }

  /** The decision after `outcome`, observed at `now` (seconds, any monotonic origin). */
  after(outcome: LinkOutcome, now: number): LinkDecision {
    switch (outcome) {
      case "up":
        this.wait = this.policy.retrySeconds;
        this.refusedSince = undefined;
        return { action: "hold", waitSeconds: 0 };
      case "dropped":
        return { action: "retry", waitSeconds: 0 };
      case "key_changed":
        return { action: "give_up", waitSeconds: 0, reason: "key_changed" };
      case "refused":
        this.refusedSince ??= now;
        if (now - this.refusedSince >= this.policy.refusalGraceSeconds) {
          return { action: "give_up", waitSeconds: 0, reason: "refused" };
        }
        break;
      case "failed":
        this.refusedSince = undefined;
        break;
      default:
        throw new RangeError(`Unknown link outcome ${String(outcome)}.`);
    }
    const wait = this.wait;
    this.wait = this.policy.nextWait(this.wait);
    return { action: "retry", waitSeconds: wait };
  }
}
