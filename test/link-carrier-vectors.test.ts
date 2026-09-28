/**
 * KK then XX on HTTPS polling and MQTT, against `link-carrier-vectors.json`.
 *
 * Each case runs one connect as a kept link makes it -- the handshake, then
 * the settle window -- through the SDK's real HTTP and MQTT transports, in
 * front of `carrier-hub.ts`'s responder: a hivemind-http-protocol listener
 * behind a `fetch` double, and an in-memory broker behind the `mqtt` client.
 * Vendored unchanged from the Python SDK's `contracts/conformance/`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HiveMindHttpTransport,
  HiveMindMqttTransport,
  HubSession,
  ThalovantClientKeyRejectedError,
  ThalovantConnectionError,
  ThalovantHubKeyChangedError,
  ThalovantHubRefusedError,
  ThalovantIdentity,
  ThalovantTimeoutError,
} from "../src/index.js";
import { httpsHub, MqttBroker, type CarrierPeer } from "./carrier-hub.js";
import { record } from "./conformance-record.js";

interface Case {
  name: string;
  carrier: "https" | "mqtt";
  situation: string;
  hub_offers_kk?: boolean;
  expect: { outcome: string; patterns: string[] };
}

const VECTORS = JSON.parse(readFileSync(new URL("../../test/link-carrier-vectors.json", import.meta.url), "utf8")) as {
  cases: Case[];
};
const SETTLE_MS = (JSON.parse(readFileSync(new URL("../../test/link-keeping-vectors.json", import.meta.url), "utf8")) as {
  policy: { settle_ms: number };
}).policy.settle_ms;

function outcomeOf(error: unknown): string {
  if (error === undefined) return "connected";
  if (error instanceof ThalovantClientKeyRejectedError) return "client_key_rejected";
  if (error instanceof ThalovantHubRefusedError) return "refused";
  if (error instanceof ThalovantHubKeyChangedError) return "key_changed";
  assert.ok(error instanceof ThalovantConnectionError || error instanceof ThalovantTimeoutError, String(error));
  return "failed";
}

/** One connect as a kept link makes it: the handshake, then the settle window. */
async function attempt(identity: ThalovantIdentity, protocol: "https" | "mqtt", noiseStateDir: string): Promise<unknown> {
  const session = HubSession.forIdentity(identity, {
    client: { protocol, noiseStateDir },
    warm: false,
    connectTimeoutMs: 10_000,
    settleSeconds: SETTLE_MS / 1000,
  });
  try {
    // What run() does for each attempt: connect, then hold the settle window.
    await (session as unknown as { ensure(settle: boolean): Promise<unknown> }).ensure(true);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await session.close();
  }
}

for (const vector of VECTORS.cases) {
  test(`carrier: ${vector.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "thalovant-link-carrier-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    let peer: CarrierPeer;
    let identity: ThalovantIdentity;
    if (vector.carrier === "https") {
      const hub = httpsHub();
      t.mock.method(globalThis, "fetch", hub.fetch);
      peer = hub.peer;
      identity = hub.identity();
    } else {
      const broker = new MqttBroker();
      t.mock.method(HiveMindMqttTransport.prototype as unknown as { createMqttClient(): unknown }, "createMqttClient", () => broker.connect());
      peer = broker.peer;
      identity = broker.identity();
    }
    let state = join(directory, "noise");
    const situation = vector.situation;
    if (["pinned", "password_changed_since_pinning", "hub_key_changed", "client_key_changed",
      "kk_answer_unauthenticated"].includes(situation)) {
      assert.equal(await attempt(identity, vector.carrier, state), undefined, "first contact pins both ways");
    }
    if (situation === "wrong_password") peer.password = "the-password-the-hub-holds";
    else if (situation === "password_changed_since_pinning") peer.password = "the-password-now";
    else if (situation === "hub_key_changed") {
      peer.staticKey = Uint8Array.from(randomBytes(32));
      peer.offerKk = vector.hub_offers_kk ?? true;
    } else if (situation === "client_key_changed") state = join(directory, "another-program");
    else if (situation === "kk_answer_unauthenticated") peer.tamperKkAnswer = true;
    const before = peer.patterns.length;
    const produced = {
      outcome: outcomeOf(await attempt(identity, vector.carrier, state)),
      patterns: peer.patterns.slice(before),
    };
    record("link-carrier-vectors.json", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

for (const spoke of [false, true]) {
  test(`over HTTPS, a poll answered 401 ${spoke ? "after the hub has spoken is not" : "before the hub said anything is"} a refusal of this client's key`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "thalovant-link-carrier-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const hub = httpsHub();
    t.mock.method(globalThis, "fetch", hub.fetch);
    const transport = new HiveMindHttpTransport(hub.identity(), { noiseStateDir: directory, pollIntervalMs: 5 });
    t.after(() => transport.disconnect());
    await transport.connect(10_000);
    if (spoke) {
      hub.peer.speak();
      const heard = new Promise((resolve) => transport.addEventListener("bus", resolve, { once: true }));
      await heard;
    }
    hub.peer.aborted = true; // the hub dropped the session: every request is answered 401 now
    const deadline = Date.now() + 5_000;
    while (transport.connectionInfo().phase !== "error" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const info = transport.connectionInfo();
    assert.equal(info.phase, "error");
    assert.equal(info.refused === true, !spoke);
    assert.equal(info.clientKeyRejected === true, !spoke, "the handshake was XX");
    if (!spoke) assert.equal(info.keyFolder, directory);
  });
}
