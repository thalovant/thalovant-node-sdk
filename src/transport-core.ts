import { base64FromUtf8, bytesToHex, hexToBytes, utf8Decode, utf8Encode } from "./bytes.js";
import { DEFAULT_USER_AGENT } from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";
import {
  buildPrologue,
  canonicalJson,
  derivePsk,
  NOISE_PATTERN_KK,
  NoiseHandshake,
  NoiseSession,
  noiseProtocolName,
  selectNoiseOptions,
} from "./noise.js";
import { forgetNoisePin, loadNoisePin, loadOrCreateNoiseKey, pinHubKey } from "./noise-store.js";
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
    const base = this.identity.endpointBase();
    // TLS is the only confidentiality on this path. The identity crypto key
    // that once sealed HTTP payloads separately is gone with v3, so a plain
    // http:// hub would put every message, and the access key in the
    // authorization query, on the wire in the clear.
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new ThalovantConnectionError(`The HTTP transport needs a valid https:// endpoint; got ${base}.`);
    }
    if (parsed.protocol !== "https:") {
      throw new ThalovantConnectionError(
        `Refusing to use the HTTP transport over ${parsed.protocol}//. It needs an https:// endpoint: without TLS every message and the access key travel in the clear.`,
      );
    }
    return base;
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
    const message = decodeRawHiveMessage(raw);
    if (message.msg_type === "handshake" || message.msg_type === "shake") {
      await this.handleHandshake(message.payload);
    } else if (message.msg_type === "bus") {
      this.dispatchEvent(new CustomEvent<BusPayload>("bus", { detail: message.payload as unknown as BusPayload }));
    } else if (message.msg_type === "query" || message.msg_type === "cascade") {
      this.dispatchEvent(new CustomEvent<HiveMessage>(message.msg_type, { detail: message }));
    }
  }

  /**
   * Complete the HTTP handshake.
   *
   * HTTP runs no Noise session: it authenticates with the identity credentials
   * and takes its confidentiality from TLS, so there is no key exchange here.
   */
  protected async handleHandshake(payload: Record<string, unknown>): Promise<void> {
    if (!payload.handshake && !payload.envelope) {
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
    throw new ThalovantConnectionError("Unexpected HiveMind HTTP handshake envelope.");
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

  async sendHiveMessage(message: HiveMessage, _encrypt = true): Promise<void> {
    const payload = JSON.stringify(message);
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

  /**
   * Where the Noise static key and the pin file live. Undefined uses the
   * platform default: beside the SDK config file in Node, a `localStorage`
   * namespace in a browser.
   */
  private readonly noiseStateDir?: string;

  /**
   * The hub's cleartext HELLO payload, kept verbatim because it is bound into
   * the Noise prologue rather than read for the node id alone.
   */
  private serverHello?: Record<string, unknown>;
  private nodeId = "";
  private noiseHandshake?: NoiseHandshake;
  private session?: NoiseSession;

  /**
   * Deriving the pre-shared key costs 64 MiB and a few hundred milliseconds,
   * and the result is fixed for a (password, node id) pair, so a reconnect to
   * the same hub reuses it.
   */
  private cachedPsk?: { nodeId: string; psk: Uint8Array };

  /**
   * Serializes sends. Encrypting a message advances the cipher state nonce
   * counter, so two concurrent callers must not interleave: the hub decrypts
   * strictly in counter order and would reject the second message onward.
   */
  private sendChain: Promise<void> = Promise.resolve();

  constructor(
    identity: ThalovantIdentity,
    options: { userAgent?: string; pollIntervalMs?: number; sendTimeoutMs?: number; noiseStateDir?: string } = {},
  ) {
    super(identity, options);
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10000;
    this.noiseStateDir = options.noiseStateDir;
  }

  /**
   * The hub's Noise static public key for the current session, hex encoded.
   * Undefined before the handshake completes.
   */
  get remoteStaticKey(): string | undefined {
    return this.session?.remoteStaticKey;
  }

  get endpoint(): string {
    const endpoint = this.identity.endpointFor("wss");
    if (!endpoint) {
      throw new ThalovantConnectionError("The identity does not include a WSS endpoint.");
    }
    return authorizedUrl(endpoint, this.authorization, "wss");
  }

  /**
   * @param timeoutMs budget for the whole connect. The first handshake with a
   *   hub runs argon2id at 64 MiB, which costs a few hundred milliseconds on
   *   top of the round trips, so the default is generous rather than tight.
   */
  override async connect(timeoutMs = 20000): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    if (!this.identity.password) {
      throw new ThalovantConnectionError(
        "The v3 Noise handshake derives its pre-shared key from the identity password, which is missing.",
      );
    }
    this.beginConnection();
    this.serverHello = undefined;
    this.nodeId = "";
    this.noiseHandshake = undefined;
    this.session = undefined;
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
    this.session = undefined;
    this.noiseHandshake = undefined;
    this.serverHello = undefined;
    this.nodeId = "";
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

  /**
   * Handle one websocket message.
   *
   * Before the Noise session exists the frames are cleartext JSON handshake
   * traffic. After it they are Noise transport messages, and the plaintext
   * underneath is what gets parsed.
   */
  protected override async handleRawMessage(raw: unknown): Promise<void> {
    let decoded = raw;

    if (this.session) {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      if (!(bytes instanceof Uint8Array)) {
        throw new ThalovantConnectionError("A text frame arrived on an established v3 Noise session.");
      }
      const frame = this.session.decryptFrame(bytes);
      if (!frame.complete) return;
      if (!frame.isJson) {
        // A HIVEMIND-WIRE-1 binary frame. The Node SDK does not decode binary
        // bus payloads on this transport yet, so it is dropped rather than
        // mis-parsed as JSON.
        return;
      }
      decoded = utf8Decode(frame.payload);
    }

    const message = decodeRawHiveMessage(decoded);
    if (message.msg_type === "hello") {
      this.recordServerHello(message.payload);
      return;
    }
    if (message.msg_type === "handshake" || message.msg_type === "shake") {
      await this.handleHandshake(message.payload);
      return;
    }
    if (message.msg_type === "bus") {
      this.dispatchEvent(new CustomEvent<BusPayload>("bus", { detail: message.payload as unknown as BusPayload }));
    } else if (message.msg_type === "query" || message.msg_type === "cascade") {
      this.dispatchEvent(new CustomEvent<HiveMessage>(message.msg_type, { detail: message }));
    }
  }

  /**
   * Record the hub's cleartext HELLO. Both its payload and the parameter
   * HANDSHAKE payload are bound into the Noise prologue, so it is kept whole
   * rather than reduced to the node id.
   */
  private recordServerHello(payload: Record<string, unknown>): void {
    if (this.session || this.serverHello) return;
    this.serverHello = payload;
    this.nodeId = typeof payload.node_id === "string" ? payload.node_id : "";
  }

  protected override async handleHandshake(payload: Record<string, unknown>): Promise<void> {
    const noiseParams = payload.noise as Record<string, unknown> | undefined;
    if (!noiseParams || typeof noiseParams !== "object") {
      throw new ThalovantConnectionError(
        "This hub did not offer the v3 Noise handshake; the SDK requires a hub running HiveMind-core 5.x or newer.",
      );
    }
    if (typeof noiseParams.msg === "string") {
      await this.continueNoiseHandshake(noiseParams);
      return;
    }
    await this.startNoiseHandshake(payload, noiseParams);
  }

  /**
   * Select a pattern and suite, bind the negotiation into the prologue, and
   * send Noise message 1.
   */
  private async startNoiseHandshake(
    handshakePayload: Record<string, unknown>,
    noiseParams: Record<string, unknown>,
  ): Promise<void> {
    if (!this.nodeId) {
      throw new ThalovantConnectionError(
        "The hub sent its HANDSHAKE parameters before a HELLO carrying node_id.",
      );
    }
    const pinned = await loadNoisePin(this.noiseStateDir, this.nodeId);
    const selection = selectNoiseOptions(stringList(noiseParams.patterns), stringList(noiseParams.suites), pinned);
    if (!selection) {
      throw new ThalovantConnectionError(
        "No Noise pattern and suite this SDK supports are on offer from the hub.",
      );
    }

    const protocolName = noiseProtocolName(selection.pattern, selection.suite);
    const prologue = buildPrologue(this.serverHello ?? {}, handshakePayload, protocolName);
    const staticKey = await loadOrCreateNoiseKey(this.noiseStateDir);
    const psk = this.pskFor(this.nodeId);

    this.noiseHandshake = new NoiseHandshake(
      selection.pattern,
      selection.suite,
      psk,
      prologue,
      staticKey,
      pinned ? hexToBytes(pinned) : undefined,
    );

    // Message 1 carries this node's binarize capability and its
    // preference-ordered encodings, canonicalized so both peers hash the same
    // bytes.
    const message = this.noiseHandshake.writeMessage(
      utf8Encode(canonicalJson({ binarize: false, encodings: [] })),
    );
    await this.sendCleartext({
      msg_type: "shake",
      payload: { noise: { pattern: selection.pattern, suite: selection.suite, msg: bytesToHex(message) } },
      metadata: {},
      route: [],
    });
  }

  /**
   * Consume the hub's Noise message, send the final one where the pattern needs
   * it, and bring the transport up.
   */
  private async continueNoiseHandshake(noiseParams: Record<string, unknown>): Promise<void> {
    const handshake = this.noiseHandshake;
    if (!handshake) {
      throw new ThalovantConnectionError("The hub sent a Noise handshake message before its parameters.");
    }

    try {
      handshake.readMessage(hexToBytes(String(noiseParams.msg)));
    } catch (error) {
      // KKpsk0 needs each side to hold the other's static key, but the client
      // chose it knowing only that it had pinned the hub's. The failure is as
      // likely to mean the hub no longer has this client's, so drop the pin and
      // let the next attempt fall back to XXpsk2.
      if (handshake.pattern === NOISE_PATTERN_KK) {
        await forgetNoisePin(this.noiseStateDir, this.nodeId).catch(() => undefined);
      }
      throw error;
    }

    if (!handshake.isFinished) {
      // XXpsk2 message 3: our encrypted static key and the final DH mix. The
      // pattern and suite are named only on message 1.
      const final = handshake.writeMessage();
      await this.sendCleartext({
        msg_type: "shake",
        payload: { noise: { msg: bytesToHex(final) } },
        metadata: {},
        route: [],
      });
    }

    const session = handshake.intoSession();
    if (session.remoteStaticKey) {
      await pinHubKey(this.noiseStateDir, this.nodeId, session.remoteStaticKey);
    }
    this.session = session;
    this.noiseHandshake = undefined;

    // The first Noise transport message is the encrypted HELLO.
    await this.sendHiveMessage({
      msg_type: "hello",
      payload: {
        pubkey: this.identity.publicKey ?? "",
        session: { session_id: `thalovant-node-${randomUUID()}` },
        site_id: this.identity.siteId,
      },
      metadata: {},
      route: [],
    });
    this.completeHandshake();
  }

  /** Derive, or reuse, the pre-shared key for a hub. */
  private pskFor(nodeId: string): Uint8Array {
    if (this.cachedPsk?.nodeId === nodeId) return this.cachedPsk.psk;
    const psk = derivePsk(this.identity.password ?? "", nodeId);
    this.cachedPsk = { nodeId, psk };
    return psk;
  }

  /**
   * Write a handshake message as a cleartext JSON text frame. Only the
   * handshake exchange travels this way; everything after it goes through the
   * Noise session.
   */
  private async sendCleartext(message: HiveMessage): Promise<void> {
    const socket = this.socket;
    if (!socket?.isOpen) {
      throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    }
    await sendSocketPayload(socket, JSON.stringify(message), this.sendTimeoutMs);
  }

  override async sendHiveMessage(message: HiveMessage, _encrypt = true): Promise<void> {
    const socket = this.socket;
    if (!socket?.isOpen) {
      throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    }
    const session = this.session;
    if (!session) {
      throw new ThalovantConnectionError("Refusing to send before the v3 Noise session is established.");
    }
    // Sealing and sending happen inside the chain so a concurrent caller
    // cannot slip a frame between this message's chunks, and cannot seal its
    // own message against a counter this one has already moved past.
    const serialized = utf8Encode(JSON.stringify(message));
    const send = this.sendChain.then(async () => {
      for (const frame of session.encryptMessage(serialized, true)) {
        await sendSocketPayload(socket, frame, this.sendTimeoutMs);
      }
    });
    // Keep the chain alive after a failed send: a rejected link would reject
    // every later send with the same stale error.
    this.sendChain = send.catch(() => undefined);
    return send;
  }
}

/** The string entries of a JSON array, ignoring anything else in it. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
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

function decodeRawHiveMessage(raw: unknown): HiveMessage {
  if (raw instanceof ArrayBuffer) {
    raw = new Uint8Array(raw);
  }
  if (raw instanceof Uint8Array) {
    try {
      return JSON.parse(utf8Decode(raw)) as HiveMessage;
    } catch {
      // MQTT delivers HiveMind binary frames rather than JSON text.
    }
    return decodeHiveBinaryFrame(raw) as HiveMessage;
  }
  if (typeof raw === "string") {
    return JSON.parse(raw) as HiveMessage;
  }
  return raw as HiveMessage;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
