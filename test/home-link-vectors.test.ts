/**
 * The Home Assistant link, against the four vector files every SDK shares.
 *
 * `device-login`, `connection-kinds` and `connection-admission` are HTTP
 * exchanges: each case's answers are served in order by a real loopback HTTP
 * peer, every request the SDK sends is checked against the one the case names
 * (method, path, body or body subset, `If-Match`, `Authorization`), and what
 * the public control plane produced is recorded -- before it is asserted --
 * and compared with the case. `home-link` holds the reply routing and the
 * request/response rules; its answers run twice, through `answerHomeRequest`
 * and end to end over a real WSS + Noise link to a hub, where the hub reads the
 * reply's routing off the wire.
 *
 * Vendored unchanged from the Python SDK's `contracts/conformance/`.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { WebSocketServer } from "ws";

import {
  answerHomeRequest,
  answerHomeRequests,
  CONNECTION_TYPE_HOME_ASSISTANT,
  DeviceAuthorization,
  HOME_ASSISTANT_SCOPES,
  HOME_ERROR_CODES,
  HOME_REQUEST,
  HOME_REQUEST_TIMEOUT_MS,
  HOME_RESPONSE,
  HOME_RESPONSE_TYPES,
  HubSession,
  replyContext,
  ThalovantAdmissionFailedError,
  ThalovantAdmissionTimeoutError,
  ThalovantAlreadyLinkedError,
  ThalovantApiError,
  ThalovantAuthError,
  ThalovantConnectionError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
  ThalovantDeviceLoginPendingError,
  ThalovantEvent,
  ThalovantIdentity,
  ThalovantPlanError,
  ThalovantTimeoutError,
  ThalovantUnsupportedConnectionTypeError,
  type HomeAnswer,
  type HomeHandler,
} from "../src/index.js";
import { record } from "./conformance-record.js";
import { createV3HubPeer } from "./v3-hub.js";

type Json = Record<string, unknown>;

interface Exchange {
  request: {
    method: string;
    path: string;
    json?: unknown;
    json_subset?: unknown;
    if_match?: string;
    authorization?: string;
  };
  response: { status: number; content_type: string; body: string };
  repeat?: boolean;
}

interface HttpCase {
  name: string;
  call: Json;
  exchanges: Exchange[];
  expect: unknown;
}

function loadVectors<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test/${name}`, import.meta.url), "utf8")) as T;
}

const DEVICE = loadVectors<{ cases: HttpCase[]; home_assistant_scopes: string[]; message_excludes: string[] }>(
  "device-login-vectors.json",
);
const KINDS = loadVectors<{ cases: HttpCase[]; message_excludes: string[] }>("connection-kinds-vectors.json");
const ADMISSION = loadVectors<{ cases: HttpCase[] }>("connection-admission-vectors.json");
const HOME = loadVectors<{
  cases: Array<{
    name: string;
    kind: "reply_context" | "answer";
    context?: Json;
    request?: Json;
    handler?: Json;
    timeout_seconds?: number;
    expect: Json;
  }>;
  request_type: string;
  response_type: string;
  reply_timeout_seconds: number;
  response_types: string[];
  error_codes: string[];
}>("home-link-vectors.json");

/** Serves a case's exchanges in order and checks each request against its own. */
class ScriptedApi {
  readonly sent: string[] = [];
  readonly mismatches: string[] = [];
  index = 0;
  url = "";
  private readonly server = createServer((request, response) => void this.handle(request, response));

  constructor(private readonly exchanges: Exchange[]) {}

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const ifMatch = request.headers["if-match"];
    this.sent.push(`${request.method} ${path}${ifMatch ? ` If-Match=${ifMatch}` : ""}`);
    const exchange = this.exchanges[this.index];
    if (!exchange) {
      this.mismatches.push(`unexpected ${request.method} ${path}`);
      response.writeHead(599).end("{}");
      return;
    }
    if (!exchange.repeat) this.index += 1;
    const expected = exchange.request;
    if (request.method !== expected.method || path !== expected.path) {
      this.mismatches.push(`${request.method} ${path} != ${expected.method} ${expected.path}`);
    }
    const body: unknown = raw ? JSON.parse(raw) : null;
    if ("json" in expected && !deepEquals(body, expected.json)) {
      this.mismatches.push(`body ${raw} != ${JSON.stringify(expected.json)}`);
    }
    if ("json_subset" in expected && !contains(body, expected.json_subset)) {
      this.mismatches.push(`body lacks ${JSON.stringify(expected.json_subset)}`);
    }
    if ("if_match" in expected && ifMatch !== expected.if_match) {
      this.mismatches.push(`If-Match ${String(ifMatch)} != ${expected.if_match}`);
    }
    if ("authorization" in expected && request.headers.authorization !== expected.authorization) {
      this.mismatches.push("wrong Authorization header");
    }
    const answer = Buffer.from(exchange.response.body, "utf8");
    response.writeHead(
      exchange.response.status,
      answer.length ? { "content-type": exchange.response.content_type, "content-length": String(answer.length) } : {},
    );
    response.end(answer);
  }
}

async function scripted<T>(exchanges: Exchange[], run: (api: ScriptedApi) => Promise<T>): Promise<{ produced: T; api: ScriptedApi }> {
  const api = await new ScriptedApi(exchanges).start();
  try {
    return { produced: await run(api), api };
  } finally {
    await api.stop();
  }
}

function deepEquals(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function contains(value: unknown, subset: unknown): boolean {
  if (subset && typeof subset === "object" && !Array.isArray(subset)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(subset).every(([key, item]) => key in value && contains((value as Json)[key], item));
  }
  return deepEquals(value, subset);
}

/** Neither a secret the vectors name, nor anything else they exclude, in any printed form of the error. */
function assertExcluded(error: unknown, excludes: readonly string[]): void {
  const forms = error instanceof Error
    ? [error.message, String(error), inspect(error), JSON.stringify(error), error.stack ?? "", JSON.stringify(error.cause ?? null)]
    : [String(error)];
  for (const text of excludes) {
    for (const form of forms) assert.ok(!form.includes(text), `${JSON.stringify(text)} reached ${JSON.stringify(form)}`);
  }
}

function apiFields(error: ThalovantApiError): Json {
  return { status: error.statusCode ?? null, code: error.code ?? null, detail: error.detail ?? null };
}

// -- device login -------------------------------------------------------------

async function pollOnce(plane: ThalovantControlPlane, authorization: DeviceAuthorization): Promise<Json> {
  try {
    const token = await plane.pollDeviceLogin(authorization);
    assert.equal(plane.accessToken, token.accessToken);
    assert.equal(plane.tokenId, token.tokenId ?? undefined);
    return {
      outcome: "approved",
      token_type: token.tokenType,
      scopes: [...token.scopes],
      expires_at: token.expiresAt,
      token_id: token.tokenId,
    };
  } catch (error) {
    assertExcluded(error, DEVICE.message_excludes);
    if (error instanceof ThalovantDeviceLoginPendingError) return { outcome: "pending", interval: error.interval };
    if (error instanceof ThalovantDeviceLoginExpiredError) return { outcome: "expired", status: error.statusCode ?? null };
    if (error instanceof ThalovantDeviceLoginDeniedError) return { outcome: "denied", status: error.statusCode ?? null };
    assert.ok(error instanceof ThalovantApiError, String(error));
    const produced: Json = { outcome: "error", status: error.statusCode ?? null };
    if (error.statusCode !== undefined) Object.assign(produced, { code: error.code ?? null, detail: error.detail ?? null });
    return produced;
  }
}

for (const vector of DEVICE.cases) {
  test(`device login: ${vector.name}`, async () => {
    const call = vector.call as {
      op: string;
      scopes?: string[];
      client_name?: string;
      authorization?: { device_code: string; interval: number };
      times?: number;
    };
    const { produced, api } = await scripted(vector.exchanges, async ({ url }) => {
      const plane = new ThalovantControlPlane(url);
      const produced: Json[] = [];
      if (call.op === "begin") {
        try {
          const grant = await plane.beginDeviceLogin({ scopes: call.scopes, clientName: call.client_name });
          produced.push({
            outcome: "started",
            user_code: grant.userCode,
            verification_uri: grant.verificationUri,
            verification_uri_complete: grant.verificationUriComplete,
            interval: grant.interval,
            expires_in: grant.expiresIn,
          });
          // The secret half never shows when the grant is printed.
          assert.ok(!inspect(grant).includes(grant.deviceCode));
          assert.ok(!String(grant).includes(grant.deviceCode));
        } catch (error) {
          assertExcluded(error, DEVICE.message_excludes);
          assert.ok(error instanceof ThalovantApiError, String(error));
          produced.push({ outcome: "error", status: error.statusCode ?? null });
        }
        return produced;
      }
      const authorization = DeviceAuthorization.fromGrant({
        device_code: call.authorization!.device_code,
        user_code: "WDJB-MJHT",
        verification_uri: "https://thalovant.com/activate",
        interval: call.authorization!.interval,
        expires_in: 900,
      });
      for (let poll = 0; poll < (call.times ?? 1); poll += 1) produced.push(await pollOnce(plane, authorization));
      if (call.op === "revoke") {
        await plane.revokeApiToken();
        assert.equal(plane.accessToken, undefined);
        assert.equal(plane.tokenId, undefined);
        return [{ outcome: "revoked" }];
      }
      return produced;
    });
    record("device-login-vectors.json", vector.name, produced);
    assert.deepEqual(api.mismatches, []);
    assert.equal(api.index, vector.exchanges.length, "not every exchange was used");
    assert.deepEqual(produced, vector.expect);
  });
}

// -- connection kinds -----------------------------------------------------------

function kindOutcome(error: ThalovantApiError): string {
  if (error instanceof ThalovantPlanError) return "plan";
  if (error instanceof ThalovantAlreadyLinkedError) return "already_linked";
  if (error instanceof ThalovantAuthError) return "auth";
  return "error";
}

for (const vector of KINDS.cases) {
  test(`connection kinds: ${vector.name}`, async () => {
    const call = vector.call as { op: string; hub?: Json; name?: string; connection_type?: string; client_id?: string; etag?: string | null };
    const { produced, api } = await scripted(vector.exchanges, async (api) => {
      const plane = new ThalovantControlPlane(api.url, { accessToken: "synthetic-token" });
      let produced: Json;
      if (call.op === "create") {
        try {
          const result = await plane.createClientIdentity(call.hub!, { name: call.name!, connectionType: call.connection_type });
          produced = {
            outcome: "created",
            client_id: result.clientId ?? null,
            connection_type: result.connectionType ?? null,
            operation_id: result.operation?.id ?? null,
          };
        } catch (error) {
          assertExcluded(error, KINDS.message_excludes);
          assert.ok(error instanceof ThalovantApiError, String(error));
          if (error instanceof ThalovantUnsupportedConnectionTypeError) {
            produced = error.statusCode !== undefined
              ? { outcome: "unsupported", ...apiFields(error) }
              : { outcome: "unsupported", deleted: api.sent.some((line) => line.startsWith("DELETE ")) };
          } else {
            produced = { outcome: kindOutcome(error), ...apiFields(error) };
            if (error instanceof ThalovantAlreadyLinkedError) produced.client_id = error.clientId ?? null;
          }
        }
      } else {
        try {
          await plane.deleteClient(call.client_id!, { etag: call.etag });
          produced = { outcome: "deleted" };
        } catch (error) {
          assert.ok(error instanceof ThalovantApiError, String(error));
          produced = { outcome: kindOutcome(error), ...apiFields(error) };
        }
      }
      produced.requests = [...api.sent];
      return produced;
    });
    record("connection-kinds-vectors.json", vector.name, produced);
    assert.deepEqual(api.mismatches, []);
    assert.deepEqual(produced, vector.expect);
  });
}

// -- admission --------------------------------------------------------------------

for (const vector of ADMISSION.cases) {
  test(`connection admission: ${vector.name}`, async () => {
    const call = vector.call as { operation: Json | null; timeout_seconds: number; poll_interval_seconds: number };
    const { produced, api } = await scripted(vector.exchanges, async (api) => {
      const plane = new ThalovantControlPlane(api.url, { accessToken: "synthetic-token" });
      try {
        await plane.waitForAdmission(call.operation, {
          timeoutMs: call.timeout_seconds * 1000,
          pollIntervalMs: call.poll_interval_seconds * 1000,
        });
        return { outcome: "admitted", polls: api.sent.length } as Json;
      } catch (error) {
        if (error instanceof ThalovantAdmissionTimeoutError) {
          assert.ok(error instanceof ThalovantConnectionError && error instanceof ThalovantTimeoutError);
          return { outcome: "timeout" } as Json;
        }
        if (error instanceof ThalovantAdmissionFailedError) {
          return { outcome: "failed", error_code: error.errorCode ?? null, polls: api.sent.length } as Json;
        }
        assert.ok(error instanceof ThalovantApiError, String(error));
        return { outcome: "error", polls: api.sent.length } as Json;
      }
    });
    record("connection-admission-vectors.json", vector.name, produced);
    assert.deepEqual(api.mismatches, []);
    assert.deepEqual(produced, vector.expect);
  });
}

// -- the home link ----------------------------------------------------------------

/** The vector's handler: it answers, throws, or takes longer than it is given. */
function vectorHandler(spec: Json): HomeHandler {
  return async (_request, signal) => {
    if (spec.raises) throw new Error("the conversation agent is gone");
    if (typeof spec.sleep_seconds === "number") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, (spec.sleep_seconds as number) * 1000);
        // The SDK stops waiting at the timeout and says so; the handler can stop too.
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
    const answer: HomeAnswer = {
      speech: typeof spec.speech === "string" ? spec.speech : "",
      responseType: typeof spec.response_type === "string" ? spec.response_type : "action_done",
      errorCode: typeof spec.error_code === "string" ? spec.error_code : null,
      continueConversation: spec.continue_conversation === true,
    };
    return answer;
  };
}

for (const vector of HOME.cases) {
  test(`home link: ${vector.name}`, async () => {
    let produced: Json;
    if (vector.kind === "reply_context") {
      const before = structuredClone(vector.context);
      produced = replyContext(vector.context) as Json;
      assert.deepEqual(vector.context, before, "the request's context is never changed");
    } else {
      const sent: Array<[string, Json]> = [];
      const replier = {
        async reply(_event: ThalovantEvent, msgType: string, data: Json): Promise<void> {
          sent.push([msgType, data]);
        },
      };
      const event = new ThalovantEvent(HOME_REQUEST, vector.request, { source: "skill" });
      produced = await answerHomeRequest(replier, event, vectorHandler(vector.handler!), {
        timeoutMs: (vector.timeout_seconds ?? 9) * 1000,
      });
      assert.deepEqual(sent, [[HOME_RESPONSE, produced]]);
    }
    record("home-link-vectors.json", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

test("home link: every answer case over a real WSS + Noise link, routed back as a reply", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  // One hook, in order: a ws server waits for its open sockets before it closes.
  const cleanup: Array<() => unknown> = [];
  t.after(async () => {
    for (const step of cleanup.reverse()) await step();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await once(server, "listening");
  let hub: ReturnType<typeof createV3HubPeer> | undefined;
  const ready = new Promise<void>((resolve) => {
    server.on("connection", (socket) => {
      hub = createV3HubPeer("secret", (data, binary) => socket.send(data, { binary }));
      socket.on("message", (data: Buffer, isBinary: boolean) => {
        hub!.onMessage(isBinary ? new Uint8Array(data) : data.toString());
        if (hub!.received.length) resolve();
      });
      hub.start();
    });
  });
  const noiseStateDir = await mkdtemp(join(tmpdir(), "thalovant-home-link-"));
  cleanup.push(() => rm(noiseStateDir, { recursive: true, force: true }));
  const identity = new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    site_id: "home-assistant",
    default_master: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  const session = HubSession.forIdentity(identity, { client: { protocol: "wss", noiseStateDir }, connectTimeoutMs: 8000, warm: false });
  cleanup.push(() => session.close());

  const answers = HOME.cases.filter((item) => item.kind === "answer");
  const handlers = new Map(answers.map((item) => [item.name, vectorHandler(item.handler!)]));
  const timeouts = new Map(answers.map((item) => [item.name, (item.timeout_seconds ?? 9) * 1000]));
  // One subscription per case, told apart by the utterance, with the case's own bound.
  const stops = answers.map((item) =>
    answerHomeRequests(
      {
        on: (name, handler) =>
          session.on(name, (event) => (event.data.utterance === item.request!.utterance ? handler(event) : undefined)),
        reply: (event, msgType, data, context) => session.reply(event, msgType, data, context),
      },
      handlers.get(item.name)!,
      { timeoutMs: timeouts.get(item.name) },
    ),
  );
  cleanup.push(() => stops.forEach((stop) => stop()));
  await session.warm();
  assert.ok(session.connected, "the link came up");
  await ready;

  for (const item of answers) {
    const before = hub!.received.length;
    const context = {
      source: "thalovant-skill-home",
      destination: ["ha-peer", "bridge"],
      session: { session_id: `kitchen-${item.name}` },
      request_id: `route-${item.name}`,
    };
    hub!.sendBus({ type: HOME_REQUEST, data: item.request, context });
    const frame = await waitFor(() => hub!.received.slice(before).map((raw) => JSON.parse(raw)).find(
      (message) => message.msg_type === "bus" && message.payload.type === HOME_RESPONSE,
    ));
    const { data, context: routed } = frame.payload as { data: Json; context: Json };
    record("home-link-vectors.json", item.name, data);
    assert.deepEqual(data, item.expect, item.name);
    // The route turned round, as the hub sent it, and nothing else of it lost.
    assert.equal(routed.source, "ha-peer");
    assert.equal(routed.destination, "thalovant-skill-home");
    assert.deepEqual(routed.session, context.session);
    assert.equal(routed.request_id, context.request_id);
  }
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the hub to receive a reply");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the contract's lists are the SDK's", () => {
  assert.deepEqual([...HOME_RESPONSE_TYPES], HOME.response_types);
  assert.deepEqual([...HOME_ERROR_CODES], HOME.error_codes);
  assert.equal(HOME_REQUEST, HOME.request_type);
  assert.equal(HOME_RESPONSE, HOME.response_type);
  assert.equal(HOME_REQUEST_TIMEOUT_MS, HOME.reply_timeout_seconds * 1000);
  assert.deepEqual([...HOME_ASSISTANT_SCOPES], DEVICE.home_assistant_scopes);
  assert.equal(CONNECTION_TYPE_HOME_ASSISTANT, "home_assistant");
});
