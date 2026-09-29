/**
 * A hub's Noise responder behind the HTTPS polling and MQTT carriers, for
 * `link-carrier-vectors.json`.
 *
 * `CarrierPeer` answers the negotiation the way hivemind-core does: HELLO and
 * the offer, the Noise responder (KK with the pinned client key, XX
 * otherwise), the pin of the client's key on first contact, and an abort --
 * nothing sent, the session dropped -- on a first message it cannot read, a
 * final message that does not authenticate, or a client key that contradicts
 * the pin. `httpsHub()` serves it the way hivemind-http-protocol does, through
 * a `fetch` double, and answers every request of an aborted session with 401,
 * as the hub's listener refuses a session it no longer holds. `MqttBroker`
 * stands in for the `mqtt` client and a broker: MQTT has no refusal of its own
 * to relay, so an aborted session just stops answering.
 *
 * The same responder as the Python reference's `tests/carrier_hub.py`.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

import { utf8Decode, utf8Encode } from "../src/bytes.js";
import {
  buildPrologue,
  canonicalJson,
  derivePsk,
  NoiseHandshake,
  NoiseSession,
  NOISE_PATTERN_KK,
  NOISE_PATTERN_XX,
  noiseProtocolName,
} from "../src/noise.js";
import { ThalovantIdentity } from "../src/identity.js";

export const CARRIER_PASSWORD = "synthetic-carrier-password";
const SUITES = ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"];

type Send = (data: string | Uint8Array) => void;

export class CarrierPeer {
  password = CARRIER_PASSWORD;
  staticKey: Uint8Array = Uint8Array.from(randomBytes(32));
  offerKk = true;
  /** Flip a byte of the hub's KK answer, so it does not authenticate at the client. */
  tamperKkAnswer = false;
  pinnedClient?: string;
  readonly patterns: string[] = [];
  aborted = false;
  session?: NoiseSession;
  private handshake?: NoiseHandshake;
  private hello: Record<string, unknown> = {};
  private offer: Record<string, unknown> = {};

  constructor(private readonly send: Send, private readonly nodeId = "carrier-hub") {}

  /** A new session: HELLO and the offer, cleartext. */
  begin(): void {
    this.aborted = false;
    this.session = undefined;
    this.handshake = undefined;
    const patterns = this.pinnedClient && this.offerKk ? [NOISE_PATTERN_KK, NOISE_PATTERN_XX] : [NOISE_PATTERN_XX];
    this.hello = { node_id: this.nodeId, pubkey: "" };
    this.offer = { max_protocol_version: 3, binarize: false, encodings: [], noise: { patterns, suites: SUITES } };
    this.send(JSON.stringify({ msg_type: "hello", payload: this.hello, metadata: {} }));
    this.send(JSON.stringify({ msg_type: "shake", payload: this.offer, metadata: {} }));
  }

  receive(raw: string | Uint8Array): void {
    if (this.aborted) return;
    if (this.session) {
      if (typeof raw !== "string") this.session.decryptFrame(raw);
      return;
    }
    const message = JSON.parse(typeof raw === "string" ? raw : utf8Decode(raw)) as {
      msg_type?: string;
      payload?: { noise?: { pattern?: string; suite?: string; msg?: string } };
    };
    if (message.msg_type === "hello") return; // the client's cleartext HELLO: begin() answered it
    const noise = message.payload?.noise;
    if (!noise?.msg) return;
    try {
      if (noise.pattern) this.first(noise.pattern, noise.suite ?? SUITES[0], noise.msg);
      else {
        this.handshake!.readMessage(Buffer.from(noise.msg, "hex"));
        this.finish();
      }
    } catch {
      this.abort();
    }
  }

  /** Send one encrypted bus frame on the live session: the hub has spoken. */
  speak(): void {
    for (const frame of this.session!.encryptMessage(utf8Encode(JSON.stringify({ msg_type: "bus", payload: { type: "hub.ready", data: {}, context: {} } })), true)) {
      this.send(frame);
    }
  }

  private first(pattern: string, suite: string, msg: string): void {
    this.patterns.push(pattern.slice(0, 2));
    const prologue = buildPrologue(this.hello, this.offer, noiseProtocolName(pattern, suite));
    this.handshake = new NoiseHandshake(
      pattern,
      suite,
      derivePsk(this.password, this.nodeId),
      prologue,
      this.staticKey,
      pattern === NOISE_PATTERN_KK && this.pinnedClient ? Uint8Array.from(Buffer.from(this.pinnedClient, "hex")) : undefined,
      false,
    );
    this.handshake.readMessage(Buffer.from(msg, "hex"));
    const answer = this.handshake.writeMessage(utf8Encode(canonicalJson({ encoding: "JSON-HEX" })));
    if (this.tamperKkAnswer && pattern === NOISE_PATTERN_KK) answer[answer.length - 1] ^= 0x01;
    this.send(JSON.stringify({ msg_type: "shake", payload: { noise: { msg: Buffer.from(answer).toString("hex") } }, metadata: {} }));
    if (this.handshake.isFinished) this.finish();
  }

  private finish(): void {
    const session = this.handshake!.intoSession();
    const clientKey = session.remoteStaticKey?.toLowerCase();
    if (this.pinnedClient && clientKey !== this.pinnedClient) {
      this.abort(); // "client Noise static key contradicts pinned key"
      return;
    }
    this.pinnedClient = clientKey;
    this.session = session;
  }

  private abort(): void {
    this.aborted = true;
    this.session = undefined;
    this.handshake = undefined;
  }
}

/** A hivemind-http-protocol listener in front of one `CarrierPeer`, as a `fetch` double. */
export function httpsHub(): { peer: CarrierPeer; fetch: typeof fetch; identity(): ThalovantIdentity } {
  let clear: string[] = [];
  let binary: string[] = [];
  const peer = new CarrierPeer((data) => {
    if (typeof data === "string") clear.push(data);
    else binary.push(Buffer.from(data).toString("base64"));
  });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchDouble = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/connect") {
      clear = [];
      binary = [];
      peer.begin();
      return reply({ status: "Connected" });
    }
    if (path === "/disconnect") return reply({ status: "Disconnected" });
    if (peer.aborted) return reply({ error: "Unauthorized" }, 401);
    if (path === "/get_messages") return reply({ messages: clear.splice(0) });
    if (path === "/get_binary_messages") return reply({ b64_messages: binary.splice(0) });
    const form = new URLSearchParams(String(init?.body));
    const message = form.get("message") ?? "";
    peer.receive(form.get("binary") === "1" ? Uint8Array.from(Buffer.from(message, "base64")) : message);
    return reply({ status: "message sent" });
  };
  return {
    peer,
    fetch: fetchDouble as typeof fetch,
    identity: () => new ThalovantIdentity({
      access_key: "synthetic-carrier-access",
      password: CARRIER_PASSWORD,
      site_id: "carrier",
      default_master: "https://hub.carrier.invalid",
      data_plane_endpoints: { https: "https://hub.carrier.invalid" },
    }),
  };
}

/** The `mqtt` client and a broker, in memory, in front of one `CarrierPeer`. */
export class MqttBroker {
  static readonly PREFIX = "hivemind/carrier";
  readonly peer: CarrierPeer;
  private client?: FakeMqttClient;

  constructor() {
    this.peer = new CarrierPeer((data) => {
      const client = this.client;
      const payload = Buffer.from(typeof data === "string" ? utf8Encode(data) : data);
      if (client) setTimeout(() => client.emit("message", `${MqttBroker.PREFIX}/out`, payload), 1);
    });
  }

  /** A new client connection, as `mqtt.connect()` makes one. */
  connect(): FakeMqttClient {
    const client = new FakeMqttClient(this);
    this.client = client;
    queueMicrotask(() => client.emit("connect"));
    return client;
  }

  publish(topic: string, payload: string | Buffer): void {
    if (!topic.endsWith("/in")) return;
    if (typeof payload !== "string" && this.peer.session) {
      this.peer.receive(Uint8Array.from(payload)); // transport frames are binary
      return;
    }
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    if ((JSON.parse(text) as { msg_type?: string }).msg_type === "hello") this.peer.begin(); // the cleartext HELLO opens a session
    else this.peer.receive(text);
  }

  release(client: FakeMqttClient): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.peer.session = undefined; // the hub forgets the session with the client
  }

  identity(): ThalovantIdentity {
    return new ThalovantIdentity({
      access_key: "synthetic-carrier-access",
      password: CARRIER_PASSWORD,
      site_id: "carrier",
      default_master: "https://broker.carrier.invalid",
      mqtt: {
        endpoint: "mqtts://broker.carrier.invalid:8883",
        username: "synthetic-mqtt",
        password: "synthetic-broker-password",
        tls: true,
        topic_prefix: MqttBroker.PREFIX,
      },
    });
  }
}

class FakeMqttClient extends EventEmitter {
  connected = true;

  constructor(private readonly broker: MqttBroker) {
    super();
  }

  subscribe(_topic: string, _options: unknown, callback: (error?: Error) => void): void {
    callback();
  }

  publish(topic: string, payload: string | Buffer, _options: unknown, callback: (error?: Error) => void): void {
    try {
      if (this.connected) this.broker.publish(topic, payload);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  end(_force?: boolean): void {
    this.connected = false;
    this.broker.release(this);
  }
}
