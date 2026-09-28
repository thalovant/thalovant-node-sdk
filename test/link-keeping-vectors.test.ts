/**
 * Keeping a hub link up, against `link-keeping-vectors.json`.
 *
 * `close` cases hold the pure close rule to the vectors. `handshake` cases run
 * a real Noise handshake over WSS against a loopback hub that fails the way
 * the case says -- another password, another static key, a refused upgrade --
 * and record the patterns the hub saw. `supervise` cases drive the supervisor
 * `HubSession.run()` asks after every attempt. Vendored unchanged from the
 * Python SDK's `contracts/conformance/`.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import {
  CLOSE_CODE_GRACE_MS,
  closeRefuses,
  HubSession,
  HubSessionPolicy,
  LinkSupervisor,
  REFUSAL_CLOSE_CODES,
  REFUSAL_SETTLE_MS,
  ThalovantClient,
  ThalovantConnectionError,
  ThalovantHubKeyChangedError,
  ThalovantHubRefusedError,
  ThalovantIdentity,
  type LinkOutcome,
} from "../src/index.js";
import { hexToBytes } from "../src/bytes.js";
import { HiveMindHttpTransport } from "../src/transport-core.js";
import { record } from "./conformance-record.js";
import { createV3HubPeer } from "./v3-hub.js";

type Json = Record<string, unknown>;

interface Case {
  name: string;
  kind: "close" | "handshake" | "supervise";
  when?: "handshake" | "after_handshake";
  after_ms?: number;
  code?: number | null;
  code_late_ms?: number;
  situation?: string;
  hub_offers_kk?: boolean;
  status?: number;
  events?: Array<{ at_ms: number; outcome: LinkOutcome }>;
  expect: unknown;
}

const VECTORS = JSON.parse(readFileSync(new URL("../../test/link-keeping-vectors.json", import.meta.url), "utf8")) as {
  policy: {
    retry_ms: number;
    retry_ceiling_ms: number;
    probe_ms: number;
    probe_down_ms: number;
    refusal_grace_ms: number;
    settle_ms: number;
    close_code_grace_ms: number;
    refusal_close_codes: number[];
  };
  cases: Case[];
};
const POLICY = VECTORS.policy;
const cases = (kind: Case["kind"]) => VECTORS.cases.filter((item) => item.kind === kind);

test("the policy is the SDK's", () => {
  const defaults = new HubSessionPolicy();
  assert.equal(defaults.retrySeconds * 1000, POLICY.retry_ms);
  assert.equal(defaults.retryCeilingSeconds * 1000, POLICY.retry_ceiling_ms);
  assert.equal(defaults.probeSeconds * 1000, POLICY.probe_ms);
  assert.equal(defaults.probeDownSeconds * 1000, POLICY.probe_down_ms);
  assert.equal(defaults.refusalGraceSeconds * 1000, POLICY.refusal_grace_ms);
  assert.equal(REFUSAL_SETTLE_MS, POLICY.settle_ms);
  assert.equal(CLOSE_CODE_GRACE_MS, POLICY.close_code_grace_ms);
  assert.deepEqual([...REFUSAL_CLOSE_CODES].sort(), POLICY.refusal_close_codes);
  assert.equal(new HubSession(async () => { throw new Error("unused"); }, { warm: false }).settleSeconds * 1000, POLICY.settle_ms);
});

for (const vector of cases("close")) {
  test(`close: ${vector.name}`, () => {
    const refused = closeRefuses(vector.code, {
      closedAfterHandshakeMs: vector.when === "after_handshake" ? vector.after_ms : undefined,
      codeLateMs: vector.code_late_ms ?? 0,
    });
    const produced = { outcome: refused ? "refused" : "dropped" };
    record("link-keeping-vectors.json", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

/**
 * A hub on a loopback WebSocket that runs the responder side of the v3 Noise
 * handshake. It pins the client's static key on first contact and offers KK
 * from then on (unless told not to), closes with no status when a handshake
 * message does not authenticate -- what hivemind-core does after a Noise
 * abort -- and records the pattern of every attempt.
 */
class LoopbackHub {
  password = "the-right-password";
  staticKey = Uint8Array.from(randomBytes(32));
  offerKk = true;
  upgradeStatus?: number;
  readonly patterns: string[] = [];
  private clientKey?: Uint8Array;
  private server?: WebSocketServer;

  async start(): Promise<void> {
    this.server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, done) => (this.upgradeStatus ? done(false, this.upgradeStatus) : done(true)),
    });
    await once(this.server, "listening");
    this.server.on("connection", (socket) => this.serve(socket));
  }

  async stop(): Promise<void> {
    for (const socket of this.server?.clients ?? []) socket.terminate();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  identity(password = this.password): ThalovantIdentity {
    return new ThalovantIdentity({
      access_key: "access",
      password,
      site_id: "home-assistant",
      default_master: `ws://127.0.0.1:${(this.server!.address() as AddressInfo).port}`,
    });
  }

  private serve(socket: WebSocket): void {
    const peer = createV3HubPeer(this.password, (data, binary) => socket.send(data, { binary }), {
      staticPrivateKey: this.staticKey,
      pinnedClientKey: this.offerKk ? this.clientKey : undefined,
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      const text = isBinary ? undefined : data.toString();
      if (text) {
        try {
          const pattern = (JSON.parse(text) as { payload?: { noise?: { pattern?: string } } }).payload?.noise?.pattern;
          if (pattern) this.patterns.push(pattern.slice(0, 2));
        } catch {
          // Not a handshake frame.
        }
      }
      try {
        peer.onMessage(isBinary ? new Uint8Array(data) : text!);
      } catch {
        socket.close(); // a close frame with no status: 1005
        return;
      }
      if (peer.clientStaticKey && !this.clientKey) this.clientKey = hexToBytes(peer.clientStaticKey);
    });
    peer.start();
  }
}

type Outcome = "connected" | "refused" | "key_changed" | "failed";

function outcomeOf(error: unknown): Outcome {
  if (error === undefined) return "connected";
  if (error instanceof ThalovantHubRefusedError) return "refused";
  if (error instanceof ThalovantHubKeyChangedError) return "key_changed";
  assert.ok(error instanceof ThalovantConnectionError, String(error));
  return "failed";
}

async function attempt(identity: ThalovantIdentity, noiseStateDir: string): Promise<unknown> {
  const client = new ThalovantClient(identity, { protocol: "wss", noiseStateDir });
  try {
    await client.connect(10_000);
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await client.close();
  }
}

for (const vector of cases("handshake")) {
  test(`handshake: ${vector.name}`, async (t) => {
    const hub = new LoopbackHub();
    await hub.start();
    const noiseStateDir = await mkdtemp(join(tmpdir(), "thalovant-link-keeping-"));
    t.after(async () => {
      await hub.stop();
      await rm(noiseStateDir, { recursive: true, force: true });
    });
    let identity = hub.identity();
    if (["pinned", "password_changed_since_pinning", "hub_key_changed"].includes(vector.situation!)) {
      assert.equal(await attempt(identity, noiseStateDir), undefined, "first contact pins both ways");
    }
    if (vector.situation === "wrong_password") identity = hub.identity("a-wrong-password");
    else if (vector.situation === "password_changed_since_pinning") hub.password = "the-password-now";
    else if (vector.situation === "hub_key_changed") {
      hub.staticKey = Uint8Array.from(randomBytes(32)); // the hub was replaced
      hub.offerKk = vector.hub_offers_kk ?? true;
    } else if (vector.situation === "upgrade_status") hub.upgradeStatus = vector.status;
    const before = hub.patterns.length;
    const outcome = outcomeOf(await attempt(identity, noiseStateDir));
    const produced = { outcome, patterns: hub.patterns.slice(before) };
    record("link-keeping-vectors.json", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

for (const vector of cases("supervise")) {
  test(`supervise: ${vector.name}`, () => {
    const supervisor = new LinkSupervisor(new HubSessionPolicy(
      POLICY.retry_ms / 1000,
      POLICY.retry_ceiling_ms / 1000,
      POLICY.probe_ms / 1000,
      POLICY.probe_down_ms / 1000,
      POLICY.refusal_grace_ms / 1000,
    ));
    const produced: Json[] = [];
    for (const event of vector.events!) {
      const decision = supervisor.after(event.outcome, event.at_ms / 1000);
      if (decision.action === "retry") produced.push({ action: "retry", wait_ms: Math.round(decision.waitSeconds * 1000) });
      else if (decision.action === "give_up") produced.push({ action: "give_up", reason: decision.reason });
      else produced.push({ action: decision.action });
    }
    record("link-keeping-vectors.json", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

test("run() stops at once when the hub's key changed", async (t) => {
  const hub = new LoopbackHub();
  await hub.start();
  const noiseStateDir = await mkdtemp(join(tmpdir(), "thalovant-link-keeping-"));
  t.after(async () => {
    await hub.stop();
    await rm(noiseStateDir, { recursive: true, force: true });
  });
  assert.equal(await attempt(hub.identity(), noiseStateDir), undefined);
  hub.staticKey = Uint8Array.from(randomBytes(32));
  const session = HubSession.forIdentity(hub.identity(), {
    client: { protocol: "wss", noiseStateDir },
    warm: false,
    settleSeconds: 0.05,
    policy: new HubSessionPolicy(0.05, 0.1, 0.05, 0.05, 30),
  });
  t.after(() => session.close());
  const started = performance.now();
  // KK against the old key fails, XX follows at once and meets the pin:
  // run() ends there rather than retrying for ever.
  await assert.rejects(session.run(), ThalovantHubKeyChangedError);
  assert.ok(performance.now() - started < 10_000);
  assert.deepEqual(hub.patterns.slice(-2), ["KK", "XX"]);
  assert.equal(hub.patterns.length, 3, "the pinning connect, then KK and XX, and nothing after");
});

test("a hub that closes between its HELLO and its offer is refusing, not dropping", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ msg_type: "hello", payload: { node_id: "n", pubkey: "p" }, metadata: {} }));
    setTimeout(() => socket.close(1008), 10);
  });
  const noiseStateDir = await mkdtemp(join(tmpdir(), "thalovant-link-keeping-"));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(noiseStateDir, { recursive: true, force: true });
  });
  const identity = new ThalovantIdentity({
    access_key: "a",
    password: "p",
    site_id: "s",
    default_master: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  assert.ok((await attempt(identity, noiseStateDir)) instanceof ThalovantHubRefusedError);
});

/**
 * A HiveMind HTTP listener over a mocked fetch: each /connect starts a fresh
 * responder, and a handshake message the hub cannot authenticate is answered
 * 403, which is how the HTTP listener turns credentials away.
 */
function httpHub() {
  const hub = { password: "the-right-password", staticKey: Uint8Array.from(randomBytes(32)), patterns: [] as string[] };
  let clientKey: Uint8Array | undefined;
  let peer: ReturnType<typeof createV3HubPeer> | undefined;
  let clear: string[] = [];
  let binary: string[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/connect") {
      clear = [];
      binary = [];
      peer = createV3HubPeer(hub.password, (data, encrypted) => {
        if (encrypted) binary.push(Buffer.from(data as Uint8Array).toString("base64"));
        else clear.push(String(data));
      }, { staticPrivateKey: hub.staticKey, pinnedClientKey: clientKey });
      peer.start();
      return reply({ status: "Connected" });
    }
    if (path === "/disconnect") return reply({ status: "Disconnected" });
    if (path === "/get_messages") return reply({ messages: clear.splice(0) });
    if (path === "/get_binary_messages") return reply({ b64_messages: binary.splice(0) });
    const form = new URLSearchParams(String(init?.body));
    const message = form.get("message")!;
    try {
      if (form.get("binary") === "1") peer!.onMessage(new Uint8Array(Buffer.from(message, "base64")));
      else {
        const pattern = (JSON.parse(message) as { payload?: { noise?: { pattern?: string } } }).payload?.noise?.pattern;
        if (pattern) hub.patterns.push(pattern.slice(0, 2));
        peer!.onMessage(message);
      }
    } catch {
      return reply({ detail: "Forbidden" }, 403);
    }
    if (peer!.clientStaticKey && !clientKey) clientKey = hexToBytes(peer!.clientStaticKey);
    return reply({ status: "message sent" });
  };
  return { hub, fetch };
}

for (const situation of ["password_changed_since_pinning", "hub_key_changed"] as const) {
  test(`HTTPS polling follows a refused KK with XX at once: ${situation}`, async (t) => {
    const { hub, fetch } = httpHub();
    t.mock.method(globalThis, "fetch", fetch);
    const noiseStateDir = await mkdtemp(join(tmpdir(), "thalovant-link-keeping-http-"));
    t.after(() => rm(noiseStateDir, { recursive: true, force: true }));
    const identity = new ThalovantIdentity({
      access_key: "access", password: "the-right-password", site_id: "ha",
      default_master: "https://hub.example.invalid", data_plane_endpoints: { https: "https://hub.example.invalid" },
    });
    const first = new HiveMindHttpTransport(identity, { noiseStateDir, pollIntervalMs: 5 });
    await first.connect(10_000);
    await first.disconnect();
    if (situation === "password_changed_since_pinning") hub.password = "the-password-now";
    else hub.staticKey = Uint8Array.from(randomBytes(32));
    const again = new HiveMindHttpTransport(identity, { noiseStateDir, pollIntervalMs: 5 });
    t.after(() => again.disconnect());
    const error = await again.connect(10_000).then(() => undefined, (caught: unknown) => caught);
    assert.equal(outcomeOf(error), situation === "hub_key_changed" ? "key_changed" : "refused", String(error));
    assert.deepEqual(hub.patterns, ["XX", "KK", "XX"]);
  });
}
