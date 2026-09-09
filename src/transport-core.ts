import { base64FromUtf8, base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8Decode, utf8Encode } from "./bytes.js";
import { DEFAULT_USER_AGENT } from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";
import {
  buildPrologue,
  canonicalJson,
  derivePskAsync,
  NoiseHandshake,
  NoiseSession,
  noiseProtocolName,
  selectNoiseOptions,
} from "./noise.js";
import {
  forgetCachedPsk,
  loadCachedPsk,
  loadNoisePin,
  loadOrCreateNoiseKey,
  pinHubKey,
  saveCachedPsk,
} from "./noise-store.js";
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
  private polling = false;
  private cookies = "";
  protected connectionEpoch = 0;
  private receiveChain: Promise<void> = Promise.resolve();
  protected readonly sendTimeoutMs: number;
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
  // Keyed on the password as well as the node id: a caller that swaps
  // `identity.password` and reconnects on this same transport would otherwise
  // be handed the PSK for the old one and fail the handshake. The password is
  // already in memory on the identity and is never written beside the key.
  private cachedPsk?: { nodeId: string; password: string; psk: Uint8Array };

  /**
   * Serializes sends. Encrypting a message advances the cipher state nonce
   * counter, so two concurrent callers must not interleave: the hub decrypts
   * strictly in counter order and would reject the second message onward.
   */
  private sendChain: Promise<void> = Promise.resolve();


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

  private connectionAttempt?: Promise<void>;
  private httpAdmitted = false;
  private httpCleanup?: Promise<void>;
  private pendingRequests = new Set<AbortController>();

  protected connectOnce(work: () => Promise<void>): Promise<void> {
    if (this.connectionAttempt) return this.connectionAttempt;
    const attempt = work();
    this.connectionAttempt = attempt;
    const clear = () => { if (this.connectionAttempt === attempt) this.connectionAttempt = undefined; };
    attempt.then(clear, clear);
    return attempt;
  }

  protected abandonConnectAttempt(): void { this.connectionAttempt = undefined; }

  protected assertConnection(epoch: number): void {
    if (epoch !== this.connectionEpoch) throw new ThalovantConnectionError("HiveMind connection changed during an operation.");
  }

  constructor(identity: ThalovantIdentity, options: { userAgent?: string; pollIntervalMs?: number; sendTimeoutMs?: number; noiseStateDir?: string } = {}) {
    super();
    this.identity = identity;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10000;
    this.noiseStateDir = options.noiseStateDir;
  }

  get baseUrl(): string {
    const base = this.identity.endpointBase();
    // TLS protects admission credentials; Noise protects runtime messages.
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new ThalovantConnectionError(`The HTTP transport needs a valid https:// endpoint; got ${base}.`);
    }
    if (parsed.protocol !== "https:") {
      throw new ThalovantConnectionError(
        `Refusing to use the HTTP transport over ${parsed.protocol}//. It needs an https:// endpoint: TLS is required for admission credentials.`,
      );
    }
    return base;
  }

  get authorization(): string {
    return base64FromUtf8(`${this.userAgent}:${this.identity.accessKey}`);
  }

  get remoteStaticKey(): string | undefined {
    return this.session?.remoteStaticKey;
  }

  async connect(timeoutMs = 20000): Promise<void> {
    return this.connectOnce(() => this.connectHttp(timeoutMs));
  }

  private async connectHttp(timeoutMs: number): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    const deadline = Date.now() + timeoutMs;
    // A caller may start reconnect without awaiting disconnect. Finish that
    // owned remote cleanup before admitting a replacement session.
    if (this.httpCleanup) {
      const previousEpoch = this.connectionEpoch;
      await this.httpCleanup.catch(() => undefined);
      this.assertConnection(previousEpoch);
    }
    this.beginConnection();
    const epoch = this.connectionEpoch;
    try {
      if (this.httpAdmitted) await this.cleanupHttpAdmission(deadline);
      this.assertConnection(epoch);
      // Track remote admission separately from Noise readiness: a failed poll or
      // send does not remove the access-key session retained by the HTTP plugin.
      await this.httpRequest("/connect", { method: "POST" }, deadline);
      this.assertConnection(epoch);
      this.httpAdmitted = true;
      this.markTransportOpen();
      this.connected = true;
      while (!this.handshakeComplete && Date.now() < deadline) {
        await this.pollOnce(deadline);
        this.assertConnection(epoch);
        if (!this.handshakeComplete) await sleep(50);
        this.assertConnection(epoch);
      }
      if (!this.handshakeComplete) throw new ThalovantConnectionError("HiveMind HTTP Noise handshake timed out.");
      this.startPolling();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new ThalovantConnectionError("HiveMind HTTP connection failed.");
      if (epoch === this.connectionEpoch) {
        const cleanup = this.disconnect();
        const cleanupEpoch = this.connectionEpoch;
        await cleanup;
        if (cleanupEpoch === this.connectionEpoch) this.failConnection(error);
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.abandonConnectAttempt();
    this.clearNoiseState();
    const epoch = this.connectionEpoch;
    this.connected = false;
    this.handshakeComplete = false;
    if (this.httpAdmitted) await this.cleanupHttpAdmission().catch(() => undefined);
    if (epoch === this.connectionEpoch) {
      // Keep replica affinity across reconnects: another replica may still
      // own an older admission for this identity.
      this.markClosed();
    }
  }

  private cleanupHttpAdmission(deadline?: number): Promise<void> {
    if (this.httpCleanup) return this.httpCleanup;
    const epoch = this.connectionEpoch;
    const work = this.httpRequest("/disconnect", { method: "POST" }, deadline).then(() => {
      this.assertConnection(epoch);
      this.httpAdmitted = false;
    });
    this.httpCleanup = work;
    const clear = () => { if (this.httpCleanup === work) this.httpCleanup = undefined; };
    void work.then(clear, clear);
    return work;
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
    const epoch = this.connectionEpoch;
    this.pollTimer = setInterval(() => {
      if (this.polling || epoch !== this.connectionEpoch) return;
      this.polling = true;
      this.pollOnce().catch((error: Error) => {
        if (epoch === this.connectionEpoch) {
          this.stopPolling();
          this.rejectHandshake(error);
        }
      }).finally(() => { if (epoch === this.connectionEpoch) this.polling = false; });
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async httpRequest(path: string, init: RequestInit = {}, deadline = Date.now() + this.sendTimeoutMs): Promise<Record<string, unknown>> {
    const epoch = this.connectionEpoch;
    const controller = new AbortController();
    this.pendingRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const headers = new Headers(init.headers);
      if (this.cookies) headers.set("cookie", this.cookies);
      const response = await fetch(`${this.baseUrl}${path}?authorization=${encodeURIComponent(this.authorization)}`, {
        ...init, headers, signal: controller.signal, credentials: "include", redirect: "error",
      });
      this.assertConnection(epoch);
      if (!response.ok) throw new ThalovantConnectionError(`HiveMind HTTP request failed (${response.status}).`);
      const cookieValues = response.headers?.getSetCookie?.() ?? [response.headers?.get("set-cookie") ?? ""];
      for (const value of cookieValues) {
        const cookie = value.split(";", 1)[0];
        if (epoch === this.connectionEpoch && cookie.startsWith("hivemind_http_replica=")) this.cookies = cookie;
      }
      const body = await response.json() as Record<string, unknown>;
      this.assertConnection(epoch);
      const alreadyDisconnected = path === "/disconnect" && body &&
        (body.error === "Already Disconnected" || body.error === "Client is not connected");
      if (!body || typeof body !== "object" || (body.error && !alreadyDisconnected)) throw new ThalovantRuntimeError("HiveMind HTTP rejected the request.");
      if (path === "/connect" && body.status !== "Connected") throw new ThalovantConnectionError("Invalid HiveMind HTTP admission response.");
      if (path === "/send_message" && !["message sent", "buffered"].includes(String(body.status))) throw new ThalovantConnectionError("Invalid HiveMind HTTP send response.");
      if (path === "/disconnect" && body.status !== "Disconnected" && !alreadyDisconnected) throw new ThalovantConnectionError("Invalid HiveMind HTTP disconnect response.");
      return body;
    } finally { clearTimeout(timer); this.pendingRequests.delete(controller); }
  }

  private async pollOnce(deadline?: number): Promise<void> {
    if (!this.connected) return;
    const epoch = this.connectionEpoch;
    const body = await this.httpRequest("/get_messages", {}, deadline);
    if (epoch !== this.connectionEpoch) return;
    if (!Array.isArray(body.messages)) throw new ThalovantConnectionError("Invalid HiveMind HTTP message response.");
    for (const raw of body.messages) {
      this.assertConnection(epoch);
      await this.receiveRawMessage(raw);
    }
    if (this.session) {
      const binary = await this.httpRequest("/get_binary_messages", {}, deadline);
      if (epoch !== this.connectionEpoch) return;
      if (!Array.isArray(binary.b64_messages)) throw new ThalovantConnectionError("Invalid HiveMind HTTP binary response.");
      for (const raw of binary.b64_messages) {
        this.assertConnection(epoch);
        if (typeof raw !== "string") throw new ThalovantConnectionError("Invalid HiveMind HTTP Noise frame.");
        await this.receiveRawMessage(base64ToBytes(raw));
      }
    }
  }

  protected receiveRawMessage(raw: unknown): Promise<void> {
    const epoch = this.connectionEpoch;
    const received = this.receiveChain.then(async () => {
      if (epoch === this.connectionEpoch) await this.handleRawMessage(raw);
    });
    this.receiveChain = received.catch(() => undefined);
    return received;
  }

  protected clearNoiseState(reason = new ThalovantConnectionError("HiveMind connection was closed or replaced.")): void {
    this.connectionEpoch++;
    this.polling = false;
    for (const controller of this.pendingRequests) controller.abort();
    this.pendingRequests.clear();
    for (const waiter of this.handshakeWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.handshakeWaiters.clear();
    this.session = undefined;
    this.noiseHandshake = undefined;
    this.serverHello = undefined;
    this.nodeId = "";
    this.sendChain = Promise.resolve();
    this.receiveChain = Promise.resolve();
  }

  /**
   * Handle one HiveMind frame after serial transport delivery.
   *
   * Before the Noise session exists the frames are cleartext JSON handshake
   * traffic. After it they are Noise transport messages, and the plaintext
   * underneath is what gets parsed.
   */
  protected async handleRawMessage(raw: unknown): Promise<void> {
    let decoded = raw;

    if (this.session) {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      if (!(bytes instanceof Uint8Array)) {
        throw new ThalovantConnectionError("A text frame arrived on an established v3 Noise session.");
      }
      const frame = this.session.decryptFrame(bytes);
      if (!frame.complete) return;
      decoded = frame.isJson ? utf8Decode(frame.payload) : frame.payload;
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
    if (!this.session) throw new ThalovantConnectionError("Application message arrived before Noise authentication.");
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

  protected async handleHandshake(payload: Record<string, unknown>): Promise<void> {
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
    const epoch = this.connectionEpoch;
    if (this.noiseHandshake || this.session) throw new ThalovantConnectionError("Duplicate Noise negotiation.");
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
    const psk = await this.pskFor(this.nodeId);

    if (epoch !== this.connectionEpoch || !this.connected) return;
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
    const epoch = this.connectionEpoch;
    const handshake = this.noiseHandshake;
    const nodeId = this.nodeId;
    if (!handshake) {
      throw new ThalovantConnectionError("The hub sent a Noise handshake message before its parameters.");
    }

    try {
      handshake.readMessage(hexToBytes(String(noiseParams.msg)));
    } catch (error) {
      // Authentication failure never erases a trusted server identity.
      // The PSK is the other thing this message authenticates, so a rejection
      // may mean the stored key came from a password that has since been
      // rotated. Drop it; the next attempt derives from the current one.
      this.cachedPsk = undefined;
      await forgetCachedPsk(this.noiseStateDir, nodeId).catch(() => undefined);
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

    this.assertConnection(epoch);
    const session = handshake.intoSession();
    if (session.remoteStaticKey) {
      await pinHubKey(this.noiseStateDir, nodeId, session.remoteStaticKey);
    }
    if (epoch !== this.connectionEpoch || !this.connected) return;
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
    if (epoch === this.connectionEpoch && this.connected) this.completeHandshake();
  }

  /** Derive, or reuse, the pre-shared key for a hub. */
  private async pskFor(nodeId: string): Promise<Uint8Array> {
    const password = this.identity.password ?? "";
    const derivedHereForThisHub = this.cachedPsk?.nodeId === nodeId;
    if (derivedHereForThisHub && this.cachedPsk?.password === password) {
      return this.cachedPsk.psk;
    }

    // On disk first: the derivation is argon2id at 64 MiB and its answer never
    // changes for a given password and hub, so a reconnect or a restart should
    // not pay for it again.
    //
    // Unless this transport already derived for this hub under a different
    // password -- then the stored key belongs to that one, and reading it back
    // would only return something known to be stale.
    const stored = derivedHereForThisHub
      ? undefined
      : await loadCachedPsk(this.noiseStateDir, nodeId);
    if (stored) {
      this.cachedPsk = { nodeId, password, psk: stored };
      return stored;
    }

    const psk = await derivePskAsync(password, nodeId);
    this.cachedPsk = { nodeId, password, psk };
    // Persisting is an optimisation, never a reason to fail the connection.
    await saveCachedPsk(this.noiseStateDir, nodeId, psk).catch(() => undefined);
    return psk;
  }

  protected beginConnection(): void {
    if (!this.identity.password) throw new ThalovantConnectionError("The v3 Noise handshake requires the identity password.");
    this.clearNoiseState();
    this.connected = false;
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
    this.failConnection(error);
    for (const waiter of this.handshakeWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.handshakeWaiters.clear();
  }

  protected failConnection(error: Error): void {
    this.connected = false;
    this.handshakeComplete = false;
    this.clearNoiseState(error);
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

  protected async sendCleartext(message: HiveMessage): Promise<void> {
    await this.httpRequest("/send_message", {
      method: "POST", body: new URLSearchParams({ message: JSON.stringify(message) }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  protected async sendNoiseFrame(frame: Uint8Array): Promise<void> {
    await this.httpRequest("/send_message", {
      method: "POST", body: new URLSearchParams({ message: bytesToBase64(frame), binary: "1" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  async sendHiveMessage(message: HiveMessage, _encrypt = true): Promise<void> {
    const session = this.session;
    if (!this.connected || !session) throw new ThalovantConnectionError("Refusing to send before the v3 Noise session is established.");
    const epoch = this.connectionEpoch;
    const serialized = utf8Encode(JSON.stringify(message));
    const send = this.sendChain.then(async () => {
      if (epoch !== this.connectionEpoch || session !== this.session) throw new ThalovantConnectionError("Noise session changed before send.");
      try {
        for (const frame of session.encryptMessage(serialized, true)) {
          this.assertConnection(epoch);
          if (session !== this.session) throw new ThalovantConnectionError("Noise session changed during send.");
          await this.sendNoiseFrame(frame);
          this.assertConnection(epoch);
        }
      } catch (error) {
        if (epoch === this.connectionEpoch) this.failConnection(error instanceof Error ? error : new Error("Noise send failed."));
        throw error;
      }
    });
    this.sendChain = send.catch(() => undefined);
    return send;
  }
}

export class HiveMindWSSTransport extends HiveMindHttpTransport {
  private socket?: PlatformWebSocket;

  constructor(
    identity: ThalovantIdentity,
    options: { userAgent?: string; pollIntervalMs?: number; sendTimeoutMs?: number; noiseStateDir?: string } = {},
  ) {
    super(identity, options);
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
    return this.connectOnce(() => this.connectWss(timeoutMs));
  }

  private async connectWss(timeoutMs: number): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    if (!this.identity.password) {
      throw new ThalovantConnectionError(
        "The v3 Noise handshake derives its pre-shared key from the identity password, which is missing.",
      );
    }
    const previous = this.socket;
    this.socket = undefined;
    previous?.terminate();
    this.beginConnection();
    const epoch = this.connectionEpoch;
    const deadline = Date.now() + timeoutMs;
    const socket = createPlatformWebSocket(this.endpoint);
    this.socket = socket;
    socket.onMessage(data => {
      if (socket !== this.socket) return;
      const receivedEpoch = this.connectionEpoch;
      this.receiveRawMessage(data).catch((error: Error) => {
        if (socket !== this.socket || receivedEpoch !== this.connectionEpoch) return;
        this.lastError = error;
        this.connected = false;
        this.rejectHandshake(error);
        socket.terminate();
      });
    });
    socket.onClose((code, reason) => {
      if (socket !== this.socket) return;
      this.connected = false;
      if (!this.handshakeComplete) {
        const suffix = reason ? `: ${reason}` : "";
        this.rejectHandshake(new ThalovantConnectionError(`HiveMind WSS closed before handshake completed (${code})${suffix}.`));
      } else {
        this.handshakeComplete = false;
        this.clearNoiseState();
        this.markClosed();
      }
    });
    socket.onError(error => {
      if (socket !== this.socket) return;
      this.lastError = error;
      this.connected = false;
      this.rejectHandshake(error);
    });
    try {
      await waitForSocketOpen(socket, timeoutMs);
      this.assertConnection(epoch);
      if (socket !== this.socket) throw new ThalovantConnectionError("HiveMind socket was replaced.");
      this.markTransportOpen({ socket: true });
      this.connected = true;
      await this.waitForHandshake(Math.max(1, deadline - Date.now()), "HiveMind WSS handshake timed out.");
      this.assertConnection(epoch);
    } catch (error) {
      socket.terminate();
      if (socket === this.socket && epoch === this.connectionEpoch) {
        this.connected = false;
        if (error instanceof Error) this.failConnection(error);
      }
      throw error;
    }
  }

  override async disconnect(): Promise<void> {
    this.abandonConnectAttempt();
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      if (socket.isOpen) socket.close();
      else socket.terminate();
    }
    this.connected = false;
    this.handshakeComplete = false;
    this.clearNoiseState();
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
   * Write a handshake message as a cleartext JSON text frame. Only the
   * handshake exchange travels this way; everything after it goes through the
   * Noise session.
   */
  protected override async sendCleartext(message: HiveMessage): Promise<void> {
    const socket = this.socket;
    if (!socket?.isOpen) {
      throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    }
    await sendSocketPayload(socket, JSON.stringify(message), this.sendTimeoutMs);
  }

  protected override async sendNoiseFrame(frame: Uint8Array): Promise<void> {
    const socket = this.socket;
    if (!socket?.isOpen) throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    await sendSocketPayload(socket, frame, this.sendTimeoutMs);
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
