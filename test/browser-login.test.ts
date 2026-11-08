/**
 * Browser sign-in beyond the shared vectors: what is printed and opened, the
 * generated secrets, the listener's own edges, cancellation, and what never
 * reaches an error.
 *
 * `browser-login-vectors.test.ts` runs the contract every SDK shares; these are
 * the parts that are this SDK's own -- its event loop, its stdout, its
 * `AbortSignal` -- or that are about what must *not* happen.
 */
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import test from "node:test";
import { inspect } from "node:util";

import {
  browserAuthorizationUrl,
  canOpenBrowser,
  defaultDeviceName,
  DEFAULT_BROWSER_LOGIN_TIMEOUT_MS,
  LOOPBACK_CALLBACK_PATH,
  MAX_DEVICE_NAME_LENGTH,
  NativeSignInConfig,
  newState,
  newVerifier,
  SDK_CLIENT_ID,
  ThalovantApiError,
  ThalovantApiUnreachableError,
  ThalovantControlPlane,
  ThalovantDeviceLoginDeniedError,
  ThalovantDeviceLoginExpiredError,
  ThalovantDeviceLoginPendingError,
} from "../src/index.js";
import { classifyRequest, LoopbackListener, MAX_REQUEST_HEAD, responseBytes } from "../src/loopback.js";
import { redactSecretsInJson, redactSecretsInJsonNumbers, redactSecretsInString } from "../src/redact.js";

type Json = Record<string, unknown>;

const CONFIG = {
  authorization_endpoint: "https://dash.thalovant.com/authorize",
  token_endpoint: "/v1/auth/native/token",
  device_authorization_endpoint: "/v1/auth/device/authorize",
  sdk_client_id: "thalovant-sdk",
  loopback_redirect_uri: "http://127.0.0.1:{port}/callback",
  code_challenge_methods_supported: ["S256"],
};
const TOKEN = {
  access_token: "tvpat_unit_token_value",
  token_type: "bearer",
  scopes: ["hubs:read"],
  expires_at: "2027-11-08T12:00:00Z",
  token_id: "tok-unit",
  ai_disclosure: "AI",
};

type Route = (body: Json, response: ServerResponse) => void;

/** The config and token routes, and a device login's two, answering as each test needs. */
class Api {
  readonly requests: string[] = [];
  url = "";
  private readonly server = createServer((request, response) => void this.handle(request, response));

  constructor(private readonly routes: Partial<Record<string, Route>> = {}) {}

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    this.requests.push(`${request.method} ${path}`);
    const body = (raw ? JSON.parse(raw) : {}) as Json;
    const route = this.routes[path];
    if (route) return route(body, response);
    if (path === "/v1/auth/native/config") return json(response, 200, CONFIG);
    if (path === "/v1/auth/native/token") return json(response, 200, TOKEN);
    response.writeHead(599).end();
  }
}

function json(response: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(text)) });
  response.end(text);
}

async function withApi<T>(api: Api, run: (api: Api) => Promise<T>): Promise<T> {
  await api.start();
  try {
    return await run(api);
  } finally {
    await api.stop();
  }
}

function parts(url: string): { port: number; state: string; query: URLSearchParams } {
  const query = new URL(url).searchParams;
  return { port: Number(new URL(query.get("redirect_uri")!).port), state: query.get("state")!, query };
}

/** One raw request on its own connection; the status and the body. */
function get(port: number, target: string, raw?: Buffer | string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => {
      const data = Buffer.concat(chunks);
      const split = data.indexOf("\r\n\r\n");
      resolve({ status: Number(data.subarray(0, split).toString("latin1").split(" ")[1]), body: data.subarray(split + 4).toString("utf8") });
    });
    socket.once("connect", () => socket.write(raw ?? `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
  });
}

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

function opened(): { url: Promise<string>; handOver: (url: string) => void } {
  let handOver!: (url: string) => void;
  const url = new Promise<string>((resolve) => {
    handOver = resolve;
  });
  return { url, handOver };
}

async function capturedLog<T>(run: () => Promise<T>): Promise<{ value: T; printed: string[] }> {
  const printed: string[] = [];
  const log = console.log;
  console.log = (...items: unknown[]) => void printed.push(items.map(String).join(" "));
  try {
    return { value: await run(), printed };
  } finally {
    console.log = log;
  }
}

async function asPlatform<T>(platform: string, env: Record<string, string>, run: () => T | Promise<T>): Promise<T> {
  const names = ["CI", "SSH_CONNECTION", "SSH_TTY", "DISPLAY", "WAYLAND_DISPLAY"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, env);
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    return await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

// -- what the person sees ----------------------------------------------------------

test("the URL is printed, then the browser opened without the sign-in waiting on it", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    const calls: string[] = [];
    const { value: token, printed } = await capturedLog(async () => {
      const task = plane.browserLogin({
        deviceName: "unit",
        // An opener that never returns: a console browser can hold its caller.
        openUrl: (url) => {
          calls.push(url);
          seen.handOver(url);
          return new Promise(() => undefined);
        },
      });
      const { port, state } = parts(await seen.url);
      assert.equal((await get(port, `/callback?code=unit-code-value&state=${state}`)).status, 200);
      return task;
    });
    assert.equal(token.access_token, TOKEN.access_token);
    assert.equal(calls.length, 1);
    assert.deepEqual(printed, [`Opening your browser to sign in to Thalovant. If it does not open, visit:\n${calls[0]}`]);
  });
});

test("without openBrowser the URL is only shown, and nobody coming back expires the sign-in", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const { value: error, printed } = await capturedLog(() =>
      plane.browserLogin({ openBrowser: false, timeoutMs: 200, openUrl: () => assert.fail("the browser was opened") })
        .then(() => assert.fail("signed in"), (failure: unknown) => failure),
    );
    assert.ok(error instanceof ThalovantDeviceLoginExpiredError, String(error));
    assert.equal(error.statusCode, undefined);
    assert.match(error.message, /within 0\.2 seconds/);
    assert.equal(printed.length, 1);
    assert.ok(printed[0].startsWith("To sign in to Thalovant, visit:\nhttps://dash.thalovant.com/authorize?response_type=code&"), printed[0]);
  });
});

test("a prompt takes the print's place and does not stop the browser from opening", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    const openedWith: string[] = [];
    const { printed } = await capturedLog(async () => {
      const task = plane.browserLogin({ prompt: seen.handOver, openUrl: (url) => void openedWith.push(url) });
      const url = await seen.url;
      const { port, state } = parts(url);
      await get(port, `/callback?code=unit-code-value&state=${state}`);
      await task;
      assert.deepEqual(openedWith, [url]);
    });
    assert.deepEqual(printed, []);
  });
});

test("a browser that cannot open changes nothing", async () => {
  for (const openUrl of [
    () => {
      throw new Error("no runnable browser");
    },
    () => Promise.reject(new Error("no runnable browser")),
  ]) {
    await withApi(new Api(), async ({ url: apiUrl }) => {
      const plane = new ThalovantControlPlane(apiUrl);
      const seen = opened();
      const task = plane.browserLogin({ prompt: seen.handOver, openUrl });
      const { port, state } = parts(await seen.url);
      await get(port, `/callback?code=unit-code-value&state=${state}`);
      assert.equal((await task).token_id, "tok-unit");
    });
  }
});

test("the device name defaults to this SDK on this host, cut to 120 code points", (t) => {
  // The named export the SDK imported follows the module object once synced.
  const named = (host: () => string): void => {
    t.mock.method(os, "hostname", host);
    syncBuiltinESMExports();
  };
  try {
    for (const [host, expected] of [
      ["workstation", "thalovant-node-sdk on workstation"],
      ["  padded  ", "thalovant-node-sdk on padded"],
      ["", "thalovant-node-sdk"],
    ]) {
      named(() => host);
      assert.equal(defaultDeviceName(), expected);
    }
    named(() => "\u{1F399}".repeat(300));
    assert.equal(Array.from(defaultDeviceName()).length, MAX_DEVICE_NAME_LENGTH);
    assert.ok(!defaultDeviceName().endsWith("\uD83C"), "a cut never splits a character");
    named(() => {
      throw new Error("no hostname");
    });
    assert.equal(defaultDeviceName(), "thalovant-node-sdk");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("the default device name reaches the consent page", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver, timeoutMs: 100 }).catch((error: unknown) => error);
    const { query } = parts(await seen.url);
    assert.ok((await task) instanceof ThalovantDeviceLoginExpiredError);
    assert.equal(query.get("device_name"), defaultDeviceName());
    assert.equal(query.get("client_id"), SDK_CLIENT_ID);
    assert.equal(query.get("scope"), null);
  });
});

test("the constants are the contract's", () => {
  assert.equal(SDK_CLIENT_ID, "thalovant-sdk");
  assert.equal(LOOPBACK_CALLBACK_PATH, "/callback");
  assert.equal(DEFAULT_BROWSER_LOGIN_TIMEOUT_MS, 300_000);
  assert.equal(MAX_DEVICE_NAME_LENGTH, 120);
});

// -- the secrets -------------------------------------------------------------------

test("every verifier and state is fresh and well formed", () => {
  const verifiers = new Set(Array.from({ length: 50 }, () => newVerifier()));
  const states = new Set(Array.from({ length: 50 }, () => newState()));
  assert.equal(verifiers.size, 50);
  assert.equal(states.size, 50);
  for (const verifier of verifiers) assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  // 24 random bytes: 192 bits, well over the 128 the contract asks for.
  for (const state of states) assert.match(state, /^[A-Za-z0-9_-]{32}$/);
});

test("the verifier never reaches the browser, and the state is in the URL once", async () => {
  let verifier = "";
  const api = new Api({
    "/v1/auth/native/token": (body, response) => {
      verifier = String(body.code_verifier);
      json(response, 200, TOKEN);
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver });
    const url = await seen.url;
    const { port, state } = parts(url);
    await get(port, `/callback?code=unit-code-value&state=${state}`);
    await task;
    assert.ok(verifier.length >= 43);
    assert.ok(!url.includes(verifier));
    assert.equal(url.split(state).length, 2);
  });
});

test("an echoed code and verifier never reach the error, its problem or its cause", async () => {
  const sent: Json = {};
  const api = new Api({
    "/v1/auth/native/token": (body, response) => {
      Object.assign(sent, body);
      // A validation error lists each field's input, as FastAPI's 422 does,
      // and a secret in a key, too.
      const detail = Object.entries(body).map(([key, value]) => ({ loc: ["body", key], msg: "bad", input: value }));
      json(response, 422, { detail, [`seen:${String(body.code)}`]: "x" });
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await seen.url);
    const page = await get(port, `/callback?code=secret-code-value&state=${state}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("Sign-in was not completed."));
    const error = await task;
    assert.ok(error instanceof ThalovantApiError, String(error));
    assert.equal(error.constructor, ThalovantApiError);
    assert.equal(error.statusCode, 422);
    const shown = [error.message, String(error), inspect(error), JSON.stringify(error), error.stack ?? "", JSON.stringify(error.problem), String(error.detail)].join("\n");
    for (const secret of [sent.code, sent.code_verifier, state]) assert.ok(!shown.includes(String(secret)), String(secret));
    assert.ok(JSON.stringify(error.problem).includes("[redacted]"));
    assert.equal(error.cause, undefined);
    assert.equal(plane.accessToken, undefined);
  });
});

test("a cleartext API is refused before anything is asked or opened", async () => {
  const asked: string[] = [];
  const plane = new ThalovantControlPlane("http://control.example.test", {
    fetch: (async (url: URL) => {
      asked.push(String(url));
      throw new Error("nothing may be sent");
    }) as unknown as typeof fetch,
  });
  const openUrl = () => assert.fail("the browser was opened");
  await assert.rejects(plane.browserLogin({ openBrowser: false, openUrl }), (error: unknown) => error instanceof TypeError && /cleartext/.test(error.message));
  await assert.rejects(plane.interactiveLogin({ method: "browser", openUrl }), (error: unknown) => error instanceof TypeError && /cleartext/.test(error.message));
  // On a desktop, auto counts a cleartext API as one without browser sign-in:
  // it never asks for the configuration, and the device login refuses the
  // cleartext itself.
  await asPlatform("darwin", {}, () =>
    assert.rejects(plane.interactiveLogin({ openUrl }), (error: unknown) => error instanceof ThalovantApiError && /HTTPS/.test(error.message)),
  );
  assert.deepEqual(asked, []);
});

test("interactiveLogin refuses a method it does not know, and a bad timeout is refused before anything", async () => {
  const plane = new ThalovantControlPlane("http://127.0.0.1:9");
  await assert.rejects(plane.interactiveLogin({ method: "password" as never }), (error: unknown) => error instanceof TypeError && /"auto"/.test(error.message));
  await assert.rejects(plane.browserLogin({ timeoutMs: -1 }), RangeError);
  await assert.rejects(plane.browserLogin({ timeoutMs: Number.NaN }), RangeError);
});

// -- cancellation ------------------------------------------------------------------

test("cancelling the sign-in closes the port", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    const controller = new AbortController();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver, signal: controller.signal }).catch((error: unknown) => error);
    const { port } = parts(await seen.url);
    controller.abort();
    const error = await task;
    assert.ok(error instanceof Error && error.name === "AbortError", String(error));
    assert.ok(await refused(port));
  });
});

test("a signal that has already aborted asks for nothing", async () => {
  const api = new Api();
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(plane.browserLogin({ signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(plane.interactiveLogin({ method: "device", signal: controller.signal }), { name: "AbortError" });
    assert.deepEqual(api.requests, []);
  });
});

test("cancelling the chooser's device login stops its polling", async () => {
  const api = new Api({
    "/v1/auth/device/authorize": (_body, response) =>
      json(response, 200, {
        device_code: "dc-unit-device-code",
        user_code: "WDJB-MJHT",
        verification_uri: "https://thalovant.com/activate",
        expires_in: 900,
        interval: 1,
      }),
    "/v1/auth/device/token": (_body, response) => json(response, 400, { error: "authorization_pending" }),
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const controller = new AbortController();
    const { value: error } = await capturedLog(async () => {
      const task = plane.interactiveLogin({ method: "device", signal: controller.signal, openUrl: () => undefined }).catch((failure: unknown) => failure);
      while (!api.requests.includes("POST /v1/auth/device/token")) await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      return task;
    });
    assert.ok(error instanceof Error && error.name === "AbortError", String(error));
    const polls = api.requests.filter((request) => request === "POST /v1/auth/device/token").length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(api.requests.filter((request) => request === "POST /v1/auth/device/token").length, polls);
    assert.equal(plane.accessToken, undefined);
  });
});

// -- the listener's own edges ------------------------------------------------------

test("a connection that sends nothing does not hold the sign-in", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver });
    const { port, state } = parts(await seen.url);
    // A browser opens connections it never uses.
    const idle: Socket = connect(port, "127.0.0.1");
    idle.on("error", () => undefined);
    await new Promise((resolve) => idle.once("connect", resolve));
    const started = performance.now();
    assert.equal((await get(port, `/callback?code=unit-code-value&state=${state}`)).status, 200);
    await task;
    assert.ok(performance.now() - started < 900, "the sign-in waited on an idle connection");
    idle.destroy();
  });
});

test("a request that is not one is 400, and the wait goes on", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    let settled = false;
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).finally(() => {
      settled = true;
    });
    const { port, state } = parts(await seen.url);
    assert.equal((await get(port, "", "hello\r\n\r\n")).status, 400);
    assert.equal((await get(port, "", "GET  /callback HTTP/1.1\r\n\r\n")).status, 400);
    const tooBig = `GET /callback?code=${"a".repeat(MAX_REQUEST_HEAD + 10)} HTTP/1.1\r\n\r\n`;
    assert.equal((await get(port, "", tooBig)).status, 400);
    assert.equal(settled, false);
    assert.equal((await get(port, `/callback?code=unit-code-value&state=${state}`)).status, 200);
    assert.equal((await task).access_token, TOKEN.access_token);
  });
});

test("a second answer after the first is turned away, and the port stops listening", async () => {
  const listener = new LoopbackListener("the-state-of-this-sign-in");
  const port = await listener.start();
  try {
    // Both connected before the first is accepted, so the second still
    // reaches the listener after the port has stopped listening.
    const read = (socket: Socket): Promise<string> =>
      new Promise((resolve) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
    const first = connect(port, "127.0.0.1");
    const second = connect(port, "127.0.0.1");
    await Promise.all([first, second].map((socket) => new Promise((resolve) => socket.once("connect", resolve))));
    const firstAnswer = read(first);
    const secondAnswer = read(second);
    const request = "GET /callback?code=unit-code-value&state=the-state-of-this-sign-in HTTP/1.1\r\n\r\n";
    first.write(request);
    const accepted = await listener.wait(5_000);
    assert.equal(accepted?.code, "unit-code-value");
    assert.ok(await refused(port));
    second.write(request);
    assert.ok((await secondAnswer).startsWith("HTTP/1.1 400 "));
    listener.finish(true);
    assert.ok((await firstAnswer).includes("Signed in to Thalovant."));
  } finally {
    await listener.close();
  }
});

test("the wait is never cut short", async () => {
  const listener = new LoopbackListener("s");
  await listener.start();
  try {
    const started = performance.now();
    assert.equal(await listener.wait(250), null);
    assert.ok(performance.now() - started >= 250);
  } finally {
    await listener.close();
  }
});

test("a listener is started once, and waited on only once started", async () => {
  await assert.rejects(new LoopbackListener("s").wait(0), /not started/);
  const listener = new LoopbackListener("s");
  await listener.start();
  try {
    await assert.rejects(listener.start(), /already started/);
  } finally {
    await listener.close();
  }
});

test("a connection that closes before its whole request head changes nothing", async () => {
  const listener = new LoopbackListener("the-state");
  const port = await listener.start();
  try {
    const gone = connect(port, "127.0.0.1");
    await new Promise((resolve) => gone.once("connect", resolve));
    gone.end("GET /callback?code=c&st");
    await new Promise((resolve) => gone.once("close", resolve));
    assert.equal(await listener.wait(50), null);
    const reply = get(port, "/callback?code=unit-code-value&state=the-state");
    assert.ok(await listener.wait(1_000));
    listener.finish(false);
    const { status, body } = await reply;
    assert.equal(status, 200);
    assert.ok(body.includes("Sign-in was not completed."));
  } finally {
    await listener.close();
  }
});

test("the accepted tab waits as long as the sign-in takes", async () => {
  // The page says how the sign-in ended, so it is written once it has,
  // however long the exchange took: there is no deadline of its own.
  const listener = new LoopbackListener("the-state");
  const port = await listener.start();
  try {
    const started = performance.now();
    let answered = false;
    const tab = get(port, "/callback?code=c&state=the-state").finally(() => {
      answered = true;
    });
    assert.ok(await listener.wait(5_000));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(answered, false);
    listener.finish(true);
    const { body } = await tab;
    assert.ok(body.includes("Signed in to Thalovant. You can close this tab."));
    assert.ok(performance.now() - started >= 300);
  } finally {
    await listener.close();
  }
});

test("closing the listener answers a tab that is still waiting", async () => {
  const listener = new LoopbackListener("the-state");
  const port = await listener.start();
  const tab = get(port, "/callback?code=c&state=the-state");
  assert.ok(await listener.wait(5_000));
  await listener.close();
  assert.ok((await tab).body.includes("Sign-in was not completed."));
});

test("a request that sends no head in time is dropped", async () => {
  const listener = new LoopbackListener("the-state", { requestReadTimeoutMs: 50 });
  const port = await listener.start();
  try {
    const slow = connect(port, "127.0.0.1");
    slow.on("error", () => undefined);
    await new Promise((resolve) => slow.once("connect", resolve));
    slow.write("GET /callback");
    await new Promise((resolve) => slow.once("close", resolve));
    assert.equal(await listener.wait(0), null);
  } finally {
    await listener.close();
  }
});

test("every answer is a whole, self-contained page", () => {
  for (const status of [200, 400, 404]) {
    const text = responseBytes(status, "x").toString("utf8");
    const [head, body] = text.split("\r\n\r\n");
    assert.match(head, new RegExp(`^HTTP/1\\.1 ${status} `));
    assert.ok(head.includes("\r\nConnection: close"));
    assert.ok(head.includes(`\r\nContent-Length: ${Buffer.byteLength(body)}`));
    assert.ok(!/<script|<link|<img|<style|src=|href=/i.test(body), body);
  }
});

test("a callback is read the way a form reads it", () => {
  const state = "S".repeat(32);
  // `+` is a space and a stray `%` is kept; `?` before the query is part of it.
  assert.deepEqual(classifyRequest("GET", `/callback?code=a+b%zz&state=${state}`, state), [200, { outcome: "code", code: "a b%zz" }]);
  assert.deepEqual(classifyRequest("GET", `/callback??state=${state}&code=x`, state), [400, null]);
  assert.deepEqual(classifyRequest("GET", `/callback?&&state=${state}&&code=x&`, state), [200, { outcome: "code", code: "x" }]);
  assert.deepEqual(classifyRequest("GET", `/callback?state=${state}&code`, state), [200, { outcome: "failed", error: null }]);
  assert.deepEqual(classifyRequest("GET", `/callback?state=${state}&code=%E2%82%AC%FF`, state), [200, { outcome: "code", code: "€�" }]);
  // A character outside ASCII is kept as it came; the runs around it are still decoded.
  assert.deepEqual(classifyRequest("GET", `/callback?state=${state}&code=%41é%42`, state), [200, { outcome: "code", code: "AéB" }]);
  assert.deepEqual(classifyRequest("GET", `/callback?error=access_denied&error=access_denied&state=${state}`, state), [200, { outcome: "failed", error: "access_denied" }]);
  assert.deepEqual(classifyRequest("GET", `http://127.0.0.1:1024/callback?code=x&state=${state}`, state), [404, null]);
});

// -- the configuration and the browser rule ------------------------------------------

test("this machine is named as the browser rule names it", async () => {
  for (const [platform, env, browser] of [
    ["darwin", {}, true],
    ["win32", {}, true],
    ["linux", {}, false],
    ["linux", { DISPLAY: ":0" }, true],
    ["linux", { WAYLAND_DISPLAY: "wayland-0" }, true],
    ["freebsd", { DISPLAY: ":0" }, true],
    ["android", {}, false],
    ["darwin", { SSH_TTY: "/dev/ttys001" }, false],
  ] as const) {
    assert.equal(await asPlatform(platform, env, () => canOpenBrowser()), browser, `${platform} ${JSON.stringify(env)}`);
  }
});

test("an authorization endpoint no browser can open is unusable", () => {
  for (const endpoint of [
    "https://dash.thalovant.com/author\u0007ize",
    "https://dash.thalovant.com /authorize",
    "https://dash.thalovant.com/authorize ",
    "https://dash.thalovant.com:99999/authorize",
    "https://dash.thalovant.com:0/authorize",
    "https://dash.thalovant.com:00/authorize",
    "https://dash.thalovant.com:8x/authorize",
    "https://[::1/authorize",
    "https://[nonsense]/authorize",
    "https://dash.thalovant.com\\@evil.example/authorize",
    "https:dash.thalovant.com/authorize",
    "https://dash.thalovant.com/authorize?",
    "https://:443/authorize",
    "ftp://dash.thalovant.com/authorize",
    "http://[::2]/authorize",
    "https://-dash.example/authorize",
    "https://dash-.example/authorize",
    "https://dash.example./authorize",
    "https://1.2.3/authorize",
    "https://01.2.3.4/authorize",
    "https://[1.2.3.4]/authorize",
    `https://${"a".repeat(64)}.example/authorize`,
    `https://${"abcdefghi.".repeat(25)}example/authorize`,
    "https://DASH_staging.example/authorize",
    "",
    42,
  ]) {
    assert.throws(() => NativeSignInConfig.fromResponse({ ...CONFIG, authorization_endpoint: endpoint }), ThalovantApiError, String(endpoint));
  }
  for (const endpoint of [
    "http://[::1]:5173/authorize",
    "HTTPS://Dash.Thalovant.com:443/authorize",
    "http://127.0.0.1/authorize",
    "https://[2001:db8::1]/authorize",
    "https://xn--dsh-0na.example/authorize",
    `https://${"a".repeat(63)}.example/authorize`,
    "https://localhost/authorize",
  ]) {
    assert.equal(NativeSignInConfig.fromResponse({ ...CONFIG, authorization_endpoint: endpoint }).authorizationEndpoint, endpoint);
  }
});

test("a token endpoint that is not a path on the API, or a client id out of shape, is unusable", () => {
  for (const token of [
    "/v1/auth/native/token#x",
    "/v1\\auth",
    "/v1/auth native",
    "v1/auth/native/token",
    7,
    "/https://collector.example/token",
    "/collector.example:443/token",
    "/v1/a:b",
    "/v1/%7",
    "/v1/%7G",
    "/v1/%",
  ]) {
    assert.throws(() => NativeSignInConfig.fromResponse({ ...CONFIG, token_endpoint: token }), ThalovantApiError, String(token));
  }
  for (const clientId of ["", "a".repeat(65), "thalovant sdk", "thalovant-sdk\n", null]) {
    assert.throws(() => NativeSignInConfig.fromResponse({ ...CONFIG, sdk_client_id: clientId }), ThalovantApiError, String(clientId));
  }
  assert.throws(() => NativeSignInConfig.fromResponse({ ...CONFIG, code_challenge_methods_supported: "S256" }), ThalovantApiError);
  assert.equal(NativeSignInConfig.fromResponse({ ...CONFIG, token_endpoint: "/v1/%2Fx/%74oken" }).tokenEndpoint, "/v1/%2Fx/%74oken");
  const config = NativeSignInConfig.fromResponse(CONFIG);
  assert.equal(config.deviceAuthorizationEndpoint, "/v1/auth/device/authorize");
  assert.deepEqual(config.toJSON(), {
    authorization_endpoint: CONFIG.authorization_endpoint,
    token_endpoint: CONFIG.token_endpoint,
    sdk_client_id: CONFIG.sdk_client_id,
    device_authorization_endpoint: CONFIG.device_authorization_endpoint,
  });
});

test("a configuration that is not an object is unusable", () => {
  for (const payload of [["not", "an", "object"], null, "text", 1, undefined]) {
    assert.throws(() => NativeSignInConfig.fromResponse(payload), (error: unknown) => error instanceof ThalovantApiError && error.statusCode === undefined);
  }
});

for (const route of ["config", "token"]) {
  test(`a ${route} answer that is not JSON is an error with no status`, async () => {
    const api = new Api({ [`/v1/auth/native/${route}`]: (_body, response) => json(response, 200, "<html>not json</html>", "text/html") });
    await withApi(api, async () => {
      const plane = new ThalovantControlPlane(api.url);
      const seen = opened();
      const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).catch((error: unknown) => error);
      if (route === "token") {
        const { port, state } = parts(await seen.url);
        assert.equal((await get(port, `/callback?code=unit-code-value&state=${state}`)).status, 200);
      }
      const error = await task;
      assert.ok(error instanceof ThalovantApiError, String(error));
      assert.equal(error.statusCode, undefined);
      assert.equal(error.code, undefined);
    });
  });
}

test("a token answer without a token_id forgets the id an earlier sign-in kept", async () => {
  const { token_id: _dropped, ...withoutId } = TOKEN;
  const api = new Api({ "/v1/auth/native/token": (_body, response) => json(response, 200, withoutId) });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    plane.tokenId = "an-earlier-token";
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver });
    const { port, state } = parts(await seen.url);
    await get(port, `/callback?code=unit-code-value&state=${state}`);
    await task;
    assert.equal(plane.accessToken, TOKEN.access_token);
    assert.equal(plane.tokenId, undefined);
  });
});

test("the URL builder leaves the endpoint as given and cuts nothing it need not", () => {
  const url = browserAuthorizationUrl("https://dash.thalovant.com/authorize", {
    redirectUri: "http://127.0.0.1:1024/callback",
    codeChallenge: "c",
    state: "s",
    deviceName: "x".repeat(120),
  });
  assert.ok(url.startsWith("https://dash.thalovant.com/authorize?response_type=code&client_id=thalovant-sdk&"));
  assert.ok(url.endsWith(`&device_name=${"x".repeat(120)}`));
  assert.ok(!url.includes("scope="));
});

// -- review follow-ups (#110) --------------------------------------------------------

/** A `fetch` that answers from a table of paths, recording every URL it was asked for. */
function scriptedFetch(routes: Record<string, () => Response | Promise<Response>>, asked: string[]): typeof fetch {
  return (async (input: URL | string) => {
    const url = new URL(String(input));
    asked.push(url.href);
    const route = routes[url.pathname];
    if (!route) return new Response("{}", { status: 599 });
    return route();
  }) as unknown as typeof fetch;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DEVICE_GRANT = {
  device_code: "dc-unit-device-code",
  user_code: "WDJB-MJHT",
  verification_uri: "https://thalovant.com/activate",
  verification_uri_complete: "https://thalovant.com/activate?code=WDJB-MJHT",
  expires_in: 900,
  interval: 0,
};

/** An answer whose headers arrive and whose body breaks off. */
function brokenBody(): Response {
  return new Response(new ReadableStream({ start: (controller) => controller.error(new Error("connection reset")) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("an echo that spells the secrets another way, or decodes into them, still never reaches the error", async () => {
  const sent: Json = {};
  // The first character of each secret \u-escaped: a spelling the text pass does not know.
  const escaped = (value: string): string => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}${value.slice(1)}`;
  const api = new Api({
    "/v1/auth/native/token": (body, response) => {
      Object.assign(sent, body);
      const text =
        `{"detail":[{"loc":["body","code"],"msg":"bad","input":"${escaped(String(body.code))}"},` +
        `{"loc":["body","code_verifier"],"msg":"bad","input":"${escaped(String(body.code_verifier))}"}],` +
        `"${escaped(String(body.code))}":"seen","state":"${escaped(String(sent.state ?? ""))}"}`;
      response.writeHead(422, { "content-type": "application/json" }).end(text);
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await seen.url);
    sent.state = state;
    await get(port, `/callback?code=secret-code-value&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiError && error.statusCode === 422, String(error));
    const shown = [error.message, inspect(error), JSON.stringify(error), JSON.stringify(error.problem), String(error.detail)].join("\n");
    for (const secret of [sent.code, sent.code_verifier, sent.state]) assert.ok(!shown.includes(String(secret)), String(secret));
    assert.ok(JSON.stringify(error.problem).includes("[redacted]"));
  });
});

test("an escape in front of a secret that starts with its own digit is not cut in two", async () => {
  // `\\u0032` then `2secret...`: replacing the secret's spellings in the text
  // took the 2 out of the escape and left a body that no longer parsed.
  const api = new Api({
    "/v1/auth/native/token": (body, response) => {
      const code = String(body.code);
      const text = `{"detail":"invalid_grant","input":"\\u0032${code.slice(1)}"}`;
      response.writeHead(400, { "content-type": "application/json" }).end(text);
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await seen.url);
    await get(port, `/callback?code=2secret-code-value&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiError, String(error));
    assert.deepEqual(error.problem, { detail: "invalid_grant", input: "[redacted]" });
    assert.equal(error.detail, "invalid_grant");
    assert.ok(!error.message.includes("secret-code-value"), error.message);
  });
});

test("a short code is taken out of the exchange's error wherever it is, and the answer keeps its shape", async () => {
  for (const [type, answer] of [
    ["application/json", '{"detail":[{"loc":["body","code"],"msg":"bad","input":"ab1"}],"note":"cab1n is another word"}'],
    ["text/plain", "the code ab1 was refused (cab1n)"],
  ] as const) {
    const api = new Api({
      "/v1/auth/native/token": (_body, response) => void response.writeHead(400, { "content-type": type }).end(answer),
    });
    await withApi(api, async () => {
      const plane = new ThalovantControlPlane(api.url);
      const seen = opened();
      const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).catch((error: unknown) => error);
      const { port, state } = parts(await seen.url);
      await get(port, `/callback?code=ab1&state=${state}`);
      const error = await task;
      assert.ok(error instanceof ThalovantApiError && error.statusCode === 400, String(error));
      const shown = [error.message, inspect(error), JSON.stringify(error.problem ?? null), String(error.detail)].join("\n");
      assert.ok(!shown.includes("ab1"), shown);
      if (type === "application/json") {
        assert.deepEqual(error.problem, {
          detail: [{ loc: ["body", "code"], msg: "bad", input: "[redacted]" }],
          note: "c[redacted]n is another word",
        });
      } else {
        assert.match(error.message, /the code \[redacted\] was refused \(c\[redacted\]n\)/);
      }
    });
  }
});

test("scrubbing is one pass, longest first, and leaves its marker alone", () => {
  const hidden = ["abc", "abcdef", "c"];
  const everywhere = { everywhere: true };
  assert.equal(redactSecretsInString("xx-abc-abcdef-[redacted]", hidden, everywhere), "xx-[redacted]-[redacted]-[redacted]");
  const once = redactSecretsInJson({ "seen:abcdef": ["c", { deep: "abc" }] }, hidden, everywhere);
  assert.deepEqual(once, { "seen:[redacted]": ["[redacted]", { deep: "[redacted]" }] });
  assert.deepEqual(redactSecretsInJson(once, hidden, everywhere), once);
  assert.equal(redactSecretsInString("nothing hidden", [], everywhere), "nothing hidden");
});

test("decoded scrubbing covers values and keys, and a short secret only where it stands alone", () => {
  assert.equal(redactSecretsInString("x abc y, xabcy, abc", ["abc"]), "x [redacted] y, xabcy, [redacted]");
  assert.equal(redactSecretsInString("long-secret-value!", ["long-secret-value", "long"]), "[redacted]!");
  assert.equal(redactSecretsInString("\u{1F399}abc", ["abc"]), "\u{1F399}[redacted]", "an emoji is not a letter");
  assert.equal(redactSecretsInString("\u00e9abc", ["abc"]), "\u00e9abc", "an accented letter is one");
  // One pass: never inside a [redacted] already there, and a secret that a longer one holds goes with it.
  assert.equal(redactSecretsInString("[redacted] redacted!", ["redacted", "dacted"]), "[redacted] [redacted]!");
  assert.equal(redactSecretsInString("xx-secret-code-value-xx", ["secret-code-value", "code"]), "xx-[redacted]-xx");
  const scrubbed = redactSecretsInJson(JSON.parse('{"__proto__":{"k":"abc"},"abc":["abc",1,null],"x":{"secret-code-value-1":true}}'), [
    "abc",
    "secret-code-value-1",
  ]) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(scrubbed), Object.prototype);
  assert.deepEqual(Object.keys(scrubbed), ["__proto__", "[redacted]", "x"]);
  assert.deepEqual(scrubbed["[redacted]"], ["[redacted]", 1, null]);
  assert.deepEqual(scrubbed.x, { "[redacted]": true });
  assert.deepEqual(redactSecretsInJson({ pin: 12345678, other: 7 }, ["12345678"]), { pin: "[redacted]", other: 7 });
});

for (const path of ["/https://elsewhere.example/v1/x", "/elsewhere.example:443/v1/x", "/{collector}/v1/x", "https://elsewhere.example/v1/x"]) {
  test(`no request leaves the API's origin: ${path}`, async () => {
    // Every request is joined to the API's address with its leading slashes
    // off, so a path that is a URL -- or whose first segment reads as a
    // scheme -- would otherwise be one.
    const collector = await new Api().start();
    const api = await new Api().start();
    try {
      const plane = new ThalovantControlPlane(api.url, { accessToken: "tvpat_must_stay_home" });
      const target = path.replace("{collector}", collector.url);
      const internal = plane as unknown as {
        request(method: string, path: string): Promise<unknown>;
        send(method: string, path: string, options: { body?: Json; auth?: boolean }): Promise<unknown>;
      };
      const error = await internal.request("GET", target).catch((failure: unknown) => failure);
      assert.ok(error instanceof ThalovantApiError && /origin/.test(error.message), String(error));
      assert.equal(error.statusCode, undefined);
      assert.ok(!String(error).includes("tvpat_must_stay_home"));
      await assert.rejects(internal.send("POST", target, { body: { code: "c" }, auth: false }), /origin/);
      assert.deepEqual([...collector.requests, ...api.requests], []);
    } finally {
      await collector.stop();
      await api.stop();
    }
  });
}

test("the exchange never leaves the API's origin, even past the configuration's own check", async () => {
  const collector = await new Api().start();
  const api = await new Api().start();
  try {
    const plane = new ThalovantControlPlane(api.url);
    // Built directly, past NativeSignInConfig.fromResponse().
    const Config = NativeSignInConfig as unknown as new (fields: Json) => NativeSignInConfig;
    const config = new Config({
      authorizationEndpoint: CONFIG.authorization_endpoint,
      tokenEndpoint: `/${collector.url}/v1/auth/native/token`,
      sdkClientId: "thalovant-sdk",
      deviceAuthorizationEndpoint: null,
    });
    const exchange = (plane as unknown as {
      exchangeBrowserCode(config: NativeSignInConfig, secrets: Json, signal: undefined, timeoutMs: number): Promise<unknown>;
    }).exchangeBrowserCode(config, { code: "c", verifier: "v".repeat(43), redirectUri: "http://127.0.0.1:1/callback", state: "s" }, undefined, 10_000);
    const error = await exchange.catch((failure: unknown) => failure);
    assert.ok(error instanceof ThalovantApiError && /origin/.test(error.message), String(error));
    assert.equal(error.statusCode, undefined);
    assert.deepEqual([...collector.requests, ...api.requests], []);
  } finally {
    await collector.stop();
    await api.stop();
  }
});

test("a callback whose error carries the state never repeats it", async () => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const seen = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: seen.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await seen.url);
    await get(port, `/callback?error=x${state}&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiError && error.statusCode === undefined, String(error));
    assert.equal(error.code, undefined);
    for (const form of [error.message, inspect(error), JSON.stringify(error)]) assert.ok(!form.includes(state));
  });
});

test("a leading byte-order mark is part of a callback value", () => {
  const state = "S".repeat(32);
  assert.deepEqual(classifyRequest("GET", `/callback?code=x&state=%EF%BB%BF${state}`, state), [400, null]);
  assert.deepEqual(classifyRequest("GET", `/callback?code=%EF%BB%BFabc&state=${state}`, state), [200, { outcome: "code", code: "\uFEFFabc" }]);
});

test("a sign-in cancelled while its port is bound or its challenge made shows and opens nothing", async (t) => {
  await withApi(new Api(), async ({ url: apiUrl }) => {
    const plane = new ThalovantControlPlane(apiUrl);
    const controller = new AbortController();
    const subtle = globalThis.crypto.subtle;
    const digest = subtle.digest.bind(subtle);
    t.mock.method(subtle, "digest", (...args: Parameters<SubtleCrypto["digest"]>) => {
      controller.abort();
      return digest(...args);
    });
    const shown: string[] = [];
    const { value: error, printed } = await capturedLog(() =>
      plane
        .browserLogin({ signal: controller.signal, prompt: (url) => void shown.push(url), openUrl: (url) => void shown.push(url) })
        .catch((failure: unknown) => failure),
    );
    t.mock.restoreAll();
    assert.ok(error instanceof Error && error.name === "AbortError", String(error));
    assert.deepEqual(shown, []);
    assert.deepEqual(printed, []);
  });
});

test("a configuration answer that breaks off is a configuration failure: auto falls back, a forced browser says so", async () => {
  const asked: string[] = [];
  const routes = {
    "/v1/auth/native/config": brokenBody,
    "/v1/auth/device/authorize": () => jsonResponse(DEVICE_GRANT),
    "/v1/auth/device/token": () => jsonResponse(TOKEN),
  };
  const plane = new ThalovantControlPlane("https://api.example.test", { fetch: scriptedFetch(routes, asked) });
  const { value: token } = await capturedLog(() =>
    asPlatform("darwin", {}, () => plane.interactiveLogin({ openUrl: () => undefined })),
  );
  assert.equal(token.access_token, TOKEN.access_token);
  assert.deepEqual(asked.map((url) => new URL(url).pathname), ["/v1/auth/native/config", "/v1/auth/device/authorize", "/v1/auth/device/token"]);
  await assert.rejects(plane.interactiveLogin({ method: "browser" }), (error: unknown) =>
    error instanceof ThalovantApiUnreachableError && error.statusCode === undefined);
  await assert.rejects(plane.browserLogin(), ThalovantApiUnreachableError);
});

test("an exchange slower than its bound fails the sign-in, and the tab says so", async () => {
  const api = new Api({
    "/v1/auth/native/token": (_body, response) => void setTimeout(() => json(response, 200, TOKEN), 1_000),
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const seen = opened();
    const task = plane
      .browserLogin({ openBrowser: false, prompt: seen.handOver, requestTimeoutMs: 100 })
      .catch((error: unknown) => error);
    const { port, state } = parts(await seen.url);
    const page = await get(port, `/callback?code=unit-code-value&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiUnreachableError && error.statusCode === undefined, String(error));
    assert.ok(page.body.includes("Sign-in was not completed."));
    assert.equal(plane.accessToken, undefined);
  });
});

test("a configuration request slower than its bound sends auto to a device login", async () => {
  const asked: string[] = [];
  const routes = {
    "/v1/auth/native/config": () => new Promise<Response>(() => undefined),
    "/v1/auth/device/authorize": () => jsonResponse(DEVICE_GRANT),
    "/v1/auth/device/token": () => jsonResponse(TOKEN),
  };
  // The scripted fetch never settles the configuration; the bound's signal must end it.
  const fetchImpl = scriptedFetch(routes, asked);
  const bounded = (async (input: URL | string, init?: RequestInit) => {
    const answer = fetchImpl(input, init);
    if (!new URL(String(input)).pathname.endsWith("/config")) return answer;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  }) as typeof fetch;
  const plane = new ThalovantControlPlane("https://api.example.test", { fetch: bounded });
  const { value: token } = await capturedLog(() =>
    asPlatform("win32", {}, () => plane.interactiveLogin({ openUrl: () => undefined, requestTimeoutMs: 100 })),
  );
  assert.equal(token.token_id, TOKEN.token_id);
  assert.ok(asked.some((url) => url.endsWith("/v1/auth/device/authorize")));
});

test("cancelling a device login whose opener never returns ends it, and loginWithBrowser still waits for its opener", async () => {
  const asked: string[] = [];
  const routes = {
    "/v1/auth/device/authorize": () => jsonResponse(DEVICE_GRANT),
    "/v1/auth/device/token": () => jsonResponse(TOKEN),
  };
  const plane = new ThalovantControlPlane("https://api.example.test", { fetch: scriptedFetch(routes, asked) });
  const controller = new AbortController();
  const { value: error } = await capturedLog(async () => {
    const task = plane
      .interactiveLogin({
        method: "device",
        signal: controller.signal,
        openUrl: () => {
          setTimeout(() => controller.abort(), 10);
          return new Promise(() => undefined);
        },
      })
      .catch((failure: unknown) => failure);
    return task;
  });
  assert.ok(error instanceof Error && error.name === "AbortError", String(error));
  assert.ok(!asked.some((url) => url.endsWith("/v1/auth/device/token")), "polled after the cancel");
  // Unchanged without a signal: the device login waits for its opener, then polls.
  const order: string[] = [];
  const waiting = new ThalovantControlPlane("https://api.example.test", {
    fetch: scriptedFetch({ ...routes, "/v1/auth/device/token": () => (order.push("poll"), jsonResponse(TOKEN)) }, []),
  });
  await capturedLog(() =>
    waiting.loginWithBrowser({ openUrl: () => new Promise<void>((resolve) => setTimeout(() => (order.push("opened"), resolve()), 50)) }),
  );
  assert.deepEqual(order, ["opened", "poll"]);
});

test("a NaN or negative wait, or a callback that is not a function, is refused before anything is sent", async () => {
  const asked: string[] = [];
  const plane = new ThalovantControlPlane("https://api.example.test", { fetch: scriptedFetch({}, asked) });
  for (const method of ["auto", "browser", "device"] as const) {
    await assert.rejects(plane.interactiveLogin({ method, timeoutMs: Number.NaN }), RangeError);
    await assert.rejects(plane.interactiveLogin({ method, timeoutMs: -5 }), RangeError);
    await assert.rejects(plane.interactiveLogin({ method, openUrl: "xdg-open" as never }), /openUrl must be a function/);
  }
  await assert.rejects(plane.browserLogin({ openUrl: "xdg-open" as never }), TypeError);
  await assert.rejects(plane.browserLogin({ prompt: "print" as never }), /prompt must be a function/);
  assert.deepEqual(asked, []);
});

// -- the final contract (thalovant-python-sdk#113 at 39e31d8) --------------------------

test("a HEAD request gets the headers and no body", async () => {
  const listener = new LoopbackListener("the-state");
  const port = await listener.start();
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.once("error", reject);
      socket.once("close", () => resolve(Buffer.concat(chunks)));
      socket.once("connect", () => socket.write("HEAD /callback?code=c&state=the-state HTTP/1.1\r\n\r\n"));
    });
    const split = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, split).toString("latin1");
    assert.ok(head.startsWith("HTTP/1.1 404 "), head);
    assert.equal(raw.subarray(split + 4).length, 0);
    assert.ok(head.includes("Content-Type: text/html; charset=utf-8"));
    // What a GET would have carried.
    assert.ok(Number(/Content-Length: (\d+)/.exec(head)?.[1]) > 0);
    assert.equal(await listener.wait(0), null);
  } finally {
    await listener.close();
  }
});

for (const [name, request] of [
  // A head ten times the listener's limit: most of it is never read.
  ["oversized head", Buffer.from(`GET /callback?code=${"a".repeat(600_000)} HTTP/1.1\r\nHost: x\r\n\r\n`)],
  // A body nobody asked for, behind a 404.
  ["unread body", Buffer.concat([Buffer.from("POST /callback HTTP/1.1\r\nHost: x\r\nContent-Length: 600000\r\n\r\n"), Buffer.alloc(600_000, "b")])],
] as const) {
  test(`an early answer is not lost to a reset: ${name}`, async () => {
    // Closing with bytes unread resets the connection, and macOS then drops
    // the answer the browser had not read; Linux shows the reset as ECONNRESET.
    const listener = new LoopbackListener("the-state");
    const port = await listener.start();
    try {
      const { data, ended } = await new Promise<{ data: Buffer; ended: string | null }>((resolve) => {
        const socket = connect(port, "127.0.0.1");
        const chunks: Buffer[] = [];
        let ended: string | null = null;
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", (error: NodeJS.ErrnoException) => {
          ended = error.code ?? error.name;
        });
        socket.once("close", () => resolve({ data: Buffer.concat(chunks), ended }));
        // Sent while the answer is read, as a browser does.
        socket.once("connect", () => socket.write(request));
      });
      const first = data.subarray(0, data.indexOf("\r\n")).toString("latin1");
      assert.ok(["HTTP/1.1 400 Bad Request", "HTTP/1.1 404 Not Found"].includes(first), first);
      assert.equal(ended, null, `the connection ended with ${ended}`);
    } finally {
      await listener.close();
    }
  });
}

test("draining a connection is bounded", async () => {
  // A browser that never closes its side cannot keep a connection open.
  const listener = new LoopbackListener("the-state", { drainTimeoutMs: 200 });
  const port = await listener.start();
  const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      // The answer ends: our side is shut. Theirs stays open.
      socket.once("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      socket.once("connect", () => socket.write("GET /favicon.ico HTTP/1.1\r\n\r\n"));
    });
    assert.ok(answer.startsWith("HTTP/1.1 404 "));
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(listener.openConnections, 0);
  } finally {
    socket.destroy();
    await listener.close();
  }
});

test("a message cut to length keeps no part of a secret", async () => {
  // The verifier starts ten characters before the message's 160-character cut.
  const seen: Json = {};
  const api = new Api({
    "/v1/auth/native/token": (body, response) => {
      Object.assign(seen, body);
      json(response, 400, { detail: "a".repeat(150) + String(body.code_verifier) });
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const handed = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: handed.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await handed.url);
    await get(port, `/callback?code=c&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiError && error.statusCode === 400, String(error));
    const prefix = String(seen.code_verifier).slice(0, 10);
    for (const shown of [error.message, String(error), inspect(error), String(error.detail), JSON.stringify(error.problem)]) {
      assert.ok(!shown.includes(prefix), shown);
    }
    assert.equal(error.detail, `${"a".repeat(150)}[redacted]`);
  });
});

test("a transport failure during the exchange carries nothing of the request", async () => {
  // A failed fetch may keep the request -- its body, the code and the
  // verifier -- on its cause; the error raised must not keep it.
  let sent = "";
  const plane = new ThalovantControlPlane("http://127.0.0.1:9", {
    fetch: (async (input: URL | string, init?: RequestInit) => {
      if (String(input).endsWith("/v1/auth/native/config")) return new Response(JSON.stringify(CONFIG), { status: 200 });
      sent = String(init?.body);
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connection reset"), { requestBody: sent }) });
    }) as unknown as typeof fetch,
  });
  const handed = opened();
  const task = plane.browserLogin({ openBrowser: false, prompt: handed.handOver }).catch((error: unknown) => error);
  const { port, state } = parts(await handed.url);
  await get(port, `/callback?code=transport-code-value&state=${state}`);
  const error = await task;
  assert.ok(error instanceof ThalovantApiUnreachableError && error.statusCode === undefined, String(error));
  assert.equal(error.cause, undefined);
  const verifier = String((JSON.parse(sent) as Json).code_verifier);
  for (const form of [error.message, inspect(error), JSON.stringify(error), error.stack ?? ""]) {
    for (const secret of ["transport-code-value", verifier, state]) assert.ok(!form.includes(secret), form);
  }
});

test("the exchange is sent once, never retried, even when its connection resets", async () => {
  let posts = 0;
  const api = new Api({
    "/v1/auth/native/token": (_body, response) => {
      posts += 1;
      response.socket?.destroy();
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const handed = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: handed.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await handed.url);
    const page = await get(port, `/callback?code=unit-code-value&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiUnreachableError && error.statusCode === undefined, String(error));
    assert.ok(page.body.includes("Sign-in was not completed."));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(posts, 1);
  });
});

test("only a missing device name gets the default; an empty one is left out", async () => {
  for (const [deviceName, expected] of [
    [undefined, defaultDeviceName()],
    [null, defaultDeviceName()],
    ["", null],
  ] as const) {
    await withApi(new Api(), async ({ url: apiUrl }) => {
      const plane = new ThalovantControlPlane(apiUrl);
      const handed = opened();
      const task = plane.browserLogin({ openBrowser: false, prompt: handed.handOver, timeoutMs: 50, deviceName }).catch((error: unknown) => error);
      const { query } = parts(await handed.url);
      assert.ok((await task) instanceof ThalovantDeviceLoginExpiredError);
      assert.equal(query.get("device_name"), expected);
    });
  }
});

// -- CodeRabbit's second review of #110 ------------------------------------------------

/** A JSON escape of `value`'s first character, built here so no tool rewrites it. */
function escapeFirst(value: string): string {
  const backslash = String.fromCharCode(92);
  return `${backslash}u${value.charCodeAt(0).toString(16).padStart(4, "0")}${value.slice(1)}`;
}

test("a fetch that ignores its signal cannot hold the configuration past its bound", async () => {
  const asked: string[] = [];
  const stalled = (async (input: URL | string) => {
    const path = new URL(String(input)).pathname;
    asked.push(path);
    if (path === "/v1/auth/native/config") return new Promise<Response>(() => undefined);
    if (path === "/v1/auth/device/authorize") return jsonResponse(DEVICE_GRANT);
    if (path === "/v1/auth/device/token") return jsonResponse(TOKEN);
    return new Response("{}", { status: 599 });
  }) as unknown as typeof fetch;
  const plane = new ThalovantControlPlane("https://api.example.test", { fetch: stalled });
  const started = performance.now();
  await assert.rejects(plane.browserLogin({ requestTimeoutMs: 100 }), (error: unknown) =>
    error instanceof ThalovantApiUnreachableError && error.statusCode === undefined);
  assert.ok(performance.now() - started < 2_000);
  // auto counts it as a configuration failure, before anything is opened.
  const { value: token } = await capturedLog(() =>
    asPlatform("darwin", {}, () => plane.interactiveLogin({ openUrl: () => undefined, requestTimeoutMs: 100 })),
  );
  assert.equal(token.token_id, TOKEN.token_id);
});

test("an exchange whose body never ends cannot hold the sign-in or its tab past the bound", async () => {
  const stalled = (async (input: URL | string) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/auth/native/config") return jsonResponse(CONFIG);
    // Headers, then a body that never ends, and a signal nobody listens to.
    return new Response(new ReadableStream({ start: () => undefined }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const plane = new ThalovantControlPlane("http://127.0.0.1:9", { fetch: stalled });
  const handed = opened();
  const task = plane
    .browserLogin({ openBrowser: false, prompt: handed.handOver, requestTimeoutMs: 100 })
    .catch((error: unknown) => error);
  const { port, state } = parts(await handed.url);
  const page = await get(port, `/callback?code=unit-code-value&state=${state}`);
  const error = await task;
  assert.ok(error instanceof ThalovantApiUnreachableError && error.statusCode === undefined, String(error));
  assert.ok(page.body.includes("Sign-in was not completed."));
  assert.ok(await refused(port));
  assert.equal(plane.accessToken, undefined);
});

test("completeNativeSignIn takes its code and verifier out of an error wherever they are", async () => {
  const answers = [
    '{"detail":"cab1n"}',
    '{"detail":"bad [redacted]x1 here"}',
    '{"detail":"abcdefghijklmnop"}',
  ];
  const cases: Array<[string, string, string]> = [
    ["ab1", "verifier-value-1234567890", "c[redacted]n"],
    ["[redacted]x1", "verifier-value-1234567890", "bad [redacted] here"],
    ["abc", "bcdefghijklmnop", "[redacted]"],
  ];
  for (const [index, [code, verifier, detail]] of cases.entries()) {
    const plane = new ThalovantControlPlane("https://api.example.test", {
      fetch: (async () => new Response(answers[index], { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    const error = await plane.completeNativeSignIn(code, verifier, "app", "app://auth").catch((failure: unknown) => failure);
    assert.ok(error instanceof ThalovantApiError && error.statusCode === 400, String(error));
    assert.equal(error.detail, detail);
    const shown = [error.message, JSON.stringify(error.problem)].join("\n");
    assert.ok(!shown.replaceAll("[redacted]", "").includes(code.replace("[redacted]", "")), shown);
    assert.ok(!shown.includes(verifier.slice(0, 10)), shown);
  }
});

test("a number that spells a code is taken out before parsing rounds it", async () => {
  const api = new Api({
    "/v1/auth/native/token": (body, response) => {
      const text = `{"detail":"invalid_grant","input":${String(body.code)},"other":42}`;
      response.writeHead(400, { "content-type": "application/json" }).end(text);
    },
  });
  await withApi(api, async () => {
    const plane = new ThalovantControlPlane(api.url);
    const handed = opened();
    const task = plane.browserLogin({ openBrowser: false, prompt: handed.handOver }).catch((error: unknown) => error);
    const { port, state } = parts(await handed.url);
    await get(port, `/callback?code=12345678901234567890&state=${state}`);
    const error = await task;
    assert.ok(error instanceof ThalovantApiError && error.statusCode === 400, String(error));
    assert.deepEqual(error.problem, { detail: "invalid_grant", input: "[redacted]", other: 42 });
    assert.ok(!JSON.stringify(error.problem).includes("1234567890123456"));
  });
});

test("the number pass reads numbers only, and leaves strings and their escapes as written", () => {
  const backslash = String.fromCharCode(92);
  const text = `{"a":"${backslash}u0031${backslash}"12345678","b":12345678,"c":[1.5e3,-12345678,7],"d":"x"}`;
  const out = redactSecretsInJsonNumbers(text, ["12345678"]);
  assert.equal(out, `{"a":"${backslash}u0031${backslash}"12345678","b":"[redacted]","c":[1.5e3,"[redacted]",7],"d":"x"}`);
  assert.deepEqual(JSON.parse(out).c, [1500, "[redacted]", 7]);
  assert.equal(redactSecretsInJsonNumbers(text, ["no digits"]), text);
});

test("a device-token problem is scrubbed however the body spells the code, and still classified", async () => {
  const deviceCode = "dc-unit-device-code";
  for (const [error, kind] of [
    ["authorization_pending", ThalovantDeviceLoginPendingError],
    ["access_denied", ThalovantDeviceLoginDeniedError],
    ["expired_token", ThalovantDeviceLoginExpiredError],
  ] as const) {
    const answer = `{"error":"${error}","echo":"${escapeFirst(deviceCode)}"}`;
    const plane = new ThalovantControlPlane("https://api.example.test", {
      fetch: (async () => new Response(answer, { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    });
    const failure = await plane.pollDeviceLogin(deviceCode).catch((caught: unknown) => caught);
    assert.ok(failure instanceof kind, `${error}: ${String(failure)}`);
    assert.deepEqual((failure as ThalovantApiError).problem, { error, echo: "[redacted]" });
    // The loop behind loginWithBrowser() reads the same way.
    if (error !== "authorization_pending") {
      const looping = await (plane as unknown as {
        pollDeviceToken(code: string, options: Json): Promise<unknown>;
      }).pollDeviceToken(deviceCode, { intervalMs: 0, timeoutMs: 1_000 }).catch((caught: unknown) => caught);
      assert.ok(looping instanceof kind, String(looping));
      assert.deepEqual((looping as ThalovantApiError).problem, { error, echo: "[redacted]" });
    }
  }
});

test("an opener that cancels the sign-in and then rejects leaves nothing unhandled", async () => {
  const unhandled: unknown[] = [];
  const listen = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    const plane = new ThalovantControlPlane("https://api.example.test", {
      fetch: scriptedFetch({ "/v1/auth/device/authorize": () => jsonResponse(DEVICE_GRANT) }, []),
    });
    const controller = new AbortController();
    const { value: error } = await capturedLog(() =>
      plane
        .interactiveLogin({
          method: "device",
          signal: controller.signal,
          openUrl: () => {
            controller.abort();
            return Promise.reject(new Error("the opener failed"));
          },
        })
        .catch((failure: unknown) => failure),
    );
    assert.ok(error instanceof Error && error.name === "AbortError", String(error));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listen);
  }
});

for (const [name, request] of [
  ["a head too large to read", `HEAD /callback?code=${"a".repeat(MAX_REQUEST_HEAD + 10)} HTTP/1.1\r\n\r\n`],
  ["a head with no request line", "HEAD /callback\r\n\r\n"],
] as const) {
  test(`a HEAD gets no body on a 400 either: ${name}`, async () => {
    const listener = new LoopbackListener("the-state");
    const port = await listener.start();
    try {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.once("error", reject);
        socket.once("close", () => resolve(Buffer.concat(chunks)));
        socket.once("connect", () => socket.write(request));
      });
      const split = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, split).toString("latin1");
      assert.ok(head.startsWith("HTTP/1.1 400 "), head);
      assert.equal(raw.subarray(split + 4).length, 0);
      assert.ok(Number(/Content-Length: (\d+)/.exec(head)?.[1]) > 0);
    } finally {
      await listener.close();
    }
  });
}

test("closing waits for the accepted connection to drain, so its page is not reset", async () => {
  const listener = new LoopbackListener("the-state");
  const port = await listener.start();
  // A browser that is still sending when the sign-in ends.
  const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  let failed: string | null = null;
  socket.on("error", (error: NodeJS.ErrnoException) => {
    failed = error.code ?? error.name;
  });
  const page = new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
      // Its last bytes arrive after the page, then it closes.
      setTimeout(() => socket.end("trailing bytes the browser still sent"), 200);
    });
  });
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write("GET /callback?code=c&state=the-state HTTP/1.1\r\n\r\n");
  assert.ok(await listener.wait(5_000));
  listener.finish(true);
  const started = performance.now();
  await listener.close();
  const took = performance.now() - started;
  assert.ok((await page).includes("Signed in to Thalovant."));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(failed, null, `the connection ended with ${failed}`);
  assert.ok(took >= 150 && took < 1_500, `close took ${took} ms`);
  socket.destroy();
});

test("scrubbing replaces overlapping secrets together, and one that starts with the marker", () => {
  const everywhere = { everywhere: true };
  // A short code overlapping the start of a verifier takes the whole verifier with it.
  assert.equal(redactSecretsInString("xx abcdefghijklmnop yy", ["abc", "bcdefghijklmnop"], everywhere), "xx [redacted] yy");
  // By default a short secret glued to a letter stays; the long one is still taken whole.
  assert.equal(redactSecretsInString("abcdefghijklmnop", ["bcdefghijklmnop", "abc"]), "a[redacted]");
  // A secret that begins with the marker is still replaced; nothing inside an existing marker is.
  assert.equal(redactSecretsInString("x [redacted]xyz y", ["[redacted]xyz"], everywhere), "x [redacted] y");
  assert.equal(redactSecretsInString("[redacted]", ["dacted", "red", "d"], everywhere), "[redacted]");
});

test("an error body nested too deep for the stack still gives an error with its status", async () => {
  const depth = 100_000;
  const deep = `{"detail":"invalid_grant","deep":${"[".repeat(depth)}"secret-code-value"${"]".repeat(depth)}}`;
  // With secrets to scrub (completeNativeSignIn) and without (any request).
  const plane = new ThalovantControlPlane("https://api.example.test", {
    accessToken: "token",
    fetch: (async () => new Response(deep, { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
  });
  const scrubbed = await plane.completeNativeSignIn("secret-code-value", "verifier-value-123456789", "app", "app://auth")
    .catch((failure: unknown) => failure);
  assert.ok(scrubbed instanceof ThalovantApiError && scrubbed.statusCode === 400, String(scrubbed));
  assert.equal(scrubbed.detail, "invalid_grant");
  const shown = JSON.stringify(scrubbed.problem);
  assert.ok(!shown.includes("secret-code-value"));
  assert.ok(shown.includes("[redacted]"));
  const plain = await plane.getHub("hub-1").catch((failure: unknown) => failure);
  assert.ok(plain instanceof ThalovantApiError && plain.statusCode === 400, String(plain));
  assert.equal(plain.detail, "invalid_grant");
  JSON.stringify(plain.problem);
});
