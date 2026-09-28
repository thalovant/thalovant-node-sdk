/**
 * The Home Assistant link beyond its shared vectors: the error model, the
 * device sign-in objects, the control-plane edges the vectors do not reach, the
 * home answer's own edges, the reply on a client and a session, and a kept link
 * that tells a refusal from a drop -- over a real WebSocket where the close code
 * is what decides.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
  ApiToken,
  DeviceAuthorization,
  HOME_REQUEST,
  HOME_RESPONSE,
  homeRequestFromEvent,
  homeResponse,
  HubSession,
  HubSessionPolicy,
  plainSpeech,
  replyContext,
  ThalovantAdmissionFailedError,
  ThalovantAdmissionTimeoutError,
  ThalovantAlreadyLinkedError,
  ThalovantApiError,
  ThalovantAuthError,
  ThalovantClient,
  ThalovantConnectionError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginPendingError,
  ThalovantEvent,
  ThalovantHubRefusedError,
  ThalovantIdentity,
  ThalovantPlanError,
  ThalovantRuntimeError,
  ThalovantSubscription,
  ThalovantTimeoutError,
  ThalovantUnsupportedConnectionTypeError,
  type EventContext,
  type EventHandler,
  type HubSessionClient,
} from "../src/index.js";
import { createV3HubPeer } from "./v3-hub.js";

type Json = Record<string, unknown>;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A loopback API answering from `route`, recording what it was sent. */
async function serving<T>(
  route: (request: { method: string; path: string; body: unknown; headers: IncomingMessage["headers"] }) => {
    status: number;
    body?: unknown;
  },
  run: (url: string, sent: string[]) => Promise<T>,
): Promise<T> {
  const sent: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    sent.push(`${request.method} ${request.url}`);
    const answer = route({ method: request.method ?? "", path, body: raw ? JSON.parse(raw) : null, headers: request.headers });
    const text = answer.body === undefined ? "" : JSON.stringify(answer.body);
    response.writeHead(answer.status, text ? { "content-type": "application/json" } : {});
    response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, sent);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// -- the error model ---------------------------------------------------------------

test("an admission timeout is a connection error and a timeout, and nothing else became one", () => {
  const timeout = new ThalovantAdmissionTimeoutError("not yet");
  assert.ok(timeout instanceof ThalovantAdmissionTimeoutError);
  assert.ok(timeout instanceof ThalovantConnectionError);
  assert.ok(timeout instanceof ThalovantTimeoutError);
  assert.ok(timeout instanceof Error);
  // instanceof keeps its ordinary meaning for everything else.
  assert.ok(!(new ThalovantConnectionError("x") instanceof ThalovantTimeoutError));
  assert.ok(!(new ThalovantAdmissionFailedError("x") instanceof ThalovantTimeoutError));
  assert.ok(!(new ThalovantHubRefusedError("x") instanceof ThalovantTimeoutError));
  assert.ok(new ThalovantTimeoutError("x") instanceof ThalovantTimeoutError);
  assert.ok(!((null as unknown) instanceof ThalovantTimeoutError));
  assert.ok(!({} instanceof ThalovantTimeoutError));
  class Narrower extends ThalovantTimeoutError {}
  assert.ok(new Narrower("x") instanceof ThalovantTimeoutError);
  assert.ok(!(timeout instanceof Narrower), "a subclass does not inherit the admission rule");

  const refused = new ThalovantHubRefusedError("no");
  assert.ok(refused instanceof ThalovantConnectionError);
  const failed = new ThalovantAdmissionFailedError("failed", { errorCode: "gitops_push_rejected" });
  assert.equal(failed.errorCode, "gitops_push_rejected");
  const pending = new ThalovantDeviceLoginPendingError("wait", { interval: 10, statusCode: 400 });
  assert.equal(pending.interval, 10);
  assert.equal(pending.intervalMs, 10_000);
  assert.ok(pending instanceof ThalovantApiError);
  const linked = new ThalovantAlreadyLinkedError("linked", { statusCode: 409, clientId: "c1" });
  assert.equal(linked.clientId, "c1");
  assert.ok(linked instanceof ThalovantApiError);
});

test("each refusal the API sends has its class, whatever call it answers", async () => {
  const answers: Record<string, { status: number; body: Json }> = {
    "/v1/hubs/locked": { status: 423, body: { detail: "Account locked" } },
    "/v1/hubs/scope": { status: 403, body: { detail: "Insufficient scopes" } },
    "/v1/hubs/forbidden": { status: 403, body: { detail: "Forbidden" } },
    "/v1/hubs/plan": { status: 403, body: { detail: "Free plan allows up to 1 hub.", code: "plan_limit", limit: 1, used: 1 } },
    "/v1/hubs/nested": {
      status: 409,
      body: { detail: { code: "home_assistant_already_linked", detail: "Linked.", existing_client_id: "c9" } },
    },
    "/v1/hubs/conflict": { status: 409, body: { detail: "Hub name already exists" } },
  };
  await serving(({ path }) => answers[path] ?? { status: 500 }, async (url) => {
    const api = new ThalovantControlPlane(url, { accessToken: "synthetic-token" });
    const refusal = async (hub: string) => {
      try {
        await api.getHub(hub);
      } catch (error) {
        return error as ThalovantApiError;
      }
      assert.fail("resolved on an error status");
    };
    assert.ok((await refusal("locked")) instanceof ThalovantAuthError);
    assert.ok((await refusal("scope")) instanceof ThalovantAuthError);
    const forbidden = await refusal("forbidden");
    assert.ok(forbidden instanceof ThalovantApiError && !(forbidden instanceof ThalovantAuthError));
    const plan = await refusal("plan");
    assert.ok(plan instanceof ThalovantPlanError);
    assert.equal(plan.problem?.limit, 1);
    const nested = await refusal("nested");
    assert.ok(nested instanceof ThalovantAlreadyLinkedError);
    assert.equal(nested.clientId, "c9");
    const conflict = await refusal("conflict");
    assert.equal(conflict.constructor, ThalovantApiError);
    // The message is the line it always was.
    assert.equal(plan.message, "Thalovant API request failed with HTTP 403: Free plan allows up to 1 hub. (plan_limit)");
  });
});

// -- device sign-in ------------------------------------------------------------------

test("a device authorization hides its code in print and resumes from JSON", () => {
  const grant = DeviceAuthorization.fromGrant({
    device_code: "dc-secret",
    user_code: "WDJB-MJHT",
    verification_uri: "https://thalovant.com/activate",
    interval: 2.5,
  });
  assert.equal(grant.interval, 2.5);
  assert.equal(grant.expiresIn, 900);
  assert.equal(grant.verificationUriComplete, null);
  for (const form of [inspect(grant), String(grant), `${grant}`]) assert.ok(!form.includes("dc-secret"), form);
  const resumed = DeviceAuthorization.fromGrant(JSON.parse(JSON.stringify(grant)));
  assert.deepEqual(resumed.toJSON(), grant.toJSON());
  assert.equal(resumed.deviceCode, "dc-secret");
  for (const unsafe of ["javascript:alert(1)", "https://user:pw@thalovant.com/activate", "https:///activate", "https://thalovant.com/a b"]) {
    assert.throws(
      () => DeviceAuthorization.fromGrant({ device_code: "d", user_code: "u", verification_uri: unsafe }),
      /without embedded credentials/,
    );
  }
  assert.throws(() => DeviceAuthorization.fromGrant({ device_code: "d", user_code: "", verification_uri: "https://x" }), /incomplete/);

  const token = ApiToken.fromResponse({ access_token: "tvt_secret", scopes: ["hubs:read", 3], token_id: "t1" });
  assert.equal(token.tokenType, "bearer");
  assert.deepEqual(token.scopes, ["hubs:read"]);
  assert.equal(token.expiresAt, null);
  for (const form of [inspect(token), String(token)]) assert.ok(!form.includes("tvt_secret"), form);
  assert.equal(JSON.parse(JSON.stringify(token)).access_token, "tvt_secret");
});

test("slow_down lengthens one code's interval for good, and a code alone can be polled", async () => {
  const answers = [
    { status: 400, body: { error: "slow_down" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "access_denied" } },
  ];
  await serving(() => answers.shift()!, async (url) => {
    const api = new ThalovantControlPlane(url);
    const intervals: number[] = [];
    for (let poll = 0; poll < 3; poll += 1) {
      await assert.rejects(api.pollDeviceLogin("dc-plain"), (error: unknown) => {
        assert.ok(error instanceof ThalovantDeviceLoginPendingError);
        intervals.push(error.interval);
        return true;
      });
    }
    // Without a grant, the poll starts from the default five seconds.
    assert.deepEqual(intervals, [10, 15, 15]);
    await assert.rejects(api.pollDeviceLogin("dc-plain"), ThalovantDeviceLoginDeniedError);
    assert.equal(api.accessToken, undefined);
  });
});

test("the browser loop keeps the token id, and a denial is its own class", async () => {
  const authorize = { device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://dash.example.invalid/device", interval: 0 };
  await serving(({ path }) => (path === "/v1/auth/device/authorize"
    ? { status: 200, body: authorize }
    : { status: 200, body: { access_token: "tvt_minted", token_id: "t-42", scopes: [] } }), async (url) => {
    const api = new ThalovantControlPlane(url);
    const token = await api.loginWithBrowser({ openBrowser: false, prompt: () => {} });
    assert.equal(token.access_token, "tvt_minted");
    assert.equal(api.accessToken, "tvt_minted");
    assert.equal(api.tokenId, "t-42");
  });
  await serving(({ path }) => (path === "/v1/auth/device/authorize"
    ? { status: 200, body: authorize }
    : { status: 400, body: { error: "access_denied" } }), async (url) => {
    const api = new ThalovantControlPlane(url);
    await assert.rejects(api.loginWithBrowser({ openBrowser: false, prompt: () => {} }), ThalovantDeviceLoginDeniedError);
  });
});

test("revoking needs a token id, and revoking another token keeps the one in use", async () => {
  await serving(() => ({ status: 204 }), async (url, sent) => {
    const api = new ThalovantControlPlane(url, { accessToken: "tvt_mine" });
    await assert.rejects(api.revokeApiToken(), /No API token id to revoke/);
    api.tokenId = "mine";
    await api.revokeApiToken("someone/else");
    assert.equal(api.accessToken, "tvt_mine");
    assert.equal(api.tokenId, "mine");
    assert.deepEqual(sent, ["DELETE /v1/auth/api-tokens/someone%2Felse"]);
  });
});

test("an injected fetch carries every request, and the global one is never touched", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("the global fetch was used"));
  const seen: string[] = [];
  const injected: typeof fetch = async (input, init) => {
    seen.push(`${init?.method} ${new URL(String(input)).pathname}`);
    return new Response(JSON.stringify({ id: "hub-1" }), { status: 200 });
  };
  const api = new ThalovantControlPlane("https://api.example.invalid", { accessToken: "t", fetch: injected });
  assert.deepEqual(await api.getHub("hub-1"), { id: "hub-1" });
  assert.deepEqual(seen, ["GET /v1/hubs/hub-1"]);
});

// -- connections of a kind -------------------------------------------------------------

test("a connection of a kind: the spec carries it, the result names it, and asObject stays redacted", async () => {
  let spec: Json = {};
  const operation = { id: "op-1", status: "requested", links: { self: "/v1/operations/op-1" } };
  await serving(({ body }) => {
    spec = (body as Json).spec as Json;
    return {
      status: 201,
      body: {
        id: "c1",
        etag: "e1",
        spec: { ...spec, connection_type: "home_assistant" },
        initial_identify: { access_key: "ak", password: "pw", site_id: "s", default_master: "wss://kitchen.example.invalid" },
        operation,
      },
    };
  }, async (url) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    const result = await api.createClientIdentity(
      { id: "hub-1", domain: "kitchen.example.invalid", wss_enabled: true },
      { name: "Home Assistant", connectionType: "home_assistant", spec: { connection_type: "voice_satellite", note: "kept" } },
    );
    assert.equal(spec.connection_type, "home_assistant", "the option wins over a caller's spec");
    assert.equal(spec.note, "kept");
    assert.equal(spec.version, "1");
    assert.equal(result.clientId, "c1");
    assert.equal(result.connectionType, "home_assistant");
    assert.deepEqual(result.operation, operation);
    const printed = JSON.stringify(result.asObject());
    assert.ok(!printed.includes('"pw"') && !printed.includes(String(spec.password)));
    assert.deepEqual(result.asObject().operation, operation);
  });
});

test("a 422 about another field is an ordinary error, and a failed clean-up says so", async () => {
  await serving(() => ({ status: 422, body: { detail: "name is too long", code: "schema_validation_failed" } }), async (url) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    const error = await api.createClientIdentity({ id: "hub-1" }, { name: "x", connectionType: "home_assistant" }).then(
      () => assert.fail("resolved"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof ThalovantApiError && !(error instanceof ThalovantUnsupportedConnectionTypeError));
  });
  await serving(({ method }) => (method === "POST"
    ? { status: 201, body: { id: "c1", etag: "e1", spec: { version: "1" } } }
    : { status: 500, body: { detail: "down" } }), async (url, sent) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    await assert.rejects(
      api.createClientIdentity({ id: "hub-1" }, { name: "x", connectionType: "home_assistant" }),
      (error: unknown) => {
        assert.ok(error instanceof ThalovantUnsupportedConnectionTypeError);
        assert.equal(error.statusCode, undefined);
        assert.match(error.message, /remove it in the dashboard/);
        return true;
      },
    );
    assert.deepEqual(sent.map((line) => line.split(" ")[0]), ["POST", "DELETE"]);
  });
  // Without a kind asked for, nothing is checked or deleted: the old behaviour.
  await serving(() => ({ status: 201, body: { id: "c1", spec: { version: "1" } } }), async (url, sent) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    const result = await api.createClientIdentity({ id: "hub-1", domain: "h.example.invalid" }, { name: "x" });
    assert.equal(result.connectionType, undefined);
    assert.equal(result.operation, undefined);
    assert.equal(sent.length, 1);
  });
});

test("listing clients sends the filters the API takes", async () => {
  await serving(() => ({ status: 200, body: { data: [] } }), async (url, sent) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    await api.listClients({ hubId: "hub-1", cursor: "c", includeSpec: false, limit: 5 });
    await api.listClients();
    assert.deepEqual(sent, ["GET /v1/clients?limit=5&hub_id=hub-1&cursor=c&include_spec=false", "GET /v1/clients?limit=100"]);
  });
});

test("two 412s in a row are not retried a second time", async () => {
  await serving(({ method }) => (method === "GET"
    ? { status: 200, body: { id: "c1", etag: "e2" } }
    : { status: 412, body: { detail: "ETag mismatch" } }), async (url, sent) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    await assert.rejects(api.deleteClient("c1", { etag: "e1" }), (error: unknown) => (error as ThalovantApiError).statusCode === 412);
    assert.equal(sent.length, 3);
  });
});

// -- admission ---------------------------------------------------------------------

const requested = (status: string, extra: Json = {}) => ({
  id: "op-1",
  status,
  links: { self: "/v1/operations/op-1" },
  ...extra,
});

test("admission follows a create's result, a bare id or a path, and stops on an abort", async () => {
  const statuses = ["committed", "ready", "ready", "ready"];
  await serving(() => ({ status: 200, body: requested(statuses.shift() ?? "committed") }), async (url, sent) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    await api.waitForAdmission("op-1", { pollIntervalMs: 1 });
    await api.waitForAdmission("/v1/operations/op-1?x=1", { pollIntervalMs: 1 });
    await api.waitForAdmission({ links: { self: `${url}/v1/operations/op-1` } }, { pollIntervalMs: 1 });
    assert.deepEqual(sent, Array(4).fill("GET /v1/operations/op-1"));
    const controller = new AbortController();
    const waiting = api.waitForAdmission("op-1", { pollIntervalMs: 50, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(api.waitForAdmission("op-1", { signal: AbortSignal.abort() }), { name: "AbortError" });
  });
});

test("admission lets an authentication refusal through as itself", async () => {
  await serving(() => ({ status: 401, body: { detail: "Could not validate credentials" } }), async (url) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    await assert.rejects(api.waitForAdmission("op-1"), ThalovantAuthError);
  });
  await serving(() => ({ status: 200, body: requested("failed", { error_code: null, error_message: "no room" }) }), async (url) => {
    const api = new ThalovantControlPlane(url, { accessToken: "t" });
    await assert.rejects(api.waitForAdmission("op-1"), (error: unknown) => {
      assert.ok(error instanceof ThalovantAdmissionFailedError);
      assert.equal(error.errorCode, undefined);
      assert.match(error.message, /no room/);
      return true;
    });
  });
  const api = new ThalovantControlPlane("https://api.example.invalid", { accessToken: "t" });
  await assert.rejects(api.waitForAdmission("https://api.example.invalid.evil/v1/operations/op-1"), /outside the Thalovant API/);
  await assert.rejects(api.waitForAdmission("http://api.example.invalid/v1/operations/op-1"), /outside the Thalovant API/);
  await assert.rejects(api.waitForAdmission({ links: {} }), /needs an id/);
  const timeout = await api.waitForAdmission(null).then(() => "admitted");
  assert.equal(timeout, "admitted");
});

// -- the home answer -------------------------------------------------------------------

test("plain speech decodes what a voice can say and drops what it cannot", () => {
  assert.equal(plainSpeech("Caf&eacute; &mdash; 21&#176;C &#x26; &lt;dry&gt; &hellip;"), "Café — 21°C & <dry> …");
  assert.equal(plainSpeech("A&#39;s &#39 B"), "A's ' B");
  assert.equal(plainSpeech("AT&T &unknown; &amp"), "AT&T &unknown; &amp");
  assert.equal(plainSpeech("bell&#7;&#x80;s &#0; &#xD800;"), "bells � �");
  assert.equal(plainSpeech(null), "");
  assert.equal(plainSpeech("  <p>line one</p>\n\t<p>two</p>  "), "line one two");
});

test("an answer is held to the contract, whatever shape the handler gave it", () => {
  const request = homeRequestFromEvent({ type: HOME_REQUEST, data: { request_id: "r", utterance: "hi", conversation_id: "c7" } });
  assert.deepEqual(homeResponse(request, "Done."), {
    request_id: "r", speech: "Done.", response_type: "action_done", continue_conversation: false, conversation_id: "c7",
  });
  assert.deepEqual(homeResponse(request, null), {
    request_id: "r", speech: "", response_type: "error", error_code: "unknown", continue_conversation: false, conversation_id: "c7",
  });
  // The wire's own names are read too, and a code without an error is dropped.
  assert.deepEqual(homeResponse(request, { speech: "Yes", response_type: "query_answer", error_code: "timeout", conversation_id: "c8" }), {
    request_id: "r", speech: "Yes", response_type: "query_answer", continue_conversation: false, conversation_id: "c8",
  });
  assert.deepEqual(homeResponse(request, { responseType: "error" }), {
    request_id: "r", speech: "", response_type: "error", error_code: "unknown", continue_conversation: false, conversation_id: "c7",
  });
  const bare = homeRequestFromEvent(new ThalovantEvent(HOME_REQUEST, { utterance: 3 as unknown as string }));
  assert.deepEqual([bare.requestId, bare.utterance, bare.lang, bare.conversationId], ["", "", null, null]);
});

test("a handler that ran out of time sees its signal abort, and a thrown value is not a reason to go quiet", async () => {
  const sent: Json[] = [];
  const replier = { reply: async (_event: ThalovantEvent, _type: string, data: Json) => void sent.push(data) };
  let aborted = false;
  const payload = await answerHomeRequest(
    replier,
    { type: HOME_REQUEST, data: { request_id: "r" } },
    (_request, signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))),
    { timeoutMs: 10 },
  );
  assert.equal(payload.error_code, "timeout");
  assert.ok(aborted);
  const thrown = await answerHomeRequest(replier, { type: HOME_REQUEST, data: {} }, () => {
    throw "not even an Error";
  });
  assert.equal(thrown.error_code, "failed_to_handle");
  assert.equal(sent.length, 2);
  await assert.rejects(answerHomeRequest(replier, { type: HOME_REQUEST }, () => "x", { timeoutMs: -1 }), RangeError);
});

test("unsubscribing aborts the answers still running and sends none of them", async () => {
  const handlers: EventHandler[] = [];
  const sent: Json[] = [];
  let closed = 0;
  const link = {
    on: (_name: string, handler: EventHandler) => {
      handlers.push(handler);
      return new ThalovantSubscription(() => void (closed += 1));
    },
    reply: async (_event: ThalovantEvent, _type: string, data: Json) => void sent.push(data),
  };
  let aborted = 0;
  const stop = answerHomeRequests(link, (request, signal) => {
    if (request.requestId === "fast") return "Done.";
    return new Promise((resolve) => signal.addEventListener("abort", () => { aborted += 1; resolve("late"); }));
  });
  await handlers[0](new ThalovantEvent(HOME_REQUEST, { request_id: "fast" }));
  await handlers[0](new ThalovantEvent(HOME_REQUEST, { request_id: "slow" }));
  await sleep(10);
  assert.deepEqual(sent.map((data) => data.request_id), ["fast"]);
  stop();
  stop();
  await sleep(10);
  assert.equal(closed, 1);
  assert.equal(aborted, 1);
  assert.deepEqual(sent.map((data) => data.request_id), ["fast"]);
  // A function unsubscriber is called, not closed.
  let called = 0;
  answerHomeRequests({ on: () => () => void (called += 1), reply: link.reply }, () => "x")();
  assert.equal(called, 1);
});

// -- replies ---------------------------------------------------------------------------

class RecordingTransport extends EventTarget {
  ready = false;
  readonly emitted: Array<{ type: string; data: Json; context: EventContext }> = [];
  async connect() { this.ready = true; }
  async disconnect() { this.ready = false; }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus(type: string, data: Json, context: EventContext) { this.emitted.push({ type, data, context }); }
  deliver(type: string, data: Json, context: EventContext) {
    this.dispatchEvent(new CustomEvent("bus", { detail: { type, data, context } }));
  }
}

test("a client's reply goes back along the route, as the hub sent it", async () => {
  const transport = new RecordingTransport();
  const client = new ThalovantClient(
    new ThalovantIdentity({ key: "k", password: "p", host: "https://hub.example.invalid", site: "ha" }),
    { transport },
  );
  try {
    const wire = { source: "skill-home", destination: ["ha-peer", "bridge"], session: { session_id: "s" }, request_id: "r1" };
    const events: ThalovantEvent[] = [];
    client.on(HOME_REQUEST, (event) => void events.push(event));
    transport.deliver(HOME_REQUEST, { utterance: "hi" }, wire);
    assert.equal(events.length, 1);
    await client.reply(events[0], HOME_RESPONSE, { speech: "ok" }, { lang: "fr-FR" });
    await client.reply({ context: { source: "a" } }, " other.type ", {});
    assert.deepEqual(transport.emitted[0], {
      type: HOME_RESPONSE,
      data: { speech: "ok" },
      context: { source: "ha-peer", destination: "skill-home", session: { session_id: "s" }, request_id: "r1", lang: "fr-FR" },
    });
    // Only a destination is turned into a source; the old source is kept, as
    // ovos-bus-client's Message.reply keeps it.
    assert.deepEqual(transport.emitted[1], { type: "other.type", data: {}, context: { source: "a", destination: "a" } });
    // The delivered event keeps the context the hub sent.
    assert.deepEqual(events[0].context, wire);
    await assert.rejects(client.reply(events[0], "  "), TypeError);
  } finally {
    await client.close();
  }
});

test("reply context copies deeply and keeps a __proto__ key a key", () => {
  const context = JSON.parse('{"source":"s","destination":[],"nested":{"list":[{"a":1}]},"__proto__":{"polluted":true}}');
  const reply = replyContext(context);
  assert.deepEqual(reply.source, [], "an empty list is kept as the reference keeps it");
  assert.equal(reply.destination, "s");
  (reply.nested as { list: Json[] }).list[0].a = 2;
  assert.equal(context.nested.list[0].a, 1);
  assert.equal(({} as Json).polluted, undefined);
  assert.ok(Object.hasOwn(reply, "__proto__"));
  assert.deepEqual(replyContext(null), {});
});

function sessionClient(options: { reply?: boolean } = {}) {
  const state = { phase: "ready" as string, refused: false, closed: 0, emitted: [] as Json[], replied: [] as Json[], asks: 0 };
  let releaseAsk!: () => void;
  const askGate = new Promise<void>((resolve) => { releaseAsk = resolve; });
  const value: Json = {
    connectionInfo: () => ({ phase: state.phase, refused: state.refused }),
    close: async () => { state.closed += 1; state.phase = "closed"; },
    ask: async () => { state.asks += 1; await askGate; return { text: "ok" }; },
    emit: async (type: string, data: Json, context: EventContext) => void state.emitted.push({ type, data, context }),
    on: () => new ThalovantSubscription(() => {}),
  };
  if (options.reply) {
    value.reply = async (_event: unknown, type: string, data: Json) => void state.replied.push({ type, data });
  }
  return { state, value: value as unknown as HubSessionClient, releaseAsk };
}

test("a session's reply does not wait behind an ask, and a client without reply() still routes it", async () => {
  const replying = sessionClient({ reply: true });
  const session = new HubSession(async () => replying.value, { warm: false });
  await session.warm();
  const asking = session.ask("slow");
  await sleep(5);
  await session.reply(new ThalovantEvent(HOME_REQUEST, {}, { source: "skill" }), HOME_RESPONSE, { speech: "now" });
  assert.deepEqual(replying.state.replied, [{ type: HOME_RESPONSE, data: { speech: "now" } }]);
  replying.releaseAsk();
  await asking;
  await session.close();

  const plain = sessionClient();
  const other = new HubSession(async () => plain.value, { warm: false });
  // No link yet: the reply connects first.
  await other.reply(new ThalovantEvent(HOME_REQUEST, {}, { source: "skill", destination: "ha" }), HOME_RESPONSE, { speech: "x" });
  assert.deepEqual(plain.state.emitted, [{ type: HOME_RESPONSE, data: { speech: "x" }, context: { source: "ha", destination: "skill" } }]);
  await other.close();
});

test("a reply that fails on the wire drops the link; a hub's refusal does not", async () => {
  const live = sessionClient({ reply: true });
  let fail: Error = new ThalovantRuntimeError("refused");
  (live.value as unknown as Json).reply = async () => { throw fail; };
  const session = new HubSession(async () => live.value, { warm: false });
  await session.warm();
  await assert.rejects(session.reply({ context: {} }, "t"), ThalovantRuntimeError);
  assert.ok(session.held);
  fail = new ThalovantConnectionError("socket gone");
  await assert.rejects(session.reply({ context: {} }, "t"), ThalovantConnectionError);
  assert.ok(!session.held);
  assert.equal(live.state.closed, 1);
  await session.close();
});

// -- keeping the link ---------------------------------------------------------------------

const quick = new HubSessionPolicy(0.01, 0.02, 0.05, 0.01, 0.2);

test("run() keeps a link, notices a drop, reconnects, and stops on close", async () => {
  const clients: ReturnType<typeof sessionClient>[] = [];
  const session = new HubSession(async () => {
    const next = sessionClient();
    clients.push(next);
    return next.value;
  }, { policy: quick, warm: false, settleSeconds: 0 });
  const states: boolean[] = [];
  const unsubscribe = session.onStateChange((up) => states.push(up));
  session.onStateChange(() => { throw new Error("a listener's own failure"); });
  const running = session.run();
  await waitUntil(() => session.connected);
  clients[0].state.phase = "closed";
  await waitUntil(() => clients.length === 2 && session.connected);
  assert.deepEqual(states, [true, false, true]);
  unsubscribe();
  await session.close();
  await running;
  assert.equal(session.connected, false);
  assert.deepEqual(states, [true, false, true]);
});

test("run() retries refusals for the grace period, then gives up with the refusal", async () => {
  let attempts = 0;
  const session = new HubSession(async () => {
    attempts += 1;
    throw new ThalovantHubRefusedError("not admitted yet");
  }, { policy: quick, warm: false });
  const started = performance.now();
  await assert.rejects(session.run(), ThalovantHubRefusedError);
  assert.ok(attempts >= 3, `${attempts} attempts`);
  assert.ok(performance.now() - started >= 200);
  await session.close();
});

test("a refusal that clears inside the grace period keeps the link", async () => {
  let attempts = 0;
  const live = sessionClient();
  const session = new HubSession(async () => {
    attempts += 1;
    if (attempts < 3) throw new ThalovantHubRefusedError("not admitted yet");
    return live.value;
  }, { policy: new HubSessionPolicy(0.01, 0.02, 0.05, 0.01, 60), warm: false, settleSeconds: 0 });
  const running = session.run();
  await waitUntil(() => session.connected);
  assert.equal(attempts, 3);
  await session.close();
  await running;
});

test("a close right after the handshake is a refusal when the hub says so, and a drop when it does not", async () => {
  for (const refused of [true, false]) {
    const closing = sessionClient();
    const session = new HubSession(async () => {
      setTimeout(() => { closing.state.phase = "closed"; closing.state.refused = refused; }, 5);
      return closing.value;
    }, { warm: false, settleSeconds: 0.2, policy: new HubSessionPolicy(0.01, 0.02, 0.05, 0.01, 0.05) });
    // A drop is retried for as long as the session lives: only closing it ends run().
    if (!refused) setTimeout(() => void session.close(), 150);
    const outcome = await session.run().then(() => undefined, (error: unknown) => error);
    if (refused) {
      assert.ok(outcome instanceof ThalovantHubRefusedError, String(outcome));
      await session.close();
    } else {
      assert.equal(outcome, undefined);
    }
    assert.ok(closing.state.closed >= 1, "the client that closed is retired");
  }
});

test("run() rejects with an AbortError when its signal aborts, and leaves the link as it is", async () => {
  const live = sessionClient();
  const session = new HubSession(async () => live.value, { warm: false, settleSeconds: 0, policy: quick });
  const controller = new AbortController();
  const running = session.run({ signal: controller.signal });
  await waitUntil(() => session.connected);
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(session.connected);
  await assert.rejects(session.run({ signal: AbortSignal.abort() }), { name: "AbortError" });
  await session.close();
  assert.throws(() => new HubSession(async () => live.value, { warm: false, settleSeconds: -1 }), RangeError);
  assert.throws(() => new HubSessionPolicy(1, 2, 3, 4, 0), RangeError);
  assert.equal(new HubSessionPolicy().refusalGraceSeconds, 600);
});

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(5);
  }
}

// -- refusals on a real socket ------------------------------------------------------------

async function hubServer(
  t: test.TestContext,
  behave: (socket: import("ws").WebSocket) => void,
  options: { rejectWith?: number } = {},
): Promise<ThalovantIdentity> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    verifyClient: (_info, done) => (options.rejectWith ? done(false, options.rejectWith) : done(true)),
  });
  await once(server, "listening");
  server.on("connection", behave);
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    site_id: "ha",
    default_master: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
}

async function noiseDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-refusal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a refused WebSocket upgrade is a refusal", async (t) => {
  for (const status of [401, 403, 500]) {
    const identity = await hubServer(t, () => {}, { rejectWith: status });
    const client = new ThalovantClient(identity, { protocol: "wss", noiseStateDir: await noiseDir(t) });
    await assert.rejects(client.connect(4000), (error: unknown) => {
      assert.ok(error instanceof ThalovantConnectionError, String(error));
      assert.equal(error instanceof ThalovantHubRefusedError, status !== 500, String(error));
      if (status !== 500) assert.match((error as Error).message, new RegExp(`HTTP ${status}`));
      return true;
    });
    await client.close();
  }
});

test("a close before the hub's HELLO is a refusal only with a refusing code", async (t) => {
  for (const [code, refusal] of [[1008, true], [1011, false]] as const) {
    const identity = await hubServer(t, (socket) => socket.close(code));
    const client = new ThalovantClient(identity, { protocol: "wss", noiseStateDir: await noiseDir(t) });
    await assert.rejects(client.connect(4000), (error: unknown) => {
      assert.ok(error instanceof ThalovantConnectionError, String(error));
      assert.equal(error instanceof ThalovantHubRefusedError, refusal, String(error));
      return true;
    });
    await client.close();
  }
});

test("a hub that closes right after the handshake is a refusal to a kept link", async (t) => {
  let connections = 0;
  const identity = await hubServer(t, (socket) => {
    connections += 1;
    // One static key for every connection, as a real hub has: the client pins it.
    const hub = createV3HubPeer("secret", (data, binary) => socket.send(data, { binary }), {
      staticPrivateKey: new Uint8Array(32).fill(7),
    });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      hub.onMessage(isBinary ? new Uint8Array(data) : data.toString());
      // The client's encrypted HELLO is its first message after the handshake.
      if (hub.received.length === 1) socket.close(1008);
    });
    hub.start();
  });
  const noiseStateDir = await noiseDir(t);
  const session = HubSession.forIdentity(identity, {
    client: { protocol: "wss", noiseStateDir },
    warm: false,
    settleSeconds: 2,
    policy: new HubSessionPolicy(0.01, 0.02, 0.05, 0.01, 0.3),
  });
  t.after(() => session.close());
  await assert.rejects(session.run(), ThalovantHubRefusedError);
  assert.ok(connections >= 2, `${connections} connections`);

  // The same close long after the handshake is an ordinary drop.
  const client = new ThalovantClient(identity, { protocol: "wss", noiseStateDir });
  t.after(() => client.close());
  await client.connect(8000);
  await waitUntil(() => client.connectionInfo().phase === "closed");
  const info = client.connectionInfo();
  assert.equal(info.closeCode, 1008);
  assert.equal(info.refused, true, "the transport reports the code; only the settle window treats it as a verdict");
});
