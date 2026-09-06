/**
 * Browser bundling smoke test. Bundles the built SDK with esbuild in
 * `platform: "browser"` mode (exercising the `exports`/`browser` maps in
 * package.json exactly like a consumer bundler would), asserts that no Node
 * builtins, `ws`, or `mqtt` code end up in the bundle, then executes the
 * bundle in a DOM-less `node:vm` sandbox without `process` or `Buffer`,
 * driving the control plane through a stubbed `fetch` and a WSS client
 * through a stubbed global `WebSocket`. No real network access is involved.
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

import { createV3HubPeer } from "./v3-hub.js";

// Compiled location is dist/test/, so the repository root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const bundlePromise = buildBrowserBundle();

async function buildBrowserBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-sdk-browser-"));
  try {
    // Resolve "@thalovant/sdk" like an installed package so the exports map
    // and the browser file substitutions in package.json are honored.
    await mkdir(join(dir, "node_modules", "@thalovant"), { recursive: true });
    await symlink(repoRoot, join(dir, "node_modules", "@thalovant", "sdk"), "junction");
    await writeFile(join(dir, "entry.js"), [
      'import { HiveMindMqttTransport, ThalovantClient, ThalovantControlPlane, ThalovantIdentity } from "@thalovant/sdk";',
      "globalThis.__thalovantSdk = { HiveMindMqttTransport, ThalovantClient, ThalovantControlPlane, ThalovantIdentity };",
      "",
    ].join("\n"), "utf8");
    const result = await build({
      absWorkingDir: dir,
      entryPoints: [join(dir, "entry.js")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent",
    });
    return result.outputFiles[0].text;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface SandboxRequest {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: unknown };
}

function createSandbox(): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    console,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    EventTarget,
    Event,
    CustomEvent,
  };
  createContext(sandbox);
  return sandbox;
}

/** A copy of the bytes as a standalone ArrayBuffer, the way a browser hands one over. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function jsonReply(status: number, body: unknown): { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> } {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

test("browser bundle builds without Node builtins, ws, or mqtt", async () => {
  const bundle = await bundlePromise;

  // The browser substitutions must be picked, and the Node-only modules must
  // stay out of the bundle entirely.
  assert.ok(bundle.includes("platform/browser.js"), "expected the browser platform module in the bundle");
  assert.ok(bundle.includes("transport-mqtt.browser.js"), "expected the mqtt browser stub in the bundle");
  assert.ok(!bundle.includes("platform/node.js"), "the Node platform module leaked into the browser bundle");
  assert.ok(!/node_modules\/ws\//.test(bundle), "the ws package leaked into the browser bundle");
  assert.ok(!/node_modules\/mqtt\//.test(bundle), "the mqtt package leaked into the browser bundle");
  assert.ok(!/node_modules\/yaml\//.test(bundle), "the yaml package leaked into the browser bundle");
  for (const builtin of ["node:crypto", "node:fs", "node:os", "node:path", "node:zlib"]) {
    assert.ok(!bundle.includes(builtin), `${builtin} leaked into the browser bundle`);
  }
});

test("browser bundle drives the control plane through globalThis.fetch", async () => {
  const bundle = await bundlePromise;
  const sandbox = createSandbox();
  const requests: SandboxRequest[] = [];
  sandbox.fetch = async (url: unknown, init?: SandboxRequest["init"]) => {
    const target = String(url);
    requests.push({ url: target, init });
    if (target.endsWith("/v1/auth/token")) {
      return jsonReply(200, { access_token: "token-1", expires_in: 3600 });
    }
    if (target.includes("/v1/public/hubs?")) {
      return jsonReply(200, {
        data: [{ id: "hub-1", slug: "joke-garden", title: "Joke Garden" }],
        meta: { count: 1, next: null },
      });
    }
    if (target.endsWith("/v1/hubs/hub-1")) {
      return jsonReply(200, {
        id: "hub-1",
        name: "joke-garden",
        domain: "jokes.thalovant.io",
        spec: {
          protocols: {
            wss: { enabled: true },
            http: { enabled: true },
            mqtt: { enabled: false },
          },
        },
      });
    }
    if (target.endsWith("/v1/clients")) {
      const payload = JSON.parse(String(init?.body)) as Record<string, { apiKey?: unknown; password?: unknown }> & { name?: unknown; hub_id?: unknown };
      assert.equal(typeof payload.spec.apiKey, "string");
      assert.equal(typeof payload.spec.password, "string");
      return jsonReply(201, { id: "client-1", name: payload.name, hub_id: payload.hub_id, spec: { version: "1" } });
    }
    throw new Error(`unexpected URL ${target}`);
  };
  runInContext(bundle, sandbox as object);

  const sdk = sandbox.__thalovantSdk as Record<string, any>;
  assert.ok(sdk, "the bundle did not export the SDK entry points");

  const api = new sdk.ThalovantControlPlane("https://dash.example.com/api");
  await api.login("ada@example.com", "secret");
  const page = await api.listPublicHubs({ limit: 12 });
  const result = await api.createClientIdentity("hub-1", { name: "kiosk" });

  assert.equal(api.accessToken, "token-1");
  assert.equal((page.data as Array<Record<string, unknown>>)[0].slug, "joke-garden");
  assert.equal(result.identity.siteId, "kiosk");
  assert.ok(result.identity.accessKey);
  assert.equal(result.selectedProtocol, "wss");
  assert.equal(result.identity.endpointFor("wss"), "wss://jokes.thalovant.io");
  assert.equal(requests.length, 4);
  assert.equal(requests[3].init?.headers?.authorization, "Bearer token-1");
});

test("browser bundle connects WSS through the global WebSocket and Web Crypto", async () => {
  const bundle = await bundlePromise;
  const sandbox = createSandbox();
  const sockets: any[] = [];

  // The hub runs on the host and speaks the real v3 responder, so the bundle in
  // the sandbox has to complete a genuine Noise handshake to connect.
  let hub: ReturnType<typeof createV3HubPeer> | undefined;

  class StubWebSocket {
    url: string;
    binaryType = "blob";
    readyState = 0;
    private listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(url: unknown) {
      this.url = String(url);
      sockets.push(this);
      hub = createV3HubPeer("secret", (data, binary) => {
        // The client sets binaryType "arraybuffer", so binary frames arrive as
        // an ArrayBuffer exactly as a browser would deliver them.
        this.dispatch("message", {
          data: binary && data instanceof Uint8Array ? toArrayBuffer(data) : String(data),
        });
      });
      setTimeout(() => {
        this.readyState = 1;
        this.dispatch("open", {});
        setTimeout(() => hub?.start(), 5);
      }, 5);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const bucket = this.listeners.get(type) ?? [];
      bucket.push(listener);
      this.listeners.set(type, bucket);
    }

    send(data: unknown): void {
      if (typeof data === "string") {
        hub?.onMessage(data);
        return;
      }
      hub?.onMessage(new Uint8Array(data as ArrayBufferLike));
    }

    close(): void {
      this.readyState = 3;
      this.dispatch("close", { code: 1000, reason: "" });
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  sandbox.WebSocket = StubWebSocket;
  sandbox.fetch = async () => {
    throw new Error("unexpected fetch during the WSS smoke test");
  };
  runInContext(bundle, sandbox as object);

  const sdk = sandbox.__thalovantSdk as Record<string, any>;
  const identity = new sdk.ThalovantIdentity({
    access_key: "access",
    password: "secret",
    site_id: "site",
    default_master: "wss://hub.example.com",
  });

  const client = new sdk.ThalovantClient(identity, { protocol: "wss" });
  const info = await client.connectWithInfo(1000);
  assert.equal(info.phase, "ready");
  assert.equal(sockets.length, 1);
  assert.ok(sockets[0].url.startsWith("wss://hub.example.com"));
  assert.ok(sockets[0].url.includes("authorization="));
  assert.equal(sockets[0].binaryType, "arraybuffer");

  // Everything the client sent after Split() reached the hub as a Noise
  // transport message and decrypted there, which is the whole point: the
  // bundle did the X25519, ChaCha20-Poly1305 and argon2id itself, with no Node
  // builtins available to it.
  assert.ok(hub);
  const helloFrame = hub.received[0];
  assert.ok(helloFrame, "the client sent no encrypted HELLO");
  const hello = JSON.parse(helloFrame) as { msg_type: string; payload: { site_id: string } };
  assert.equal(hello.msg_type, "hello");
  assert.equal(hello.payload.site_id, "site");

  await client.emit("test.event", { ok: true });
  const busFrame = hub.received[1];
  assert.ok(busFrame, "the client sent no encrypted bus message");
  const message = JSON.parse(busFrame) as { msg_type: string; payload: { type: string } };
  assert.equal(message.msg_type, "bus");
  assert.equal(message.payload.type, "test.event");

  await client.close();

  // The mqtt transport must fail loudly instead of pulling mqtt into bundles.
  assert.throws(() => new sdk.HiveMindMqttTransport(identity), /not available in browsers/);
});
