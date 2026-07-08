import { createHash, randomUUID } from "node:crypto";
import { connect as mqttConnect, type IClientOptions, type MqttClient } from "mqtt";
import WebSocket from "ws";

import { DEFAULT_USER_AGENT } from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";
import { decryptBinary, decryptFromJson, encryptAsBinary, encryptAsJson, runtimeCryptoKey } from "./crypto.js";
import { BusPayload, EventContext } from "./events.js";
import { ThalovantIdentity } from "./identity.js";
import { decodeHiveBinaryFrame, encodeHiveBinaryFrame } from "./wire.js";

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

export interface MqttTopicSet {
  c2s: string;
  s2c: string;
  status: string;
}

export class HiveMindHttpTransport extends EventTarget {
  readonly identity: ThalovantIdentity;
  readonly userAgent: string;
  readonly pollIntervalMs: number;
  protected connected = false;
  protected handshakeComplete = false;
  private pollTimer?: NodeJS.Timeout;
  protected lastError?: Error;
  private connectStartedMs = 0;
  private transportOpenedMs = 0;
  private handshakeWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
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
    return Buffer.from(`${this.userAgent}:${this.identity.accessKey}`, "utf8").toString("base64");
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
    const message = decodeRawHiveMessage(raw, this.identity.cryptoKey);
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
      ? encryptAsJson(this.identity.cryptoKey, serialized)
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
  private socket?: WebSocket;

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
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    socket.on("message", data => {
      this.handleRawMessage(data).catch((error: Error) => {
        this.lastError = error;
        this.connected = false;
        this.rejectHandshake(error);
      });
    });
    socket.on("close", (code, reason) => {
      this.connected = false;
      if (!this.handshakeComplete) {
        const suffix = reason.length ? `: ${reason.toString("utf8")}` : "";
        this.rejectHandshake(new ThalovantConnectionError(`HiveMind WSS closed before handshake completed (${code})${suffix}.`));
      } else {
        this.markClosed();
      }
    });
    socket.on("error", error => {
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
    if (socket && socket.readyState === WebSocket.OPEN) {
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
      transportAlive: this.connected && this.socket?.readyState === WebSocket.OPEN,
      lastError: this.lastError?.message,
      connection: this.connectionInfo(),
    };
  }

  override async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    }
    const serialized = JSON.stringify(message);
    const payload = encrypt && this.handshakeComplete && this.identity.cryptoKey
      ? encryptAsJson(this.identity.cryptoKey, serialized)
      : serialized;
    await sendSocketPayload(socket, payload, this.sendTimeoutMs);
  }
}

export class HiveMindMqttTransport extends HiveMindHttpTransport {
  readonly topics: MqttTopicSet;
  private client?: MqttClient;

  constructor(identity: ThalovantIdentity, options: { userAgent?: string; pollIntervalMs?: number } = {}) {
    super(identity, options);
    this.topics = mqttTopicsForIdentity(identity);
  }

  override async connect(timeoutMs = 6000): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    this.beginConnection();
    const credentials = this.identity.mqtt;
    if (!credentials) {
      throw new ThalovantConnectionError("The identity does not include MQTT broker credentials.");
    }
    const options: IClientOptions = {
      username: credentials.username,
      password: credentials.password,
      clientId: `thalovant-${safeMqttClientId(this.identity.accessKey)}`,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 1000,
      will: {
        topic: this.topics.status,
        payload: "offline",
        qos: 1,
        retain: true,
      },
    };
    const client = mqttConnect(mqttConnectionEndpoint(credentials), options);
    this.client = client;
    client.on("message", (_topic, payload) => {
      this.handleRawMessage(payload).catch((error: Error) => {
        this.lastError = error;
        this.connected = false;
      });
    });
    client.on("close", () => {
      this.connected = false;
    });
    client.on("error", error => {
      this.lastError = error;
    });

    try {
      await waitForMqttConnect(client, timeoutMs);
      await mqttSubscribe(client, this.topics.s2c, this.identity.mqtt.qos);
      await mqttPublish(client, this.topics.status, "online", { qos: 1, retain: true });
      this.connected = true;
      await this.sendHiveMessage(this.helloMessage());
      this.markTransportOpen();
      await this.waitForHandshake(timeoutMs, "HiveMind MQTT handshake timed out.");
    } catch (error) {
      client.end(true);
      this.connected = false;
      if (error instanceof Error) {
        this.failConnection(error);
      }
      throw error;
    }
  }

  override async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      await mqttPublish(client, this.topics.status, "offline", { qos: 1, retain: true }).catch(() => undefined);
      client.end(true);
    }
    this.connected = false;
    this.handshakeComplete = false;
    this.markClosed();
  }

  override healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && Boolean(this.client?.connected),
      lastError: this.lastError?.message,
      connection: this.connectionInfo(),
    };
  }

  override async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const client = this.client;
    if (!client?.connected) {
      throw new ThalovantConnectionError("HiveMind MQTT transport is not connected.");
    }
    let payload = encodeHiveBinaryFrame(message);
    if (this.identity.cryptoKey) {
      payload = encryptAsBinary(this.identity.cryptoKey, payload);
    }
    await mqttPublish(client, this.topics.c2s, payload, { qos: this.identity.mqtt?.qos ?? 1, retain: false });
  }

  private helloMessage(): HiveMessage {
    return {
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
    };
  }
}

export function mqttTopicsForIdentity(identity: ThalovantIdentity): MqttTopicSet {
  const credentials = identity.mqtt;
  if (!credentials) {
    throw new ThalovantConnectionError("The identity does not include MQTT broker credentials.");
  }
  const satelliteId = credentials.hashTopics
    ? createHash("sha256").update(identity.accessKey).digest("hex").slice(0, 16)
    : identity.accessKey;
  if (credentials.c2sTopic && credentials.s2cTopic) {
    return {
      c2s: credentials.c2sTopic,
      s2c: credentials.s2cTopic,
      status: credentials.statusTopic ?? siblingMqttTopic(credentials.c2sTopic, "status"),
    };
  }
  const raw = credentials.topicPrefix?.replace(/^\/+|\/+$/g, "");
  let base = "";
  if (raw) {
    if (raw.includes("/c2s/")) {
      return { c2s: raw, s2c: siblingMqttTopic(raw, "s2c"), status: siblingMqttTopic(raw, "status") };
    }
    if (raw.includes("/s2c/")) {
      return { c2s: siblingMqttTopic(raw, "c2s"), s2c: raw, status: siblingMqttTopic(raw, "status") };
    }
    if (raw.includes("/status/")) {
      return { c2s: siblingMqttTopic(raw, "c2s"), s2c: siblingMqttTopic(raw, "s2c"), status: raw };
    }
    const parts = raw.split("/").filter(Boolean);
    base = [identity.accessKey, credentials.username, satelliteId].includes(parts.at(-1) ?? "")
      ? parts.slice(0, -1).join("/")
      : parts.join("/");
    const hubId = credentials.hubId?.replace(/^\/+|\/+$/g, "");
    if (hubId && !base.split("/").includes(hubId)) {
      base = `${base}/${hubId}`;
    }
  } else if (credentials.hubId) {
    base = `hivemind/${credentials.hubId.replace(/^\/+|\/+$/g, "")}`;
  }
  if (!base) {
    throw new ThalovantConnectionError("MQTT credentials must include topic_prefix, hub_id, or explicit c2s/s2c topics.");
  }
  return {
    c2s: `${base}/c2s/${satelliteId}`,
    s2c: `${base}/s2c/${satelliteId}`,
    status: `${base}/status/${satelliteId}`,
  };
}

export function mqttConnectionEndpoint(credentials: { endpoint: string; tls?: boolean }): string {
  const parsed = new URL(credentials.endpoint);
  if (credentials.tls && parsed.protocol === "mqtt:") {
    parsed.protocol = "mqtts:";
  }
  return parsed.toString().replace(/\/$/, "");
}

function siblingMqttTopic(topic: string, segment: "c2s" | "s2c" | "status"): string {
  return topic.replace(/\/(?:c2s|s2c|status)\//, `/${segment}/`);
}

function safeMqttClientId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || randomUUID();
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

function waitForSocketOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onOpen = () => settle(resolve);
    const onError = (error: Error) => settle(() => reject(new ThalovantConnectionError(`HiveMind WSS connect failed: ${error.message}`)));
    const onClose = (code: number, reason: Buffer) => {
      const suffix = reason.length ? `: ${reason.toString("utf8")}` : "";
      settle(() => reject(new ThalovantConnectionError(`HiveMind WSS closed before opening (${code})${suffix}.`)));
    };
    const timer = setTimeout(() => {
      socket.terminate();
      settle(() => reject(new ThalovantConnectionError("HiveMind WSS connect timed out.")));
    }, timeoutMs);
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function sendSocketPayload(socket: WebSocket, payload: string | Buffer, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new ThalovantConnectionError("HiveMind WSS send timed out."));
    }, timeoutMs);
    socket.send(payload, error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(new ThalovantConnectionError(`HiveMind WSS send failed: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
}

function waitForMqttConnect(client: MqttClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ThalovantConnectionError("HiveMind MQTT connect timed out.")), timeoutMs);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("error", error => {
      clearTimeout(timer);
      reject(new ThalovantConnectionError(`HiveMind MQTT connect failed: ${error.message}`));
    });
  });
}

function mqttSubscribe(client: MqttClient, topic: string, qos: number): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: qos === 0 ? 0 : 1 }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function mqttPublish(client: MqttClient, topic: string, payload: string | Buffer, options: { qos: number; retain: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: options.qos === 0 ? 0 : 1, retain: options.retain }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function decodeRawHiveMessage(raw: unknown, cryptoKey?: string): HiveMessage {
  if (Buffer.isBuffer(raw)) {
    const text = raw.toString("utf8");
    try {
      return decodeTextHiveMessage(text, cryptoKey);
    } catch {
      // MQTT may deliver opaque encrypted binary frames.
    }
    if (cryptoKey) {
      try {
        return decodeHiveBinaryFrame(decryptBinary(cryptoKey, raw)) as HiveMessage;
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
    return JSON.parse(decryptFromJson(cryptoKey, raw as Record<string, unknown>)) as HiveMessage;
  }
  return raw as HiveMessage;
}

function decodeTextHiveMessage(raw: string, cryptoKey?: string): HiveMessage {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if ("ciphertext" in parsed && cryptoKey) {
    return JSON.parse(decryptFromJson(cryptoKey, parsed)) as HiveMessage;
  }
  return parsed as unknown as HiveMessage;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
