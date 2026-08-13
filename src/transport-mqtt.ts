/**
 * HiveMind MQTT transport. Node-only: browser bundles substitute
 * `./transport-mqtt.browser.js` (see the `browser` map in package.json), whose
 * exports throw a descriptive "not available in browsers" error instead of
 * dragging the `mqtt` package into web bundles.
 */
import { createHash } from "node:crypto";
import { connect as mqttConnect, type IClientOptions, type MqttClient } from "mqtt";

import { ThalovantConnectionError } from "./errors.js";
import { encryptAsBinary } from "./crypto.js";
import { ThalovantIdentity } from "./identity.js";
import { randomUUID } from "./platform/node.js";
import { HiveMessage, HiveMindHttpTransport, TransportHealth } from "./transport-core.js";
import { encodeHiveBinaryFrame } from "./wire.js";

export interface MqttTopicSet {
  c2s: string;
  s2c: string;
  status: string;
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
      await mqttSubscribe(client, this.topics.s2c, credentials.qos);
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
    await mqttPublish(client, this.topics.c2s, toNodeBuffer(payload), {
      qos: this.identity.mqtt?.qos ?? 1,
      retain: false,
    });
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

function toNodeBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
