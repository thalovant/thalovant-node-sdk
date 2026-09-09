import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { base64ToBytes, bytesToBase64, hexToBytes } from "../src/bytes.js";
import { ThalovantClient } from "../src/client.js";
import { ThalovantConnectionError, ThalovantRuntimeError } from "../src/errors.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HiveMindHttpTransport } from "../src/transport-core.js";
import { createV3HubPeer } from "./v3-hub.js";

type Cleanup = "success" | "http-error" | "refusal" | "invalid-ack" | "network" | "invalid-json" | "already-disconnected" | "not-connected"
  | "success-false" | "already-disconnected-false" | "already-disconnected-connected" | "not-connected-false" | "not-connected-connected";
const responseSecret = "synthetic-response-sentinel";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

/** Real Noise exchange over a controlled HTTP boundary; the peer keeps failed admissions. */
async function fixture(t: TestContext, rejectHandshake = false) {
  const directory = await mkdtemp(join(tmpdir(), "sdk-http-cleanup-"));
  const identity = new ThalovantIdentity({ key: "synthetic-admission-sentinel", password: "local-conformance-password", host: "https://cleanup.invalid", site: "test" });
  const transport = new HiveMindHttpTransport(identity, { noiseStateDir: directory, pollIntervalMs: 10000 });
  const client = new ThalovantClient(identity, { transport });
  const state = { cleanup: "success" as Cleanup, admitted: false, admissions: 0, disconnects: 0, hold: undefined as ReturnType<typeof deferred> | undefined };
  let clear: string[] = [], binary: string[] = [];
  let peer: ReturnType<typeof createV3HubPeer>;
  let pinnedClientKey: Uint8Array | undefined;
  const cookies: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    if (path === "/connect") {
      assert.equal(state.admitted, false, "replacement must not overlap retained remote admission");
      if (state.admissions) assert.equal(cookie, "hivemind_http_replica=cleanup-replica");
      state.admissions++; state.admitted = true;
      clear = []; binary = [];
      if (!rejectHandshake) {
        peer = createV3HubPeer(identity.password!, (data, encrypted) => {
          if (encrypted) binary.push(bytesToBase64(data as Uint8Array));
          else clear.push(String(data));
        }, { staticPrivateKey: new Uint8Array(32).fill(7), pinnedClientKey });
        peer.start();
      }
      return Response.json({ status: "Connected" }, { headers: { "set-cookie": "hivemind_http_replica=cleanup-replica; Secure; HttpOnly" } });
    }
    assert.equal(cookie, "hivemind_http_replica=cleanup-replica");
    if (path === "/get_messages") return Response.json({ messages: rejectHandshake ? [JSON.stringify({ msg_type: "shake", payload: { max_protocol_version: 2 } })] : clear.splice(0) });
    if (path === "/get_binary_messages") return Response.json({ b64_messages: binary.splice(0) });
    if (path === "/disconnect") {
      state.disconnects++; cookies.push(cookie);
      if (state.hold) await state.hold.promise;
      if (state.cleanup === "http-error") return new Response(responseSecret, { status: 503 });
      if (state.cleanup === "refusal") return Response.json({ error: responseSecret });
      if (state.cleanup === "invalid-ack") return Response.json({ unrelated: responseSecret });
      if (state.cleanup === "network") throw new TypeError(`network failed: ${String(input)}`, { cause: new Error(responseSecret) });
      if (state.cleanup === "invalid-json") return new Response(`{"secret":"${responseSecret}"`);
      if (state.cleanup === "success-false") return Response.json({ status: "Disconnected", ok: false });
      if (state.cleanup === "already-disconnected-false") return Response.json({ error: "Already Disconnected", ok: false });
      if (state.cleanup === "already-disconnected-connected") return Response.json({ error: "Already Disconnected", status: "Connected" });
      if (state.cleanup === "not-connected-false") return Response.json({ error: "Client is not connected", ok: false });
      if (state.cleanup === "not-connected-connected") return Response.json({ error: "Client is not connected", status: "Connected" });
      state.admitted = false;
      if (state.cleanup === "already-disconnected") return Response.json({ error: "Already Disconnected" });
      if (state.cleanup === "not-connected") return Response.json({ error: "Client is not connected" });
      return Response.json({ status: "Disconnected" });
    }
    assert.equal(path, "/send_message");
    const form = new URLSearchParams(String(init?.body));
    peer.onMessage(form.get("binary") === "1" ? base64ToBytes(form.get("message")!) : form.get("message")!);
    if (peer.clientStaticKey) pinnedClientKey = hexToBytes(peer.clientStaticKey);
    return Response.json({ status: "message sent" });
  });
  t.after(async () => {
    state.cleanup = "success"; state.hold?.resolve(); state.hold = undefined;
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { client, transport, state, cookies };
}

for (const failure of ["http-error", "refusal", "invalid-ack", "network", "invalid-json", "success-false", "already-disconnected-false", "already-disconnected-connected", "not-connected-false", "not-connected-connected"] as const) {
  test(`HTTP ${failure} cleanup rejects close and waitForClosed safely, retains affinity and can retry`, async t => {
    const { client, transport, state, cookies } = await fixture(t);
    await client.connect(20000);
    state.cleanup = failure;
    let failureError: unknown;
    await assert.rejects(client.close(), error => {
      failureError = error;
      assert.ok(error instanceof ThalovantConnectionError || error instanceof ThalovantRuntimeError);
      return true;
    });
    await assert.rejects(client.waitForClosed(), error => error === failureError);
    assert.equal(state.admitted, true);
    assert.equal(client.connectionInfo().phase, "error");
    const diagnostic = inspect({ failureError, health: client.healthcheck() }, { depth: 10 });
    for (const secret of [responseSecret, transport.authorization, "authorization=", "synthetic-admission-sentinel"]) assert.ok(!diagnostic.includes(secret), secret);
    await assert.rejects(client.connect(200), /HTTP/);
    assert.equal(state.admissions, 1, "failed cleanup must be retried before a new /connect");
    state.cleanup = "success";
    await client.close();
    await client.waitForClosed();
    assert.equal(state.admitted, false);
    assert.equal(client.connectionInfo().phase, "closed");
    await client.connect(20000);
    assert.equal(state.admissions, 2);
    assert.equal(client.healthcheck().handshakeComplete, true);
    assert.ok(cookies.length >= 3);
  });
}

test("HTTP close timeout retains pending cleanup and later refusal instead of admitting a queued replacement", async t => {
  const { client, state } = await fixture(t);
  await client.connect(20000);
  state.cleanup = "refusal"; state.hold = deferred();
  await assert.rejects(client.close(20), /close did not complete/);
  const actualCleanup = client.waitForClosed();
  const refused = assert.rejects(actualCleanup, ThalovantRuntimeError);
  await assert.rejects(client.connect(20), ThalovantConnectionError);
  assert.equal(state.admissions, 1);
  state.hold.resolve(); state.hold = undefined;
  await refused;
  await assert.rejects(client.waitForClosed(), ThalovantRuntimeError);
  assert.equal(state.admitted, true);
  assert.equal(client.connectionInfo().phase, "error");
  state.cleanup = "success";
  await client.close();
  await client.connect(20000);
  assert.equal(state.admissions, 2);
});

test("HTTP handshake failure remains primary when its bounded cleanup also fails", async t => {
  const { transport, state } = await fixture(t, true);
  state.cleanup = "refusal";
  await assert.rejects(transport.connect(200), /Noise/);
  assert.equal(state.admitted, true);
  await assert.rejects(transport.disconnect(), ThalovantRuntimeError);
  assert.equal(transport.connectionInfo().phase, "error");
  state.cleanup = "success";
  await transport.disconnect();
  assert.equal(state.admitted, false);
  assert.equal(state.disconnects, 3);
});

for (const response of ["already-disconnected", "not-connected"] as const) {
  test(`HTTP ${response} cleanup acknowledgment releases retained admission`, async t => {
    const { client, state } = await fixture(t);
    await client.connect(20000);
    state.cleanup = response;
    await client.close();
    await client.waitForClosed();
    assert.equal(state.admitted, false);
    await client.connect(20000);
    assert.equal(state.admissions, 2);
  });
}
