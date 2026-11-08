/**
 * Browser sign-in against the shared `browser-login-vectors.json`.
 *
 * The pure sections (PKCE, the redirect, the authorization URL, the
 * configuration, the browser rule, what a callback means) run against the
 * functions that decide them; the callbacks run a second time through a real
 * loopback listener. `sign_ins` and `chooser` run for real: a loopback
 * `node:http` peer serves each case's exchanges in order and checks every
 * request the SDK sends (method, path, body, `Authorization`), and a raw TCP
 * client plays the browser against the port the SDK bound. What the SDK
 * produced is recorded under `<section>/<name>` -- before it is asserted --
 * and compared with the case.
 *
 * Vendored byte for byte from the Python SDK's `contracts/conformance/`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import test from "node:test";
import { inspect } from "node:util";

import {
  browserAuthorizationUrl,
  canOpenBrowser,
  challengeFor,
  loopbackRedirectUri,
  NativeSignInConfig,
  ThalovantApiError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
} from "../src/index.js";
import { classifyRequest, LoopbackListener, type LoopbackCallback } from "../src/loopback.js";
import { record } from "./conformance-record.js";

type Json = Record<string, unknown>;

interface Exchange {
  request: { method: string; path: string; json?: unknown; authorization?: string };
  response: { status: number; content_type: string; body: string };
}

interface BrowserRequest {
  method: string;
  target: string;
}

interface SignInCase {
  name: string;
  call: { scopes?: string[] | null; device_name: string; timeout_ms?: number; then?: string; method?: string };
  exchanges: Exchange[];
  requests: BrowserRequest[];
  expect: Json;
  platform?: string;
  env?: Record<string, string>;
}

interface BrowserVectors {
  state: { min_length: number; alphabet: string };
  verifier: { min_length: number; max_length: number; alphabet: string };
  pages: Record<string, string>;
  page_headers: Record<string, string>;
  prompt: { opening: string; not_opening: string };
  message_excludes: string[];
  pkce: Array<{ name: string; verifier: string; expect: Json }>;
  redirect_uris: Array<{ name: string; port: number; expect: Json }>;
  authorization_urls: Array<{
    name: string;
    input: {
      authorization_endpoint: string;
      client_id: string;
      port: number;
      code_challenge: string;
      state: string;
      scopes: string[] | null;
      device_name: string;
    };
    expect: Json;
  }>;
  config: Array<{ name: string; body: unknown; expect: Json }>;
  environment: Array<{ name: string; platform: string; env: Record<string, string>; expect: Json }>;
  callbacks: Array<{ name: string; request: BrowserRequest; expect: Json }>;
  sign_ins: SignInCase[];
  chooser: SignInCase[];
}

function loadVectors<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test/${name}`, import.meta.url), "utf8")) as T;
}

const BROWSER = loadVectors<BrowserVectors>("browser-login-vectors.json");
const SECTIONS = ["pkce", "redirect_uris", "authorization_urls", "config", "environment", "callbacks", "sign_ins", "chooser"];
const SYNTHETIC_STATE = "Xx0-_yLq7m3Vw9ZtR2cKp4HdN8sFjB6a";
const escapeClass = (alphabet: string): string => alphabet.replace(/[\\\]^-]/g, (char) => `\\${char}`);
const STATE_RULE = new RegExp(`^[${escapeClass(BROWSER.state.alphabet)}]{${BROWSER.state.min_length},}$`);
const VERIFIER_RULE = new RegExp(
  `^[${escapeClass(BROWSER.verifier.alphabet)}]{${BROWSER.verifier.min_length},${BROWSER.verifier.max_length}}$`,
);

function recorded(section: string, name: string, produced: unknown): void {
  record("browser-login-vectors.json", `${section}/${name}`, produced);
}

// -- the pure sections ----------------------------------------------------------

for (const vector of BROWSER.pkce) {
  test(`browser login pkce: ${vector.name}`, async () => {
    const produced = { challenge: await challengeFor(vector.verifier) };
    recorded("pkce", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

for (const vector of BROWSER.redirect_uris) {
  test(`browser login redirect_uris: ${vector.name}`, () => {
    let produced: Json;
    try {
      produced = { redirect_uri: loopbackRedirectUri(vector.port) };
    } catch (error) {
      assert.ok(error instanceof RangeError, String(error));
      produced = { error: "invalid_port" };
    }
    recorded("redirect_uris", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

for (const vector of BROWSER.authorization_urls) {
  test(`browser login authorization_urls: ${vector.name}`, () => {
    const given = vector.input;
    const produced = {
      url: browserAuthorizationUrl(given.authorization_endpoint, {
        clientId: given.client_id,
        redirectUri: loopbackRedirectUri(given.port),
        codeChallenge: given.code_challenge,
        state: given.state,
        scopes: given.scopes,
        deviceName: given.device_name,
      }),
    };
    recorded("authorization_urls", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

for (const vector of BROWSER.config) {
  test(`browser login config: ${vector.name}`, () => {
    let produced: Json;
    try {
      const config = NativeSignInConfig.fromResponse(vector.body);
      produced = {
        usable: true,
        authorization_endpoint: config.authorizationEndpoint,
        token_endpoint: config.tokenEndpoint,
        sdk_client_id: config.sdkClientId,
      };
    } catch (error) {
      // Unusable is an error with no status: the API did not refuse.
      assert.ok(error instanceof ThalovantApiError, String(error));
      assert.equal(error.statusCode, undefined);
      produced = { usable: false };
    }
    recorded("config", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

for (const vector of BROWSER.environment) {
  test(`browser login environment: ${vector.name}`, () => {
    const produced = { browser: canOpenBrowser(vector.env, vector.platform) };
    recorded("environment", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });
}

function callbackOutcome(status: number, callback: LoopbackCallback | null): Json {
  if (!callback) return { status, outcome: "ignored" };
  if (callback.outcome === "code") return { status, outcome: "code", code: callback.code };
  if (callback.outcome === "denied") return { status, outcome: "denied" };
  return { status, outcome: "failed", error: callback.error ?? null };
}

for (const vector of BROWSER.callbacks) {
  test(`browser login callbacks: ${vector.name}`, () => {
    const target = vector.request.target.replaceAll("{state}", SYNTHETIC_STATE);
    const [status, callback] = classifyRequest(vector.request.method, target, SYNTHETIC_STATE);
    const produced = callbackOutcome(status, callback);
    recorded("callbacks", vector.name, produced);
    assert.deepEqual(produced, vector.expect);
  });

  test(`browser login callbacks over the listener: ${vector.name}`, async () => {
    const listener = new LoopbackListener(SYNTHETIC_STATE);
    const port = await listener.start();
    try {
      const target = vector.request.target.replaceAll("{state}", SYNTHETIC_STATE);
      const answer = await http(port, vector.request.method, target, () => listener.finish(false));
      checkPageHeaders(answer);
      const accepted = await listener.wait(0);
      assert.deepEqual(callbackOutcome(answer.status, accepted), vector.expect);
    } finally {
      await listener.close();
    }
  });
}

// -- a browser, and an API, on loopback ----------------------------------------------

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
  page: string | null;
}

/** One request on its own connection, as a browser tab sends it; the whole answer, read to its end. */
async function http(port: number, method: string, target: string, beforeReading?: () => void): Promise<Answer> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks)));
    socket.once("connect", () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`, "utf8");
      if (beforeReading) setTimeout(beforeReading, 50);
    });
  });
  const split = raw.indexOf("\r\n\r\n");
  assert.ok(split > 0, `no answer: ${JSON.stringify(raw.toString("latin1"))}`);
  const lines = raw.subarray(0, split).toString("latin1").split("\r\n");
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const body = raw.subarray(split + 4).toString("utf8");
  const page = Object.entries(BROWSER.pages).find(([, text]) => body.includes(text))?.[0] ?? null;
  return { status: Number(lines[0].split(" ")[1]), headers, body, page };
}

function checkPageHeaders(answer: Answer): void {
  for (const [name, value] of Object.entries(BROWSER.page_headers)) {
    assert.equal(answer.headers[name], value, `${name} in ${JSON.stringify(answer.headers)}`);
  }
  // Self-contained: nothing for the page to load.
  for (const loads of ["src=", "href=", "http"]) assert.ok(!answer.body.includes(loads), answer.body);
}

/** Whether a new connection to the port is refused. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

function base64UrlSha256(text: string): string {
  return createHash("sha256").update(text, "ascii").digest("base64url");
}

/** What the test learnt from the URL the SDK built. */
class Signing {
  readonly endpoint: string;
  readonly pairs: Array<[string, string]>;
  readonly port: number;
  readonly state: string;
  readonly challenge: string;

  constructor(url: string) {
    const mark = url.indexOf("?");
    assert.ok(mark > 0, url);
    this.endpoint = url.slice(0, mark);
    this.pairs = [...new URLSearchParams(url.slice(mark + 1))];
    const values = Object.fromEntries(this.pairs);
    const redirect = new URL(values.redirect_uri);
    this.port = Number(redirect.port);
    this.state = values.state;
    this.challenge = values.code_challenge;
    assert.match(this.state, STATE_RULE, "state must be at least 128 bits of base64url");
    assert.match(this.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(values.redirect_uri, `http://127.0.0.1:${this.port}/callback`);
    assert.ok(this.port >= 1024 && this.port <= 65535, String(this.port));
  }

  normalized(text: string): string {
    return text
      .replaceAll(`http://127.0.0.1:${this.port}/callback`, "http://127.0.0.1:{port}/callback")
      .replaceAll(this.state, "{state}")
      .replaceAll(this.challenge, "{challenge}");
  }

  urlRecord(): Json {
    return { endpoint: this.endpoint, query: this.pairs.map(([key, value]) => [key, this.normalized(value)]) };
  }
}

/** Serves a case's exchanges in order and checks each request against its own. */
class ScriptedApi {
  readonly sent: string[] = [];
  readonly mismatches: string[] = [];
  index = 0;
  url = "";
  signing?: Signing;
  exchange?: Json;
  verifier?: string;
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

  /** The exchange body with the generated values put back as placeholders, once proven. */
  private tokenBody(body: unknown): unknown {
    if (!body || typeof body !== "object" || Array.isArray(body) || !this.signing) return body;
    const fields = body as Json;
    const keys = Object.keys(fields).sort();
    if (JSON.stringify(keys) !== JSON.stringify(["client_id", "code", "code_verifier", "redirect_uri"])) {
      this.mismatches.push(`the exchange must carry exactly four fields, not ${JSON.stringify(keys)}`);
    }
    const clean: Json = {};
    for (const [key, value] of Object.entries(fields)) {
      clean[key] = typeof value === "string" ? this.signing.normalized(value) : value;
    }
    const verifier = fields.code_verifier;
    if (typeof verifier === "string" && VERIFIER_RULE.test(verifier) && base64UrlSha256(verifier) === this.signing.challenge) {
      clean.code_verifier = "{verifier}";
      this.verifier = verifier;
    } else {
      this.mismatches.push("the code_verifier is not the one the challenge was made from");
    }
    this.exchange = clean;
    return clean;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    this.sent.push(`${request.method} ${path}`);
    const exchange = this.exchanges[this.index];
    if (!exchange) {
      this.mismatches.push(`unexpected ${request.method} ${path}`);
      response.writeHead(599).end("{}");
      return;
    }
    this.index += 1;
    const expected = exchange.request;
    if (request.method !== expected.method || path !== expected.path) {
      this.mismatches.push(`${request.method} ${path} != ${expected.method} ${expected.path}`);
    }
    let body: unknown = raw ? JSON.parse(raw) : null;
    const carriesVerifier = !!body && typeof body === "object" && !Array.isArray(body) && "code_verifier" in body;
    if ((path === expected.path && path === "/v1/auth/native/token") || carriesVerifier) body = this.tokenBody(body);
    if ("json" in expected) {
      try {
        assert.deepStrictEqual(body, expected.json);
      } catch {
        this.mismatches.push(`body ${JSON.stringify(body)} != ${JSON.stringify(expected.json)}`);
      }
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

/** The vectors' result shape, read from what the sign-in resolved or rejected with. */
function result(plane: ThalovantControlPlane, outcome: { value?: Json; error?: unknown }): Json {
  const error = outcome.error;
  if (error !== undefined) {
    if (error instanceof ThalovantDeviceLoginDeniedError) return { outcome: "denied", status: error.statusCode ?? null };
    if (error instanceof ThalovantDeviceLoginExpiredError) return { outcome: "expired", status: error.statusCode ?? null };
    assert.ok(error instanceof ThalovantApiError, String(error));
    const produced: Json = { outcome: "error", status: error.statusCode ?? null, code: error.code ?? null };
    if (error.statusCode !== undefined) produced.detail = error.detail ?? null;
    return produced;
  }
  const token = outcome.value!;
  assert.equal(plane.accessToken, token.access_token);
  assert.equal(plane.tokenId, token.token_id);
  return {
    outcome: "approved",
    token_type: token.token_type,
    scopes: token.scopes,
    expires_at: token.expires_at,
    token_id: token.token_id,
  };
}

/** No synthetic secret, nor the verifier or the state this sign-in generated, in any printed form of the error. */
function noSecrets(error: unknown, api: ScriptedApi): void {
  const hidden = [...BROWSER.message_excludes];
  if (api.verifier) hidden.push(api.verifier);
  if (api.signing) hidden.push(api.signing.state);
  const forms = error instanceof Error
    ? [
        error.message,
        String(error),
        inspect(error),
        JSON.stringify(error),
        error.stack ?? "",
        JSON.stringify((error as ThalovantApiError).problem ?? null),
        JSON.stringify(error.cause ?? null),
      ]
    : [String(error)];
  for (const value of hidden) {
    for (const form of forms) assert.ok(!form.includes(value), "a secret reached the error");
  }
}

function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run one sign-in for real: serve the case's API, take the URL from
 * `handOver`, play the case's browser requests against the port in it, and
 * read what came of it.
 */
async function signIn(
  vector: SignInCase,
  start: (plane: ThalovantControlPlane, handOver: (url: string) => void) => Promise<Json>,
): Promise<{ produced: Json; api: ScriptedApi }> {
  const api = await new ScriptedApi(vector.exchanges).start();
  const plane = new ThalovantControlPlane(api.url);
  try {
    let handOver!: (url: string) => void;
    const opened = new Promise<string>((resolve) => {
      handOver = resolve;
    });
    const task = start(plane, (url) => handOver(url)).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const produced: Json = {};
    const first = await deadline(
      Promise.race([opened.then((url) => ({ url })), task.then(() => ({ url: undefined }))]),
      10_000,
      "the sign-in neither opened a URL nor ended",
    );
    if (first.url !== undefined) {
      const signing = (api.signing = new Signing(first.url));
      produced.authorization_url = signing.urlRecord();
      const browser: Json[] = [];
      for (const request of vector.requests) {
        const answer = await http(signing.port, request.method, request.target.replaceAll("{state}", signing.state));
        checkPageHeaders(answer);
        browser.push(answer.status === 200 ? { status: answer.status, page: answer.page } : { status: answer.status });
      }
      produced.browser = browser;
    }
    const outcome: { value?: Json; error?: unknown } = await deadline(task, 10_000, "the sign-in");
    if ("error" in outcome) noSecrets(outcome.error, api);
    if (api.signing) produced.closed = await refused(api.signing.port);
    if (api.exchange) produced.exchange = api.exchange;
    produced.result = result(plane, outcome);
    if (vector.call.then === "revoke" && (produced.result as Json).outcome === "approved") {
      await plane.revokeApiToken();
      assert.equal(plane.accessToken, undefined);
      assert.equal(plane.tokenId, undefined);
      // Idempotent: revoking again sends nothing.
      await plane.revokeApiToken();
      produced.result = { outcome: "revoked" };
    }
    return { produced, api };
  } finally {
    await api.stop();
  }
}

for (const vector of BROWSER.sign_ins) {
  test(`browser login sign_ins: ${vector.name}`, async () => {
    const call = vector.call;
    let opened = false;
    const { produced, api } = await signIn(vector, (plane, handOver) =>
      plane.browserLogin({
        scopes: call.scopes,
        deviceName: call.device_name,
        openBrowser: false,
        prompt: handOver,
        openUrl: () => {
          opened = true;
        },
        ...(call.timeout_ms !== undefined ? { timeoutMs: call.timeout_ms } : {}),
      }),
    );
    recorded("sign_ins", vector.name, produced);
    assert.equal(opened, false, "openBrowser: false opened the browser");
    assert.deepEqual(api.mismatches, []);
    assert.equal(api.index, vector.exchanges.length, `not every exchange was used: ${JSON.stringify(api.sent)}`);
    assert.deepEqual(produced, vector.expect);
  });
}

const BROWSER_VARIABLES = ["CI", "SSH_CONNECTION", "SSH_TTY", "DISPLAY", "WAYLAND_DISPLAY"];
const NODE_PLATFORMS: Record<string, string> = { macos: "darwin", windows: "win32" };

/** This process as a case's machine, for `run`: its platform and the variables the browser rule reads. */
async function asMachine<T>(vector: SignInCase, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(BROWSER_VARIABLES.map((name) => [name, process.env[name]]));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const name of BROWSER_VARIABLES) delete process.env[name];
    Object.assign(process.env, vector.env ?? {});
    Object.defineProperty(process, "platform", { ...platform, value: NODE_PLATFORMS[vector.platform!] ?? vector.platform });
    return await run();
  } finally {
    Object.defineProperty(process, "platform", platform);
    for (const name of BROWSER_VARIABLES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

for (const vector of BROWSER.chooser) {
  test(`browser login chooser: ${vector.name}`, async () => {
    const call = vector.call;
    const printed: string[] = [];
    const log = console.log;
    console.log = (...items: unknown[]) => void printed.push(items.map(String).join(" "));
    let consent: string | undefined;
    let outcome: { produced: Json; api: ScriptedApi };
    try {
      outcome = await asMachine(vector, () =>
        signIn(vector, (plane, handOver) =>
          plane.interactiveLogin({
            method: call.method as "auto" | "browser" | "device",
            deviceName: call.device_name,
            // The browser the SDK opens. A device login opens its
            // verification page too; only the consent page is this test's
            // to answer.
            openUrl: (url: string) => {
              if (url.includes("response_type=code")) {
                consent = url;
                handOver(url);
              }
            },
            ...(call.timeout_ms !== undefined ? { timeoutMs: call.timeout_ms } : {}),
          }),
        ),
      );
    } finally {
      console.log = log;
    }
    const { produced, api } = outcome;
    const method = api.sent.includes("POST /v1/auth/device/authorize") ? "device" : "browser";
    const chosen = { method, result: produced.result };
    recorded("chooser", vector.name, chosen);
    assert.deepEqual(api.mismatches, []);
    assert.equal(api.index, vector.exchanges.length, `not every exchange was used: ${JSON.stringify(api.sent)}`);
    assert.deepEqual(chosen, vector.expect);
    if (consent !== undefined) {
      assert.equal(produced.closed, true);
      // Shown as well as opened: opening a browser can fail without a word.
      assert.ok(printed.includes(BROWSER.prompt.opening.replace("{url}", consent)), JSON.stringify(printed));
    }
  });
}

// -- the file itself ---------------------------------------------------------------

test("browser login: every section of the vectors is run", () => {
  const present = Object.entries(BROWSER)
    .filter(([, value]) => Array.isArray(value) && value.length && typeof value[0] === "object" && "name" in value[0])
    .map(([key]) => key)
    .sort();
  assert.deepEqual(present, [...SECTIONS].sort());
  const total = SECTIONS.reduce((sum, section) => sum + (BROWSER[section as keyof BrowserVectors] as unknown[]).length, 0);
  assert.equal(total, 98);
});

test("browser login: the RFC 7636 vector is the first PKCE case", () => {
  const first = BROWSER.pkce[0];
  assert.equal(first.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.deepEqual(first.expect, { challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" });
});

test("browser login: the listener binds 127.0.0.1 only", async () => {
  const listener = new LoopbackListener("s".repeat(32));
  await listener.start();
  try {
    assert.equal(listener.address?.address, "127.0.0.1");
  } finally {
    await listener.close();
  }
});
