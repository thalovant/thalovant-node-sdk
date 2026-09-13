import {
  ThalovantClient,
  ThalovantSubscription,
  type EventHandler,
} from "./client.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";

/** Seconds, using a monotonic clock. Explicit probes let the host own scheduling. */
export class HubSessionPolicy {
  constructor(
    readonly retrySeconds = 10,
    readonly retryCeilingSeconds = 120,
    readonly probeSeconds = 60,
    readonly probeDownSeconds = 5,
  ) {
    if (
      ![
        retrySeconds,
        retryCeilingSeconds,
        probeSeconds,
        probeDownSeconds,
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
export type HubSessionClient = Pick<
  ThalovantClient,
  "ask" | "emit" | "on" | "connectionInfo" | "close"
>;
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
/** One owned connection. Failed calls are never replayed; Ask may trigger actions. */
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
  readonly policy: HubSessionPolicy;
  private readonly clock: () => number;
  constructor(
    private readonly connect: () => Promise<HubSessionClient>,
    options: {
      policy?: HubSessionPolicy;
      clock?: () => number;
      warm?: boolean;
    } = {},
  ) {
    this.policy = options.policy ?? new HubSessionPolicy();
    this.clock = options.clock ?? (() => performance.now() / 1000);
    this.wait = this.policy.retrySeconds;
    if (options.warm !== false) void this.warm();
  }
  get held(): boolean {
    return this.client !== undefined;
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
    }
    for (const entry of this.subscriptions.values()) {
      entry.bound?.close();
      entry.bound = undefined;
    }
    await this.cleanup();
  }
  private async ensure(): Promise<HubSessionClient> {
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
        this.client = fresh;
        this.nextRetry = 0;
        this.wait = this.policy.retrySeconds;
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
  /** Terminal; waits for admitted work and reports cleanup failure. */
  close(): Promise<void> {
    this.closed = true;
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
