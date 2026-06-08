import { createHash, randomUUID } from "node:crypto";
import { connect as mqttConnect, type IClientOptions, type MqttClient } from "mqtt";
import WebSocket from "ws";

import { DEFAULT_USER_AGENT } from "./constants.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "./errors.js";
import { decryptFromJson, encryptAsJson, runtimeCryptoKey } from "./crypto.js";
import { BusPayload, EventContext } from "./events.js";
import { ThalovantIdentity } from "./identity.js";

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
}

export interface HiveMindRuntimeTransport extends EventTarget {
  connect(timeoutMs?: number): Promise<void>;
  disconnect(): Promise<void>;
  healthcheck(): TransportHealth;
  emitBus(eventType: string, data: Record<string, unknown>, context: EventContext): Promise<void>;
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
    const response = await fetch(`${this.baseUrl}/connect?authorization=${encodeURIComponent(this.authorization)}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new ThalovantConnectionError(`HiveMind HTTP connect failed: ${await response.text()}`);
    }
    this.connected = true;
    const deadline = Date.now() + timeoutMs;
    while (!this.handshakeComplete && Date.now() < deadline) {
      await this.pollOnce();
      if (!this.handshakeComplete) {
        await sleep(100);
      }
    }
    if (!this.handshakeComplete) {
      throw new ThalovantConnectionError("HiveMind HTTP handshake timed out.");
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
  }

  healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && Boolean(this.pollTimer),
      lastError: this.lastError?.message,
    };
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
    let decoded = raw;
    if (Buffer.isBuffer(raw)) {
      decoded = raw.toString("utf8");
    }
    if (typeof raw === "string") {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      decoded = "ciphertext" in parsed && this.identity.cryptoKey
        ? JSON.parse(decryptFromJson(this.identity.cryptoKey, parsed))
        : parsed;
    } else if (typeof raw === "object" && raw && "ciphertext" in raw && this.identity.cryptoKey) {
      decoded = JSON.parse(decryptFromJson(this.identity.cryptoKey, raw as Record<string, unknown>));
    }
    const message = decoded as HiveMessage;
    if (message.msg_type === "handshake") {
      await this.handleHandshake(message.payload);
    } else if (message.msg_type === "bus") {
      this.dispatchEvent(new CustomEvent<BusPayload>("bus", { detail: message.payload as unknown as BusPayload }));
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
      this.handshakeComplete = true;
      return;
    }
    throw new ThalovantConnectionError("Only HiveMind preshared-key HTTP handshakes are supported in this alpha.");
  }

  protected async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
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
  private socket?: WebSocket;

  get endpoint(): string {
    const endpoint = this.identity.endpointFor("wss");
    if (!endpoint) {
      throw new ThalovantConnectionError("The identity does not include a WSS endpoint.");
    }
    return authorizedUrl(endpoint, this.authorization, "wss");
  }

  override async connect(timeoutMs = 6000): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    socket.on("message", data => {
      this.handleRawMessage(data).catch((error: Error) => {
        this.lastError = error;
        this.connected = false;
      });
    });
    socket.on("close", () => {
      this.connected = false;
    });
    socket.on("error", error => {
      this.lastError = error;
      this.connected = false;
    });
    await waitForSocketOpen(socket, timeoutMs);
    this.connected = true;
    const deadline = Date.now() + timeoutMs;
    while (!this.handshakeComplete && Date.now() < deadline) {
      await sleep(100);
    }
    if (!this.handshakeComplete) {
      throw new ThalovantConnectionError("HiveMind WSS handshake timed out.");
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
  }

  override healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && this.socket?.readyState === WebSocket.OPEN,
      lastError: this.lastError?.message,
    };
  }

  protected override async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new ThalovantConnectionError("HiveMind WSS transport is not connected.");
    }
    const serialized = JSON.stringify(message);
    const payload = encrypt && this.handshakeComplete && this.identity.cryptoKey
      ? encryptAsJson(this.identity.cryptoKey, serialized)
      : serialized;
    socket.send(payload);
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
    const client = mqttConnect(credentials.endpoint, options);
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

    await waitForMqttConnect(client, timeoutMs);
    await mqttSubscribe(client, this.topics.s2c, this.identity.mqtt.qos);
    await mqttPublish(client, this.topics.status, "online", { qos: 1, retain: true });
    this.connected = true;
    await this.sendHiveMessage(this.helloMessage(), false);
    const deadline = Date.now() + timeoutMs;
    while (!this.handshakeComplete && Date.now() < deadline) {
      await sleep(100);
    }
    if (!this.handshakeComplete) {
      throw new ThalovantConnectionError("HiveMind MQTT handshake timed out.");
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
  }

  override healthcheck(): TransportHealth {
    return {
      connected: this.connected,
      handshakeComplete: this.handshakeComplete,
      transportAlive: this.connected && Boolean(this.client?.connected),
      lastError: this.lastError?.message,
    };
  }

  protected override async sendHiveMessage(message: HiveMessage, encrypt = true): Promise<void> {
    const client = this.client;
    if (!client?.connected) {
      throw new ThalovantConnectionError("HiveMind MQTT transport is not connected.");
    }
    const serialized = JSON.stringify(message);
    const payload = encrypt && this.handshakeComplete && this.identity.cryptoKey
      ? encryptAsJson(this.identity.cryptoKey, serialized)
      : serialized;
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
  } else if (credentials.hubId) {
    base = `hivemind/${credentials.hubId}`;
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
    const timer = setTimeout(() => reject(new ThalovantConnectionError("HiveMind WSS connect timed out.")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(new ThalovantConnectionError(`HiveMind WSS connect failed: ${error.message}`));
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

function mqttPublish(client: MqttClient, topic: string, payload: string, options: { qos: number; retain: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos: options.qos === 0 ? 0 : 1, retain: options.retain }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
