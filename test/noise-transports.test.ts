import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IClientOptions, MqttClient } from "mqtt";
import { base64ToBytes, bytesToBase64, hexToBytes } from "../src/bytes.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HiveMindHttpTransport } from "../src/transport-core.js";
import { HiveMindMqttTransport } from "../src/transport-mqtt.js";
import { loadNoisePin } from "../src/noise-store.js";
import { createV3HubPeer, V3_HUB_NODE_ID } from "./v3-hub.js";

const password = "local-conformance-password";
const serverKey = new Uint8Array(32).fill(7);

function identity(): ThalovantIdentity {
  return new ThalovantIdentity({
    access_key: "local-conformance-key", password, site_id: "conformance", default_master: "https://hub.test", default_port: 443,
    data_plane_endpoints: { https: "https://hub.test" },
    mqtt: { endpoint: "mqtts://broker.test", username: "client", password: "broker-password", topic_prefix: "hivemind/test/client", tls: true },
  });
}

test("HTTP negotiates Noise, carries only encrypted bus frames, preserves cookie and reconnects with KK", async t => {
  const state = await mkdtemp(join(tmpdir(), "sdk-http-noise-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let clear: string[] = [], binary: string[] = [];
  let peer: ReturnType<typeof createV3HubPeer>;
  let pinnedClientKey: Uint8Array | undefined;
  const patterns: string[] = [];
  const received: string[] = [];
  let cookieRequests = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const response = (body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { headers });
    if (path === "/connect") {
      clear = []; binary = [];
      peer = createV3HubPeer(password, (data, encrypted) => {
        if (encrypted) binary.push(bytesToBase64(data as Uint8Array));
        else clear.push(String(data));
      }, { staticPrivateKey: serverKey, pinnedClientKey });
      peer.start();
      return response({ status: "Connected" }, { "set-cookie": "hivemind_http_replica=test-replica; Secure; HttpOnly" });
    }
    assert.equal(new Headers(init?.headers).get("cookie"), "hivemind_http_replica=test-replica");
    cookieRequests++;
    if (path === "/get_messages") { const messages = clear.splice(0); return response({ messages }); }
    if (path === "/get_binary_messages") { const b64_messages = binary.splice(0); return response({ b64_messages }); }
    if (path === "/disconnect") return response({ status: "Disconnected" });
    assert.equal(path, "/send_message");
    const form = new URLSearchParams(String(init?.body));
    const message = form.get("message")!;
    if (form.get("binary") === "1") {
      peer.onMessage(base64ToBytes(message));
      const latest = peer.received.at(-1);
      if (latest && !received.includes(latest)) {
        received.push(latest);
        const decoded = JSON.parse(latest);
        if (decoded.msg_type === "bus") peer.sendBus({ type: "speak", data: { utterance: "reply" }, context: decoded.payload.context });
      }
    } else {
      const decoded = JSON.parse(message);
      assert.equal(decoded.msg_type, "shake", "application traffic must never use plaintext HTTP");
      if (decoded.payload.noise.pattern) patterns.push(decoded.payload.noise.pattern);
      peer.onMessage(message);
    }
    if (peer.clientStaticKey) pinnedClientKey = hexToBytes(peer.clientStaticKey);
    return response({ status: "message sent" });
  };
  const transport = new HiveMindHttpTransport(identity(), { noiseStateDir: state, pollIntervalMs: 5 });
  t.after(() => transport.disconnect());
  for (let attempt = 0; attempt < 2; attempt++) {
    await transport.connect(20000);
    assert.equal(transport.healthcheck().handshakeComplete, true);
    const responses: string[] = [];
    const handler = (event: Event) => responses.push((event as CustomEvent).detail.context.request_id);
    transport.addEventListener("bus", handler);
    await Promise.all([0, 1, 2].map(n => transport.emitBus("ovos.intent.list", { large: "x".repeat(70000) }, { request_id: `${attempt}-${n}` })));
    const deadline = Date.now() + 1000;
    while (responses.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(responses, [0, 1, 2].map(n => `${attempt}-${n}`));
    transport.removeEventListener("bus", handler);
    await transport.disconnect();
  }
  assert.deepEqual(patterns, ["XXpsk2", "KKpsk0"]);
  assert.ok(cookieRequests > 10);
});

test("HTTP rejects a non-Noise offer and an HTTP-200 application error without claiming ready", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const errorBody of [false, true]) {
    globalThis.fetch = async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/connect") return new Response(JSON.stringify(errorBody ? { error: "denied" } : { status: "Connected" }));
      if (path === "/disconnect") return new Response(JSON.stringify({ status: "Disconnected" }));
      return new Response(JSON.stringify({ messages: [JSON.stringify({ msg_type: "shake", payload: { preshared_key: true } })] }));
    };
    const transport = new HiveMindHttpTransport(identity());
    await assert.rejects(transport.connect(500), /Noise|rejected/);
    assert.equal(transport.healthcheck().connected, false);
    assert.equal(transport.healthcheck().handshakeComplete, false);
  }
});

class Broker extends EventEmitter {
  connected = true;
  peer?: ReturnType<typeof createV3HubPeer>;
  pinnedClientKey?: Uint8Array;
  patterns: string[] = [];
  received: string[] = [];
  start(): void {
    this.peer = createV3HubPeer(password, data => queueMicrotask(() => this.emit("message", "hivemind/test/client/out", Buffer.from(data))),
      { staticPrivateKey: serverKey, pinnedClientKey: this.pinnedClientKey });
  }
  subscribe(_topic: string, _options: unknown, callback: (error?: Error) => void): void { callback(); }
  publish(topic: string, payload: string | Buffer, _options: unknown, callback: (error?: Error) => void): void {
    try {
      if (topic.endsWith("/in")) {
        if (typeof payload === "string") {
          const message = JSON.parse(payload);
          if (message.msg_type === "hello") this.peer!.start();
          else {
            if (message.payload.noise.pattern) this.patterns.push(message.payload.noise.pattern);
            this.peer!.onMessage(payload);
          }
        } else {
          this.peer!.onMessage(payload);
          const latest = this.peer!.received.at(-1);
          if (latest && !this.received.includes(latest)) {
            this.received.push(latest);
            const message = JSON.parse(latest);
            if (message.msg_type === "bus") this.peer!.sendBus({ type: "speak", data: {}, context: message.payload.context });
          }
        }
        if (this.peer!.clientStaticKey) this.pinnedClientKey = hexToBytes(this.peer!.clientStaticKey);
      }
      callback();
    } catch (error) { callback(error as Error); }
  }
  end(_force: boolean): void { this.connected = false; }
}

test("MQTT exchanges raw Noise frames and reauthenticates after broker reconnection", { timeout: 30000 }, async t => {
  const state = await mkdtemp(join(tmpdir(), "sdk-mqtt-noise-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const broker = new Broker();
  class Transport extends HiveMindMqttTransport {
    protected override createMqttClient(_endpoint: string, _options: IClientOptions): MqttClient {
      broker.start();
      queueMicrotask(() => broker.emit("connect"));
      return broker as unknown as MqttClient;
    }
  }
  const transport = new Transport(identity(), { noiseStateDir: state });
  t.after(() => transport.disconnect());
  await transport.connect(20000);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      broker.emit("close");
      assert.equal(transport.healthcheck().handshakeComplete, false);
      broker.start();
      broker.emit("connect");
      const deadline = Date.now() + 20000;
      while (!transport.healthcheck().handshakeComplete && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(transport.healthcheck().handshakeComplete, true);
    const reply = new Promise<string>(resolve => transport.addEventListener("bus", event => resolve((event as CustomEvent).detail.context.request_id), { once: true }));
    await transport.emitBus("ovos.intent.list", {}, { request_id: `mqtt-${attempt}` });
    assert.equal(await reply, `mqtt-${attempt}`);
  }
  assert.deepEqual(broker.patterns, ["XXpsk2", "KKpsk0"]);
  const pinned = await loadNoisePin(state, V3_HUB_NODE_ID);
  assert.ok(pinned);
  broker.emit("message", "hivemind/test/client/out", Buffer.from("plaintext after Noise"));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(transport.healthcheck().handshakeComplete, false);
  assert.equal(await loadNoisePin(state, V3_HUB_NODE_ID), pinned, "authentication errors must not erase trust");
});
