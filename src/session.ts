import {
  ThalovantClient,
  ThalovantSubscription,
  type EventHandler,
} from "./client.js";
import {
  ThalovantClientKeyRejectedError,
  ThalovantConnectionError,
  ThalovantHubKeyChangedError,
  ThalovantHubRefusedError,
  ThalovantRuntimeError,
} from "./errors.js";
import {
  replyContextFor,
  type BusPayload,
  type EventContext,
  type ThalovantEvent,
} from "./events.js";
import type { ThalovantIdentity } from "./identity.js";
import { refusalAfterHandshake, type SendOptions } from "./transport.js";
import { HubSessionPolicy, LinkSupervisor } from "./link-keeping.js";

// Defined beside the rules it parameterises, and exported here as it always was.
export { HubSessionPolicy };

export type HubSessionClient = Pick<
  ThalovantClient,
  "ask" | "emit" | "on" | "connectionInfo" | "close"
>;
/** A session client that may also answer a message along its route. */
type ReplyingClient = HubSessionClient & Partial<Pick<ThalovantClient, "reply">>;

/** Options for the {@link HubSession} constructor. */
export interface HubSessionOptions {
  policy?: HubSessionPolicy;
  clock?: () => number;
  /** Start connecting at construction. Default true. */
  warm?: boolean;
  /**
   * How long, in seconds, a link {@link HubSession.run} opens must stay up
   * before it counts. A hub that does not know the client's static key says so
   * only by closing right after the handshake, so a close inside this window is
   * a refusal rather than a drop. Default 0.75; 0 turns it off.
   */
  settleSeconds?: number;
}

/** A close inside the settle window is looked for this often, in milliseconds. */
const SETTLE_CHECK_MS = 50;
/** A held link is looked at this often between two probes, in milliseconds, to notice a drop. */
const WATCH_MS = 1_000;
/** The longest single timer a runtime accepts, in milliseconds. */
const MAX_TIMER_MS = 2_147_483_647;

/** Whether the client's last close was the hub turning its credentials away. */
/** The refusal a closed link's hub gave right after its handshake, or undefined. */
function refusalNow(client: Pick<HubSessionClient, "connectionInfo">): ThalovantHubRefusedError | undefined {
  try {
    const info = client.connectionInfo();
    return info.refused === true ? refusalAfterHandshake(info) : undefined;
  } catch {
    return undefined;
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export function alive(
  client?: Pick<HubSessionClient, "connectionInfo">,
): boolean {
  if (!client) return false;
  try {
    return !["closed", "error"].includes(client.connectionInfo().phase);
  } catch {
    return true;
  }
}
/**
 * One owned connection. Failed calls are never replayed; Ask may trigger actions.
 *
 * Subscriptions made with {@link on} are wired onto every client the session
 * builds, so a rebuild keeps them. {@link probe} and {@link warm} let a host
 * own the schedule; {@link run} keeps the link itself, by the policy's
 * numbers, until {@link close}.
 */
export class HubSession {
  private client?: HubSessionClient;
  private retired?: HubSessionClient;
  private queue: Promise<void> = Promise.resolve();
  private warming?: Promise<void>;
  private active = false;
  private closed = false;
  private subscriptions = new Map<
    symbol,
    { name: string; handler: EventHandler; bound?: ThalovantSubscription }
  >();
  private nextRetry = 0;
  private wait: number;
  private up = false;
  private readonly stateCallbacks = new Set<(up: boolean) => void>();
  private readonly wakers = new Set<() => void>();
  readonly policy: HubSessionPolicy;
  /** Seconds a link `run()` opens must stay up before it counts; see {@link HubSessionOptions}. */
  readonly settleSeconds: number;
  private readonly clock: () => number;
  constructor(
    private readonly connect: () => Promise<HubSessionClient>,
    options: HubSessionOptions = {},
  ) {
    this.policy = options.policy ?? new HubSessionPolicy();
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.settleSeconds = options.settleSeconds ?? 0.75;
    if (!Number.isFinite(this.settleSeconds) || this.settleSeconds < 0)
      throw new RangeError("settleSeconds must be finite and not negative");
    this.wait = this.policy.retrySeconds;
    if (options.warm !== false) void this.warm();
  }

  /**
   * A session whose clients connect with `identity`.
   *
   * `client` is passed to each `ThalovantClient` it builds (a protocol, a Noise
   * state directory, a transport); `connectTimeoutMs` bounds each connect. A
   * client whose connect fails is closed before the error is thrown.
   */
  static forIdentity(
    identity: ThalovantIdentity,
    options: HubSessionOptions & {
      client?: ConstructorParameters<typeof ThalovantClient>[1];
      connectTimeoutMs?: number;
    } = {},
  ): HubSession {
    const { client: clientOptions, connectTimeoutMs, ...sessionOptions } = options;
    return new HubSession(async () => {
      const client = new ThalovantClient(identity, clientOptions);
      try {
        await client.connect(connectTimeoutMs);
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
      return client;
    }, sessionOptions);
  }

  get held(): boolean {
    return this.client !== undefined;
  }
  /** Whether a client is held and its link is up. */
  get connected(): boolean {
    return this.client !== undefined && alive(this.client);
  }
  get retryAt(): number {
    return this.nextRetry;
  }
  get retryWait(): number {
    return this.wait;
  }
  probeDelay(): number {
    return this.held ? this.policy.probeSeconds : this.policy.probeDownSeconds;
  }
  /**
   * Call `callback` with `true` when the link comes up and `false` when it goes
   * down. Returns a function that unsubscribes.
   */
  onStateChange(callback: (up: boolean) => void): () => void {
    this.stateCallbacks.add(callback);
    return () => {
      this.stateCallbacks.delete(callback);
    };
  }
  private setState(up: boolean): void {
    if (up === this.up) return;
    this.up = up;
    for (const callback of [...this.stateCallbacks]) {
      try {
        callback(up);
      } catch {
        // A listener's failure is its own; the link does not change for it.
      }
    }
  }
  on(name: string, handler: EventHandler): ThalovantSubscription {
    if (this.closed)
      throw new ThalovantConnectionError("Hub session is closed");
    const entry = { name, handler, bound: this.client?.on(name, handler) };
    const id = Symbol();
    this.subscriptions.set(id, entry);
    return new ThalovantSubscription(() => {
      entry.bound?.close();
      this.subscriptions.delete(id);
    });
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      this.active = true;
      try {
        return await operation();
      } finally {
        this.active = false;
      }
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async cleanup(): Promise<void> {
    if (this.retired) {
      await this.retired.close();
      this.retired = undefined;
    }
  }
  private async drop(): Promise<void> {
    if (this.client) {
      this.retired = this.client;
      this.client = undefined;
      this.setState(false);
    }
    for (const entry of this.subscriptions.values()) {
      entry.bound?.close();
      entry.bound = undefined;
    }
    await this.cleanup();
  }
  private async ensure(settle = false): Promise<HubSessionClient> {
    if (this.closed)
      throw new ThalovantConnectionError("Hub session is closed");
    await this.cleanup();
    if (!this.client) {
      let fresh: HubSessionClient | undefined;
      try {
        fresh = await this.connect();
        if (this.closed)
          throw new ThalovantConnectionError("Hub session is closed");
        for (const entry of this.subscriptions.values())
          entry.bound = fresh.on(entry.name, entry.handler);
        if (settle) await this.settle(fresh);
        if (this.closed)
          throw new ThalovantConnectionError("Hub session is closed");
        this.client = fresh;
        this.nextRetry = 0;
        this.wait = this.policy.retrySeconds;
        this.setState(true);
      } catch (error) {
        this.nextRetry = this.clock() + this.wait;
        this.wait = this.policy.nextWait(this.wait);
        if (fresh) {
          this.retired = fresh;
          await this.drop();
        }
        throw error;
      }
    }
    return this.client;
  }
  /**
   * Hold a new link for `settleSeconds` before it counts: a close inside the
   * window is the hub's answer to the credentials, not a network drop.
   */
  private async settle(client: HubSessionClient): Promise<void> {
    const until = performance.now() + this.settleSeconds * 1000;
    while (alive(client) && !this.closed) {
      const left = until - performance.now();
      if (left <= 0) return;
      await delay(Math.min(SETTLE_CHECK_MS, left));
    }
    if (alive(client)) return;
    const refusal = refusalNow(client);
    if (refusal) throw refusal;
    throw new ThalovantConnectionError(
      "The hub closed the link right after the handshake.",
    );
  }
  /** Coalesces unattended attempts; callers inspect held/retryAt after completion. */
  warm(): Promise<void> {
    if (this.closed || this.clock() < this.nextRetry) return Promise.resolve();
    if (!this.warming)
      this.warming = this.exclusive(async () => {
        await this.ensure();
      })
        .catch(() => {})
        .finally(() => {
          this.warming = undefined;
        });
    return this.warming;
  }
  async probe(): Promise<void> {
    if (this.closed || this.active) return;
    await this.exclusive(async () => {
      if (this.client && !alive(this.client)) await this.drop();
    });
    if (!this.held) await this.warm();
  }
  private call<T>(fn: (client: HubSessionClient) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      if (this.client && !alive(this.client)) await this.drop();
      const client = await this.ensure();
      try {
        return await fn(client);
      } catch (error) {
        if (!(error instanceof ThalovantRuntimeError)) await this.drop();
        throw error;
      }
    });
  }
  ask(
    ...args: Parameters<HubSessionClient["ask"]>
  ): ReturnType<HubSessionClient["ask"]> {
    return this.call((c) => c.ask(...args));
  }
  emit(...args: Parameters<HubSessionClient["emit"]>): Promise<void> {
    return this.call((c) => c.emit(...args));
  }
  /**
   * Answer a message the hub sent, back along the route it came: the client's
   * `reply()` (see `ThalovantClient.reply`). A reply on a live link goes out at
   * once rather than behind a call in progress, since a hub waits for it on a
   * clock of its own; with no live link it connects first. Never replayed.
   */
  async reply(
    event: ThalovantEvent | BusPayload | { context?: EventContext | null },
    msgType: string,
    data: Record<string, unknown> = {},
    context?: EventContext,
    options: SendOptions = {},
  ): Promise<void> {
    const send = (client: ReplyingClient): Promise<void> => {
      if (options.signal?.aborted) return Promise.reject(abortError());
      return typeof client.reply === "function"
        ? client.reply(event, msgType, data, context, options)
        : client.emit(msgType, data, replyContextFor(event, context), options);
    };
    // A reply withdrawn by its own signal says nothing about the link: the
    // frame never went out, so the session's cipher state has not moved and
    // the client stays. Only a failure of the link itself drops it.
    const withdrawn = (error: unknown): boolean =>
      options.signal?.aborted === true && error instanceof Error && error.name === "AbortError";
    const client = this.client;
    if (!client || this.closed || !alive(client)) {
      let withdrawal: unknown;
      await this.call(async (c) => {
        try {
          await send(c as ReplyingClient);
        } catch (error) {
          if (!withdrawn(error)) throw error;
          withdrawal = error;
        }
      });
      if (withdrawal !== undefined) throw withdrawal;
      return;
    }
    try {
      await send(client as ReplyingClient);
    } catch (error) {
      if (!(error instanceof ThalovantRuntimeError) && !withdrawn(error))
        await this.exclusive(async () => {
          if (this.client === client) await this.drop();
        });
      throw error;
    }
  }
  /**
   * Stay connected until {@link close}, by the policy.
   *
   * A held link is looked at every `probeSeconds` -- and noticed within a
   * second when it drops -- and a failed attempt waits on the retry ladder
   * (`retrySeconds`, doubling to `retryCeilingSeconds`) before the next. A link
   * already held is the one kept; it is not dialled again. Each link this opens
   * must stay up for `settleSeconds`, because a hub that does not know the
   * client's static key says so only by closing right after the handshake.
   * Refusals are retried like any other failure until they have lasted
   * `refusalGraceSeconds` -- a new connection is refused until its hub admits
   * it -- and then this rejects with {@link ThalovantHubRefusedError}. A hub
   * whose Noise key is not the pinned one ends it at once with
   * {@link ThalovantHubKeyChangedError}: retrying cannot change that. The
   * decisions are {@link LinkSupervisor}'s.
   *
   * Resolves once the session is closed; rejects with an `AbortError` when
   * `signal` aborts, which stops keeping the link without closing it.
   */
  async run(options: { signal?: AbortSignal } = {}): Promise<void> {
    const signal = options.signal;
    const supervisor = new LinkSupervisor(this.policy);
    while (!this.closed) {
      if (signal?.aborted) throw abortError();
      let attempted = false;
      let failure: unknown;
      await this.exclusive(async () => {
        if (this.client && !alive(this.client)) {
          await this.drop();
          // A drop dials again at once: the ladder was reset when it came up.
          supervisor.after("dropped", this.clock());
        }
        if (this.client || this.closed || this.clock() < this.nextRetry) return;
        attempted = true;
        try {
          await this.ensure(true);
        } catch (error) {
          failure = error;
        }
      });
      if (attempted) {
        // The session's own ladder (nextRetry) moves in step with the
        // supervisor's: both start at retrySeconds, double on each failed
        // attempt and reset when the link comes up.
        const outcome = failure === undefined ? "up"
          : failure instanceof ThalovantHubKeyChangedError ? "key_changed"
          : failure instanceof ThalovantClientKeyRejectedError ? "client_key_rejected"
          : failure instanceof ThalovantHubRefusedError ? "refused"
          : "failed";
        const decision = supervisor.after(outcome, this.clock());
        if (decision.action === "give_up") throw failure;
      }
      if (this.closed) break;
      const held = this.client;
      if (held && alive(held)) {
        await this.pause(this.policy.probeSeconds, signal, held);
      } else {
        const untilRetry = Math.max(0, this.nextRetry - this.clock());
        await this.pause(Math.min(this.policy.probeDownSeconds, untilRetry), signal);
      }
    }
  }
  /** Wait `seconds`, until woken by close(), until `watch` dies, or until `signal` aborts. */
  private pause(seconds: number, signal?: AbortSignal, watch?: HubSessionClient): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const until = performance.now() + seconds * 1000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.wakers.delete(wake);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = (): void => finish(abortError());
      const wake = (): void => finish();
      const tick = (): void => {
        const left = until - performance.now();
        if (left <= 0 || this.closed || (watch && !alive(watch))) {
          finish();
          return;
        }
        timer = setTimeout(tick, Math.min(left, watch ? WATCH_MS : left, MAX_TIMER_MS));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.wakers.add(wake);
      tick();
    });
  }
  /** Terminal; waits for admitted work and reports cleanup failure. */
  close(): Promise<void> {
    this.closed = true;
    for (const wake of [...this.wakers]) wake();
    return this.exclusive(async () => {
      await this.drop();
      this.subscriptions.clear();
    });
  }
}

export function hubHostname(master: unknown): string {
  if (typeof master !== "string" || !master.trim()) return "";
  try {
    return new URL(master.includes("://") ? master : `wss://${master}`)
      .hostname;
  } catch {
    return "";
  }
}
export interface OriginAttempt {
  address?: string;
  host: string;
  handshakeSeconds?: number;
  connectTimeout: number;
}
/** The factory binds address on its own transport while retaining host for TLS/SNI.
 * No global DNS mutation. Browser factories may omit this optional optimization.
 */
export class OriginPreference {
  private quietUntil = 0;
  constructor(
    readonly address: string,
    readonly handshakeSeconds = 1.5,
    readonly cooldownSeconds = 300,
    private readonly clock: () => number = () => performance.now() / 1000,
  ) {
    if (
      ![handshakeSeconds, cooldownSeconds].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new RangeError("Origin budgets must be positive and finite");
  }
  get coolingDown(): boolean {
    return this.clock() < this.quietUntil;
  }
  async connect<T>(
    build: (attempt: OriginAttempt) => Promise<T>,
    options: {
      host: string;
      connectTimeout: number;
      handshakeSeconds?: number;
    },
  ): Promise<T> {
    if (this.address && options.host && !this.coolingDown) {
      try {
        const client = await build({
          ...options,
          address: this.address,
          handshakeSeconds: this.handshakeSeconds,
        });
        this.quietUntil = 0;
        return client;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "AbortError"
        )
          throw error;
        this.quietUntil = this.clock() + this.cooldownSeconds;
      }
    }
    // The factory owns cleanup of any failed attempt before rejecting.
    return build(options);
  }
}
