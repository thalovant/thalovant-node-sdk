import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { IClientOptions, MqttClient } from "mqtt";
import { ThalovantIdentity } from "../src/identity.js";
import { HiveMindHttpTransport } from "../src/transport-core.js";
import { HiveMindMqttTransport } from "../src/transport-mqtt.js";

function identity(endpoint = "mqtts://broker.test", tls = true): ThalovantIdentity {
  return new ThalovantIdentity({
    access_key: "deadline-client", password: "deadline-fixture-password", site_id: "test", default_master: "https://hub.test",
    mqtt: { endpoint, username: "deadline-client", password: "broker-fixture-password", topic_prefix: "test/hub/client", tls },
  });
}

async function tick(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await setImmediate();
}

class DelayedBroker extends EventEmitter {
  connected = true;
  publishes: string[] = [];
  constructor(readonly stall: "subscribe" | "admission" | "handshake" | "online") { super(); }
  subscribe(_topic: string, _options: unknown, callback: () => void): void {
    if (this.stall !== "subscribe") setTimeout(callback, 25);
  }
  publish(topic: string, payload: string | Buffer, _options: unknown, callback: () => void): void {
    this.publishes.push(topic);
    if (topic.endsWith("/in") && this.stall === "admission") return;
    if (topic.endsWith("/status") && payload === "online" && this.stall === "online") return;
    setTimeout(callback, 25);
  }
  end(): void { this.connected = false; }
}

for (const stall of ["subscribe", "admission", "handshake", "online"] as const) {
  test(`MQTT connect deadline includes stalled ${stall} after earlier steps spend its budget`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const broker = new DelayedBroker(stall);
    class Transport extends HiveMindMqttTransport {
      protected override createMqttClient(): MqttClient {
        setTimeout(() => broker.emit("connect"), 25);
        return broker as unknown as MqttClient;
      }
      protected override async waitForHandshake(timeoutMs: number, message: string): Promise<void> {
        // Isolate the final presence acknowledgement from cryptographic work;
        // real XX/KK and encrypted HELLO coverage lives in noise-transports.test.
        if (stall === "online") { this.completeHandshake(); return; }
        return super.waitForHandshake(timeoutMs, message);
      }
    }
    const transport = new Transport(identity());
    let outcome: unknown;
    const connecting = transport.connect(100).then(() => { outcome = "resolved"; }, error => { outcome = error; });
    await tick(t, 25);
    await tick(t, 25);
    await tick(t, 25);
    assert.equal((() => outcome)(), undefined, "earlier steps have not exceeded the overall deadline");
    await tick(t, 25);
    assert.ok(outcome instanceof Error, "connect must reject by its deadline");
    await connecting;
    assert.match(outcome.message, /timed out/);
    assert.equal(transport.healthcheck().handshakeComplete, false);
    assert.equal(broker.connected, false, "timed-out attempt ends the broker connection");
    await tick(t, 10000);
    assert.equal(transport.healthcheck().handshakeComplete, false, "late callbacks cannot restore readiness");
  });
}

test("MQTT validates the effective URL before giving credentials to the connector", async () => {
  const accepted = [
    ["ws://broker.test/mqtt", true, "wss://broker.test/mqtt"],
    ["mqtt://broker.test:8883", true, "mqtts://broker.test:8883"],
    ["wss://broker.test/mqtt", false, "wss://broker.test/mqtt"],
    ["mqtts://broker.test", false, "mqtts://broker.test"],
    ["ssl://broker.test", false, "ssl://broker.test"],
  ] as const;
  for (const [endpoint, tls, expected] of accepted) {
    class Transport extends HiveMindMqttTransport {
      protected override createMqttClient(actual: string, options: IClientOptions): MqttClient {
        assert.equal(actual, expected);
        assert.equal(options.username, "deadline-client");
        throw new Error("secure connector reached");
      }
    }
    await assert.rejects(new Transport(identity(endpoint, tls)).connect(), /secure connector reached/);
  }
  for (const [endpoint, tls] of [["ws://broker.test/mqtt", false], ["mqtt://broker.test", false], ["http://broker.test", true], ["tcp://broker.test", true]] as const) {
    let connectorCalled = false;
    class Transport extends HiveMindMqttTransport {
      protected override createMqttClient(): MqttClient { connectorCalled = true; throw new Error("insecure connector called"); }
    }
    await assert.rejects(new Transport(identity(endpoint, tls)).connect(), /without TLS/);
    assert.equal(connectorCalled, false, "insecure transports must not receive broker credentials");
  }
});

function hangingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("HTTP failed-handshake cleanup expires within the connect deadline and retains admission ownership", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const calls: string[] = [];
  let hangCleanup = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === "/connect") return Response.json({ status: "Connected" });
    if (path === "/get_messages") {
      await new Promise(resolve => setTimeout(resolve, 50));
      return Response.json({ messages: [JSON.stringify({ msg_type: "shake", payload: { max_protocol_version: 2 } })] });
    }
    assert.equal(path, "/disconnect");
    if (hangCleanup) return hangingResponse(init?.signal);
    return Response.json({ status: "Disconnected" });
  });
  const transport = new HiveMindHttpTransport(identity(), { sendTimeoutMs: 10000 });
  let outcome: unknown;
  const connecting = transport.connect(100).catch(error => { outcome = error; });
  await setImmediate();
  await tick(t, 50);
  assert.equal(calls.at(-1), "/disconnect");
  await tick(t, 50);
  assert.ok(outcome instanceof Error, "connect cleanup must reject by its deadline");
  await connecting;
  assert.match(outcome.message, /Noise/);
  assert.equal(transport.healthcheck().connected, false);
  hangCleanup = false;
  await transport.disconnect();
  assert.equal(calls.filter(path => path === "/disconnect").length, 2, "failed cleanup remains owned for a later explicit retry");
});

test("HTTP reconnect bounds its wait on an earlier disconnect without opening another admission", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let admissions = 0;
  let releaseCleanup!: () => void;
  const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/connect") { admissions++; return Response.json({ status: "Connected" }); }
    if (path === "/get_messages") return Response.json({ messages: [JSON.stringify({ msg_type: "shake", payload: { max_protocol_version: 2 } })] });
    assert.equal(path, "/disconnect");
    await cleanupHeld;
    return Response.json({ status: "Disconnected" });
  });
  const transport = new HiveMindHttpTransport(identity());
  const first = transport.connect(10000).catch(() => undefined);
  await setImmediate();
  let outcome: unknown;
  const reconnect = transport.connect(100).catch(error => { outcome = error; });
  await tick(t, 100);
  assert.ok(outcome instanceof Error, "waiting for cleanup must respect the new deadline");
  await reconnect;
  assert.match(outcome.message, /waiting for disconnect/);
  assert.equal(admissions, 1);
  releaseCleanup();
  await first;
  await transport.disconnect();
});
