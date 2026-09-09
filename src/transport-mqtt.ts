/**
 * HiveMind MQTT transport. Node-only: browser bundles substitute
 * `./transport-mqtt.browser.js` (see the `browser` map in package.json), whose
 * exports throw a descriptive "not available in browsers" error instead of
 * dragging the `mqtt` package into web bundles.
 */
import { connect as mqttConnect, type IClientOptions, type MqttClient } from "mqtt";

import { ThalovantConnectionError } from "./errors.js";
import { ThalovantIdentity } from "./identity.js";
import { randomUUID } from "./platform/node.js";
import { HiveMessage, HiveMindHttpTransport, TransportHealth } from "./transport-core.js";

export interface MqttTopicSet {
  inbound: string;
  outbound: string;
  status: string;
}

export class HiveMindMqttTransport extends HiveMindHttpTransport {
  readonly topics: MqttTopicSet;
  private client?: MqttClient;

  constructor(identity: ThalovantIdentity, options: { userAgent?: string; pollIntervalMs?: number; noiseStateDir?: string; sendTimeoutMs?: number } = {}) {
    super(identity, options);
    this.topics = mqttTopicsForIdentity(identity);
  }

  override async connect(timeoutMs = 20000): Promise<void> {
    if (this.connected && this.handshakeComplete) return;
    this.beginConnection();
    const credentials = this.identity.mqtt;
    if (!credentials) {
      throw new ThalovantConnectionError("The identity does not include MQTT broker credentials.");
    }
    // TLS authenticates the broker and protects its credentials; Noise protects hub traffic.
    if (!credentials.tls && !/^(mqtts|ssl|wss):$/.test(new URL(credentials.endpoint).protocol)) {
      throw new ThalovantConnectionError(
        "Refusing to connect to an MQTT broker without TLS. Use an mqtts:// endpoint, or set tls: true on the identity's mqtt block.",
      );
    }
    const options: IClientOptions = {
      username: credentials.username,
      password: credentials.password,
      clientId: `thalovant-${safeMqttClientId(randomUUID())}`,
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
    const client = this.createMqttClient(mqttConnectionEndpoint(credentials), options);
    this.client = client;
    client.on("message", (topic, payload) => {
      if (client !== this.client || topic !== this.topics.outbound) return;
      this.receiveRawMessage(payload).catch((error: Error) => {
        if (client !== this.client) return;
        this.rejectHandshake(error);
        client.end(true);
      });
    });
    client.on("close", () => {
      if (client !== this.client) return;
      this.rejectHandshake(new ThalovantConnectionError("HiveMind MQTT connection closed."));
    });
    client.on("error", error => {
      if (client === this.client) this.rejectHandshake(error);
    });
    let establishedOnce = false;
    client.on("connect", () => {
      if (!establishedOnce || client !== this.client) return;
      this.beginConnection();
      const epoch = this.connectionEpoch;
      this.establishSession(client, timeoutMs).catch((error: Error) => {
        if (client === this.client && epoch === this.connectionEpoch) {
          this.rejectHandshake(error);
          client.end(true);
        }
      });
    });

    try {
      await waitForMqttConnect(client, timeoutMs);
      await this.establishSession(client, timeoutMs);
      establishedOnce = true;
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
    this.clearNoiseState();
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

  protected createMqttClient(endpoint: string, options: IClientOptions): MqttClient {
    return mqttConnect(endpoint, options);
  }

  private async establishSession(client: MqttClient, timeoutMs: number): Promise<void> {
    const epoch = this.connectionEpoch;
    await mqttSubscribe(client, this.topics.outbound, this.identity.mqtt!.qos);
    if (client !== this.client || epoch !== this.connectionEpoch) throw new ThalovantConnectionError("MQTT connection changed during subscription.");
    this.markTransportOpen();
    this.connected = true;
    // A clear HELLO requests server admission; the application HELLO is sent
    // again encrypted only after the shared Noise exchange completes.
    await this.sendCleartext(this.helloMessage());
    await this.waitForHandshake(timeoutMs, "HiveMind MQTT Noise handshake timed out.");
    await mqttPublish(client, this.topics.status, "online", { qos: 1, retain: true });
  }

  protected override async sendCleartext(message: HiveMessage): Promise<void> {
    const client = this.client;
    if (!client?.connected) throw new ThalovantConnectionError("HiveMind MQTT transport is not connected.");
    await mqttPublish(client, this.topics.inbound, JSON.stringify(message), {
      qos: this.identity.mqtt?.qos ?? 1, retain: false,
    });
  }

  protected override async sendNoiseFrame(frame: Uint8Array): Promise<void> {
    const client = this.client;
    if (!client?.connected) throw new ThalovantConnectionError("HiveMind MQTT transport is not connected.");
    await mqttPublish(client, this.topics.inbound, toNodeBuffer(frame), {
      qos: this.identity.mqtt?.qos ?? 1, retain: false,
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
  // Trim surrounding whitespace before stripping "/", so a whitespace-only (or
  // slash-only) prefix collapses to "" and is rejected as missing below.
  const prefix = stripSlashes(credentials.topicPrefix?.trim());
  if (!prefix) {
    throw new ThalovantConnectionError("MQTT credentials must include topic_prefix.");
  }
  assertTopicPrefixCharacters(prefix);
  return {
    inbound: `${prefix}/in`,
    outbound: `${prefix}/out`,
    status: `${prefix}/status`,
  };
}

export function mqttConnectionEndpoint(credentials: { endpoint: string; tls?: boolean }): string {
  const parsed = new URL(credentials.endpoint);
  if (credentials.tls && parsed.protocol === "mqtt:") {
    parsed.protocol = "mqtts:";
  }
  return parsed.toString().replace(/\/$/, "");
}

/** Trim only leading/trailing "/" without a regex; interior slashes are kept. */
function stripSlashes(value: string | undefined): string {
  if (!value) return "";
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") start++;
  while (end > start && value[end - 1] === "/") end--;
  return value.slice(start, end);
}

/**
 * Reject a `topic_prefix` that would corrupt the derived topics. `#` and `+`
 * are MQTT wildcards — a `+` prefix turns `<prefix>/out` into a wildcard
 * subscription and makes `<prefix>/in` an invalid publish topic name, and `#`
 * is invalid in both — while spaces and control characters (code point below
 * U+0020, which includes the MQTT-forbidden U+0000) have no place in the
 * `hivemind/<hub-id>/<access-key>` prefix. Implemented as a character scan,
 * never a regex, so CodeQL's `js/polynomial-redos` cannot flag it.
 */
function assertTopicPrefixCharacters(prefix: string): void {
  for (const char of prefix) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "#" || char === "+" || char === " " || code < 0x20) {
      throw new ThalovantConnectionError(
        "MQTT topic_prefix contains characters that are not valid in an MQTT topic.",
      );
    }
  }
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
    const timer = setTimeout(() => reject(new ThalovantConnectionError("MQTT subscription timed out.")), 10000);
    client.subscribe(topic, { qos: qos === 0 ? 0 : 1 }, error => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

function mqttPublish(client: MqttClient, topic: string, payload: string | Buffer, options: { qos: number; retain: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ThalovantConnectionError("MQTT publish timed out.")), 10000);
    client.publish(topic, payload, { qos: options.qos === 0 ? 0 : 1, retain: options.retain }, error => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
