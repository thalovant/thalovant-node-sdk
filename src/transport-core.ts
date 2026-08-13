import { base64FromUtf8, utf8Decode } from "./bytes.js";
import { DEFAULT_USER_AGENT } from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";
import { decryptBinaryAsync, decryptFromJsonAsync, encryptAsJsonAsync, runtimeCryptoKey } from "./crypto.js";
import { BusPayload, EventContext } from "./events.js";
import { ThalovantIdentity } from "./identity.js";
import { createPlatformWebSocket, randomUUID } from "./platform/node.js";
import type { PlatformWebSocket } from "./platform/types.js";
import { decodeHiveBinaryFrame } from "./wire.js";

export interface HiveMessage {
  msg_type: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  route?: unknown[];
  node?: string | null;
  target_site_id?: string | null;
  target_pubkey?: string | null;
  source_peer?: string | null;
}

export interface TransportHealth {
  connected: boolean;
  handshakeComplete: boolean;
  transportAlive: boolean;
  lastError?: string;
  connection?: TransportConnectionInfo;
}

export type TransportConnectionPhase = "idle" | "connecting" | "open" | "handshake" | "ready" | "closed" | "error";

export interface TransportConnectionInfo {
  phase: TransportConnectionPhase;
  startedAt?: string;
  connectedAt?: string;
  transportOpenMs?: number;
  socketOpenMs?: number;
  handshakeMs?: number;
  connectMs?: number;
  lastError?: string;
}

export interface HiveMindRuntimeTransport extends EventTarget {
  connect(timeoutMs?: number): Promise<void>;
  disconnect(): Promise<void>;
  healthcheck(): TransportHealth;
  connectionInfo?(): TransportConnectionInfo;
  emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void>;
  sendHiveMessage?(message: HiveMessage, encrypt?: boolean): Promise<void>;
}

export class HiveMindHttpTransport extends EventTarget {
  readonly identity: ThalovantIdentity;
  readonly userAgent: string;
  readonly pollIntervalMs: number;
  protected connected = false;
  protected handshakeComplete = false;
  private pollTimer?: ReturnType<typeof setInterval>;
  protected lastError?: Error;
  private connectStartedMs = 0;
  private transportOpenedMs = 0;
  private handshakeWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private currentConnection: TransportConnectionInfo = { phase: "idle" };

  constructor(identity: ThalovantIdentity, options: { userAgent?: string; pollIntervalMs?: number } = {}) {
    super();
    this.identity = identity;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
  }

  get baseUrl(): string {
    return this.identity.endpointBase();
  }

  get authorization(): string {
    return base64FromUtf8(`${this.userAgent}:${this.identity.accessKey}`);
  }

  async connect(timeoutMs = 6000): Promise<void> {
    this.beginConnection();
    const response = await fetch(`${this.baseUrl}/connect?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
    });
    if (!response.ok) {
      const error = new ThalovantConnectionError(`HiveMind HTTP connect failed: ${await response.text()}`);
      this.failConnection(error);
      throw error;
    }
    this.markTransportOpen();
    this.connected = true;
    const deadline = Date.now() + timeoutMs;
    while (!this.handshakeComplete && Date.now() < deadline) {
      await this.pollOnce();
      if (!this.handshakeComplete) {
        await sleep(100);
      }
    }
    if (!this.handshakeComplete) {
      const error = new ThalovantConnectionError("HiveMind HTTP handshake timed out.");
      this.failConnection(error);
      throw error;
    }
    this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (!this.connected) return;
    await fetch(`${this.baseUrl}/disconnect?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
    }).catch(() => undefined);
    this.connected = false;
    this.handshakeComplete = false;
    this.markClosed();
  }

  healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && Boolean(this.pollTimer),
      lastError: this.lastError?.message,
      connection: this.connectionInfo(),
    };
  }

  connectionInfo(): TransportConnectionInfo {
    return { ...this.currentConnection };
  }

  async emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
    await this.sendHiveMessage({
      msg_type: "bus",
      payload: { type: eventType, data, context },
      metadata: {},
      route: [],
      node: null,
      target_site_id: null,
      target_pubkey: null,
      source_peer: null,
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((error: Error) => {
      this.lastError = error;
      this.connected = false;
      this.rejectHandshake(error);
    });
  }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.connected) return;
    const response = await fetch(`${this.baseUrl}/get_messages?authorization=${encodeURIComponent(this.authorization)}`);
    const body = await response.json() as { error?: string; messages?: unknown[] };
    if (body.error) {
      throw new ThalovantRuntimeError(body.error);
    }
    for (const raw of body.messages ?? []) {
      await this.handleRawMessage(raw);
    }
  }

  protected async handleRawMessage(raw: unknown): Promise<void> {
    const message = await decodeRawHiveMessage(raw, this.identity.cryptoKey);
    if (message.msg_type === "handshake" || message.msg_type === "shake") {
      await this.handleHandshake(message.payload);
    } else if (message.msg_type === "bus") {
      this.dispatchEvent(new CustomEvent<BusPayload>("bus", { detail: message.payload as unknown as BusPayload }));
    } else if (message.msg_type === "query" || message.msg_type === "cascade") {
      this.dispatchEvent(new CustomEvent<HiveMessage>(message.msg_type, { detail: message }));
    }
  }

  protected async handleHandshake(payload: Record<string, unknown>): Promise<void> {
    if (payload.preshared_key && !payload.handshake && !payload.envelope) {
      if (!runtimeCryptoKey(this.identity.cryptoKey)) {
        throw new ThalovantConnectionError("HiveMind requested a preshared key, but identity.crypto_key is missing.");
      }
      await this.sendHiveMessage({
        msg_type: "hello",
        payload: {
          pubkey: this.identity.publicKey ?? "",
          session: { session_id: `thalovant-node-${randomUUID()}` },
          site_id: this.identity.siteId,
        },
        metadata: {},
        route: [],
        node: null,
        target_site_id: null,
        target_pubkey: null,
        source_peer: null,
      }, false);
      this.completeHandshake();
      return;
    }
    throw new ThalovantConnectionError("Only HiveMind preshared-key HTTP handshakes are supported in this alpha.");
  }

  protected beginConnection(): void {
    this.handshakeComplete = false;
    this.lastError = undefined;
    this.connectStartedMs = Date.now();
    this.transportOpenedMs = 0;
    this.currentConnection = {
      phase: "connecting",
      startedAt: new Date(this.connectStartedMs).toISOString(),
    };
  }

  protected markTransportOpen(options: { socket?: boolean } = {}): void {
    const now = Date.now();
    this.transportOpenedMs = now;
    const openMs = Math.max(0, now - this.connectStartedMs);
    this.currentConnection = {
      ...this.currentConnection,
      phase: "handshake",
      transportOpenMs: openMs,
      ...(options.socket ? { socketOpenMs: openMs } : {}),
    };
  }

  protected completeHandshake(): void {
    if (this.handshakeComplete) return;
    this.handshakeComplete = true;
    const now = Date.now();
    this.currentConnection = {
      ...this.currentConnection,
      phase: "ready",
      connectedAt: new Date(now).toISOString(),
      handshakeMs: Math.max(0, now - (this.transportOpenedMs || this.connectStartedMs)),
      connectMs: Math.max(0, now - this.connectStartedMs),
    };
    for (const waiter of this.handshakeWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.handshakeWaiters.clear();
  }

  protected waitForHandshake(timeoutMs: number, timeoutMessage: string): Promise<void> {
    if (this.handshakeComplete) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.handshakeWaiters.delete(waiter);
          const error = new ThalovantConnectionError(timeoutMessage);
          this.failConnection(error);
          reject(error);
        }, timeoutMs),
      };
      this.handshakeWaiters.add(waiter);
    });
  }

  protected rejectHandshake(error: Error): void {
    if (this.handshakeComplete) return;
    this.failConnection(error);
    for (const waiter of this.handshakeWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.handshakeWaiters.clear();
  }

  protected failConnection(error: Error): void {
    this.lastError = error;
    this.currentConnection = {
      ...this.currentConnection,
      phase: "error",
      lastError: error.message,
      connectMs: this.connectStartedMs ? Math.max(0, Date.now() - this.connectStartedMs) : undefined,
    };
  }

  protected markClosed(): void {
    this.currentConnection = {
      ...this.currentConnection,
      phase: "closed",
    };
  }

  async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const serialized = JSON.stringify(message);
    const payload = encrypt && this.handshakeComplete && this.identity.cryptoKey
      ? await encryptAsJsonAsync(this.identity.cryptoKey, serialized)
      : serialized;
    const response = await fetch(`${this.baseUrl}/send_message?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
      body: new URLSearchParams({ message: payload }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    if (!response.ok) {
      throw new ThalovantConnectionError(`HiveMind HTTP send failed: ${await response.text()}`);
    }
  }
}

export class HiveMindWSSTransport extends HiveMindHttpTransport {
  private readonly sendTimeoutMs: number;
  private socket?: PlatformWebSocket;

  constructor(identity: ThalovantIdentity, options: { userAgent?: string; pollIntervalMs?: number; sendTimeoutMs?: number } = {}) {
    super(identity, options);
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10000;
  }

  get endpoint(): string {
    const endpoint = this.identity.endpointFor("wss");
    if (!endpoint) {
      throw new ThalovantConnectionError("The identity does not include a WSS endpoint.");
    }
    return authorizedUrl(endpoint, this.authorization, "wss");
  }

  override async connect(timeoutMs = 6000): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    this.beginConnection();
    const socket = createPlatformWebSocket(this.endpoint);
    this.socket = socket;
    socket.onMessage(data => {
      this.handleRawMessage(data).catch((error: Error) => {
        this.lastError = error;
        this.connected = false;
        this.rejectHandshake(error);
      });
    });
    socket.onClose((code, reason) => {
      this.connected = false;
      if (!this.handshakeComplete) {
        const suffix = reason ? `: ${reason}` : "";
        this.rejectHandshake(new ThalovantConnectionError(`HiveMind WSS closed before handshake completed (${code})${suffix}.`));
      } else {
        this.markClosed();
      }
    });
    socket.onError(error => {
      this.lastError = error;
      this.connected = false;
      this.rejectHandshake(error);
    });
    try {
      await waitForSocketOpen(socket, timeoutMs);
      this.markTransportOpen({ socket: true });
      this.connected = true;
      await this.waitForHandshake(timeoutMs, "HiveMind WSS handshake timed out.");
    } catch (error) {
      socket.terminate();
      this.connected = false;
      if (error instanceof Error) {
        this.failConnection(error);
      }
      throw error;
    }
  }

  override async disconnect(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (socket?.isOpen) {
      socket.close();
    }
    this.connected = false;
    this.handshakeComplete = false;
    this.markClosed();
  }

  override healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && (this.socket?.isOpen ?? false),
      lastError: this.lastError?.message,
      connection: this.connectionInfo(),
    };
  }

  override async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const socket = this.socket;
    if (!socket?.isOpen) {
      throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    }
    const serialized = JSON.stringify(message);
    const payload = encrypt && this.handshakeComplete && this.identity.cryptoKey
      ? await encryptAsJsonAsync(this.identity.cryptoKey, serialized)
      : serialized;
    await sendSocketPayload(socket, payload, this.sendTimeoutMs);
  }
}

function authorizedUrl(endpoint: string, authorization: string, expected: "wss"): string {
  const parsed = new URL(endpoint);
  if (expected === "wss" && !["ws:", "wss:"].includes(parsed.protocol)) {
    throw new ThalovantConnectionError("WSS endpoint must start with ws:// or wss://.");
  }
  parsed.searchParams.delete("authorization");
  parsed.searchParams.set("authorization", authorization);
  return parsed.toString();
}

function waitForSocketOpen(socket: PlatformWebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      settle(() => reject(new ThalovantConnectionError("HiveMind WSS connect timed out.")));
    }, timeoutMs);
    socket.onOpen(() => settle(resolve));
    socket.onError(error => settle(() => reject(new ThalovantConnectionError(`HiveMind WSS connect failed: ${error.message}`))));
    socket.onClose((code, reason) => {
      const suffix = reason ? `: ${reason}` : "";
      settle(() => reject(new ThalovantConnectionError(`HiveMind WSS closed before opening (${code})${suffix}.`)));
    });
  });
}

function sendSocketPayload(socket: PlatformWebSocket, payload: string | Uint8Array, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new ThalovantConnectionError("HiveMind WSS send timed out."));
    }, timeoutMs);
    socket.send(payload).then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new ThalovantConnectionError(`HiveMind WSS send failed: ${error.message}`));
      },
    );
  });
}

async function decodeRawHiveMessage(raw: unknown, cryptoKey?: string): Promise<HiveMessage> {
  if (raw instanceof ArrayBuffer) {
    raw = new Uint8Array(raw);
  }
  if (raw instanceof Uint8Array) {
    const text = utf8Decode(raw);
    try {
      return await decodeTextHiveMessage(text, cryptoKey);
    } catch {
      // MQTT may deliver opaque encrypted binary frames.
    }
    if (cryptoKey) {
      try {
        return decodeHiveBinaryFrame(await decryptBinaryAsync(cryptoKey, raw)) as HiveMessage;
      } catch {
        // Fall through and try plaintext binary.
      }
    }
    return decodeHiveBinaryFrame(raw) as HiveMessage;
  }
  if (typeof raw === "string") {
    return decodeTextHiveMessage(raw, cryptoKey);
  }
  if (typeof raw === "object" && raw && "ciphertext" in raw && cryptoKey) {
    return JSON.parse(await decryptFromJsonAsync(cryptoKey, raw as Record<string, unknown>)) as HiveMessage;
  }
  return raw as HiveMessage;
}

async function decodeTextHiveMessage(raw: string, cryptoKey?: string): Promise<HiveMessage> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if ("ciphertext" in parsed && cryptoKey) {
    return JSON.parse(await decryptFromJsonAsync(cryptoKey, parsed)) as HiveMessage;
  }
  return parsed as unknown as HiveMessage;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
