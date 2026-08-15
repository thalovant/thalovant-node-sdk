import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { once, setMaxListeners } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { WebSocketServer } from "ws";
import { buildClientContext } from "../src/context.js";
import { decryptBinary, decryptFromJson, encryptAsBinary, encryptAsJson, runtimeCryptoKey } from "../src/crypto.js";
import { contextWithCorrelation, eventMatchesContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HubDataPlaneEndpoints, HubProtocolSettings, selectDataPlaneEndpoint } from "../src/protocols.js";
import { displayItemsFromEventData } from "../src/rich.js";
import { ThalovantControlPlane } from "../src/control.js";
import { ThalovantClient } from "../src/client.js";
import { ThalovantApiError, ThalovantConnectionError, ThalovantTimeoutError, ThalovantUnsupportedProtocolError } from "../src/errors.js";
import { HiveMindHttpTransport, HiveMindWSSTransport, mqttConnectionEndpoint, mqttTopicsForIdentity } from "../src/transport.js";
import { decodeHiveBinaryFrame, encodeHiveBinaryFrame } from "../src/wire.js";

test("identity normalizes aliases", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    cryptoKey: "0123456789abcdef-extra",
    site: "site",
    host: "https://hub.example.com/",
    port: "443",
    path: "/hivemind/public",
    metadata: { thalovant_owner_id: "owner-1" },
  });

  assert.equal(identity.accessKey, "access");
  assert.equal(identity.defaultMaster, "https://hub.example.com");
  assert.equal(identity.defaultPort, 443);
  assert.equal(identity.defaultPath, "/hivemind/public");
  assert.equal(identity.endpointBase(), "https://hub.example.com/hivemind/public");
  assert.deepEqual(identity.metadata, { thalovant_owner_id: "owner-1" });
});

test("identity uses protocol aware data plane endpoints", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "wss://hub.example.com",
    port: 443,
    path: "/hivemind/public",
    data_plane_endpoints: {
      https: "https://api.example.com/hivemind/public",
      wss: "wss://socket.example.com/hivemind/public",
      mqtt: "mqtts://mqtt.example.com:8883",
    },
    protocols: {
      wss: { enabled: true },
      http: { enabled: true },
      mqtt: { enabled: true },
    },
  });

  assert.equal(identity.endpointBase(), "https://api.example.com/hivemind/public");
  assert.equal(identity.endpointFor("wss"), "wss://socket.example.com/hivemind/public");
  assert.equal(identity.endpointFor("mqtt"), "mqtts://mqtt.example.com:8883");
  assert.deepEqual(identity.enabledProtocols(), ["wss", "https", "mqtt"]);
  assert.equal(identity.supportsProtocol("https"), true);
});

test("identity uses WSS default master from setup claims", () => {
  const identity = new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    crypto_key: "0123456789abcdef",
    site_id: "site",
    default_master: "wss://daily-desk.thalovant.io",
    default_port: 443,
  });

  assert.equal(identity.endpointFor("wss"), "wss://daily-desk.thalovant.io");
  assert.equal(identity.endpointBase(), "https://daily-desk.thalovant.io");
});

test("identity loads MQTT credentials and redacts them by default", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "wss://hub.example.com",
    mqtt: {
      endpoint: "mqtts://mqtt.example.com:8883",
      username: "access",
      password: "broker-password",
      topic_prefix: "hivemind/hub/access",
    },
  });

  assert.ok(identity.mqtt);
  assert.equal(identity.mqtt.endpoint, "mqtts://mqtt.example.com:8883");
  assert.equal(identity.mqtt.username, "access");
  assert.deepEqual(identity.asObject().mqtt, {
    endpoint: "mqtts://mqtt.example.com:8883",
    tls: true,
  });
  assert.deepEqual(identity.asObject(true).mqtt, {
    endpoint: "mqtts://mqtt.example.com:8883",
    tls: true,
    username: "access",
    password: "broker-password",
    topic_prefix: "hivemind/hub/access",
  });
});

test("identity loads YAML config profiles", async t => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-sdk-"));
  const path = join(dir, "config.yaml");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path, `
version: 1
profile: prod
profiles:
  prod:
    identity:
      access_key: access
      password: secret
      site_id: site
      default_master: https://hub.example.com
      default_port: 443
      mqtt:
        endpoint: mqtts://mqtt.example.com:8883
        username: access
        password: broker-password
        topic_prefix: hivemind/hub/access
`, "utf8");
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }

  const identity = await ThalovantIdentity.fromConfig({ path });

  assert.equal(identity.accessKey, "access");
  assert.equal(identity.mqtt?.password, "broker-password");
});

test("identity loads private JSON identity files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-sdk-"));
  const path = join(dir, "_identity.json");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path, JSON.stringify({
    access_key: "access",
    password: "secret",
    site_id: "site",
    default_master: "https://hub.example.com",
    default_port: 443,
  }), "utf8");
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }

  const identity = await ThalovantIdentity.fromFile(path);

  assert.equal(identity.accessKey, "access");
  assert.equal(identity.defaultMaster, "https://hub.example.com");
});

test("identity rejects permissive JSON identity files", async t => {
  if (process.platform === "win32") {
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "thalovant-sdk-"));
  const path = join(dir, "_identity.json");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path, JSON.stringify({
    access_key: "access",
    password: "secret",
    site_id: "site",
    default_master: "https://hub.example.com",
  }), "utf8");
  await chmod(path, 0o644);

  await assert.rejects(() => ThalovantIdentity.fromFile(path), /too permissive/);
});

test("identity rejects permissive YAML config files", async t => {
  if (process.platform === "win32") {
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "thalovant-sdk-"));
  const path = join(dir, "config.yaml");
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(path, "identity: {}\n", "utf8");
  await chmod(path, 0o644);

  await assert.rejects(() => ThalovantIdentity.fromConfig({ path }), /too permissive/);
});

test("data plane endpoints can be derived from a hub resource", () => {
  const endpoints = HubDataPlaneEndpoints.fromHub({
    domain: "jokes.thalovant.io",
    spec: {
      protocols: {
        wss: { enabled: true },
        http: { enabled: true },
        mqtt: { enabled: false },
      },
    },
  });

  assert.equal(endpoints.wss, "wss://jokes.thalovant.io");
  assert.equal(endpoints.https, "https://jokes.thalovant.io");
  assert.equal(endpoints.mqtt, undefined);
});

test("selectDataPlaneEndpoint chooses the first enabled endpoint from preference", () => {
  const selected = selectDataPlaneEndpoint(
    new HubDataPlaneEndpoints({
      https: "https://hub.example.com/public",
      wss: "wss://hub.example.com/public",
    }),
    new HubProtocolSettings({ wss: true, http: true }),
    ["mqtt", "wss", "https"],
  );

  assert.deepEqual(selected, { protocol: "wss", endpoint: "wss://hub.example.com/public" });
});

test("client requires MQTT broker credentials for MQTT runtime", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });

  assert.throws(() => new ThalovantClient(identity, { protocol: "mqtt" }), ThalovantUnsupportedProtocolError);
});

test("client selects WSS and MQTT runtime transports", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    crypto_key: "0123456789abcdef",
    site: "site",
    host: "https://hub.example.com",
    data_plane_endpoints: {
      https: "https://hub.example.com",
      wss: "wss://hub.example.com",
      mqtt: "mqtts://mqtt.example.com:8883",
    },
    mqtt: {
      endpoint: "mqtts://mqtt.example.com:8883",
      username: "access",
      password: "broker-password",
      topic_prefix: "hivemind/hub/access",
    },
  });

  const autoClient = new ThalovantClient(identity) as unknown as { transport: unknown };
  assert.equal(autoClient.transport instanceof HiveMindWSSTransport, true);
  assert.doesNotThrow(() => new ThalovantClient(identity, { protocol: "wss" }));
  assert.doesNotThrow(() => new ThalovantClient(identity, { protocol: "mqtt" }));
  assert.deepEqual(mqttTopicsForIdentity(identity), {
    c2s: "hivemind/hub/c2s/access",
    s2c: "hivemind/hub/s2c/access",
    status: "hivemind/hub/status/access",
  });
});

test("client falls back to HTTPS when WSS endpoint is missing", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });

  const autoClient = new ThalovantClient(identity) as unknown as { transport: unknown };
  assert.equal(autoClient.transport instanceof HiveMindHttpTransport, true);
});

test("client forwards explicit connect timeouts to transports", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const calls: Array<number | undefined> = [];
  const transport = Object.assign(new EventTarget(), {
    async connect(timeoutMs?: number): Promise<void> {
      calls.push(timeoutMs);
    },
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(): Promise<void> {},
  });

  const client = new ThalovantClient(identity, { transport });
  await client.connect(12345);

  assert.deepEqual(calls, [12345]);
});

test("client enforces a hard connect timeout around transports", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  let disconnects = 0;
  const transport = Object.assign(new EventTarget(), {
    async connect(): Promise<void> {
      await new Promise(() => undefined);
    },
    async disconnect(): Promise<void> {
      disconnects += 1;
    },
    healthcheck() {
      return {
        connected: false,
        handshakeComplete: false,
        transportAlive: false,
      };
    },
    async emitBus(): Promise<void> {},
  });

  const client = new ThalovantClient(identity, { transport });

  await assert.rejects(
    () => client.connect(20),
    (error: unknown) =>
      error instanceof ThalovantConnectionError &&
      /did not complete within 20ms/.test(error.message),
  );
  assert.equal(disconnects, 1);
});

test("WSS connect reports socket and handshake timings", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  server.on("connection", socket => {
    socket.send(JSON.stringify({
      msg_type: "handshake",
      payload: { preshared_key: true },
      metadata: {},
    }));
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const port = (address as AddressInfo).port;
  const identity = new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    crypto_key: "0123456789abcdef",
    site_id: "site",
    default_master: `ws://127.0.0.1:${port}`,
  });
  const client = new ThalovantClient(identity, { protocol: "wss" });

  const info = await client.connectWithInfo(2000);
  const health = client.healthcheck();
  await client.close();

  assert.equal(info.phase, "ready");
  assert.equal(health.connection?.phase, "ready");
  assert.equal(typeof info.socketOpenMs, "number");
  assert.equal(typeof info.handshakeMs, "number");
  assert.equal(typeof info.connectMs, "number");
  assert.ok((info.connectMs ?? 0) >= (info.socketOpenMs ?? 0));
});

test("client one-shot utterances include a fresh session by default", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const emitted: Array<{ eventType: string; data: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const transport = Object.assign(new EventTarget(), {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(eventType: string, data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      emitted.push({ eventType, data, context });
    },
  });

  const client = new ThalovantClient(identity, { transport });
  await client.sendUtterance("hello", { requestId: "req-1" });

  const session = emitted[0].context.session as Record<string, unknown>;
  assert.equal(emitted[0].eventType, "recognizer_loop:utterance");
  assert.match(String(session.session_id), /^thalovant-session-/);
  assert.equal(session.site_id, "site");
  assert.equal(session.request_id, "req-1");
  assert.equal(emitted[0].context.request_id, "req-1");
});

test("MQTT topic prefixes append hub id for scoped ACLs", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
    mqtt: {
      endpoint: "mqtts://mqtt.example.com:8883",
      username: "access",
      password: "broker-password",
      topic_prefix: "hivemind",
      hub_id: "hub-1",
    },
  });

  assert.deepEqual(mqttTopicsForIdentity(identity), {
    c2s: "hivemind/hub-1/c2s/access",
    s2c: "hivemind/hub-1/s2c/access",
    status: "hivemind/hub-1/status/access",
  });
});

test("MQTT TLS flag upgrades mqtt endpoints", () => {
  assert.equal(
    mqttConnectionEndpoint({ endpoint: "mqtt://mqtt.example.com", tls: true }),
    "mqtts://mqtt.example.com",
  );
  assert.equal(
    mqttConnectionEndpoint({ endpoint: "mqtt://mqtt.example.com", tls: false }),
    "mqtt://mqtt.example.com",
  );
});

test("control plane bootstrap keeps generated secrets local", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/v1/auth/token")) {
      return jsonResponse(200, { access_token: "token", expires_in: 3600 });
    }
    if (String(url).endsWith("/v1/hubs/hub-1")) {
      return jsonResponse(200, {
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
    if (String(url).endsWith("/v1/clients")) {
      const payload = JSON.parse(String(init?.body)) as Record<string, any>;
      assert.equal(typeof payload.spec.apiKey, "string");
      assert.equal(typeof payload.spec.password, "string");
      assert.equal(typeof payload.spec.cryptoKey, "string");
      return jsonResponse(201, {
        id: "client-1",
        name: payload.name,
        hub_id: payload.hub_id,
        spec: { version: "1", apiKeyRef: { name: "secret", key: "apiKey" } },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    await api.login("ada@example.com", "secret");
    const result = await api.createClientIdentity("hub-1", { name: "kiosk" });

    assert.equal(result.identity.siteId, "kiosk");
    assert.ok(result.identity.accessKey);
    assert.ok(result.identity.password);
    assert.equal(result.identity.endpointFor("https"), "https://jokes.thalovant.io");
    assert.equal(result.selectedProtocol, "wss");
    assert.deepEqual(api.requireRuntimeProtocol(result), {
      protocol: "wss",
      endpoint: "wss://jokes.thalovant.io",
    });
    assert.equal("access_key" in (result.asObject().identity as object), false);
    assert.ok((result.asObject({ includeSecrets: true }).identity as Record<string, unknown>).access_key);
    assert.equal((requests[2].init?.headers as Record<string, string>).authorization, "Bearer token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane uses public API default and normalizes v1 roots", () => {
  assert.equal(new ThalovantControlPlane().apiUrl, "https://api.thalovant.com/");
  assert.equal(
    new ThalovantControlPlane("https://api.thalovant.com/v1").apiUrl,
    "https://api.thalovant.com/",
  );
  assert.equal(
    new ThalovantControlPlane("https://dash.example.com/api/v1").apiUrl,
    "https://dash.example.com/api/",
  );
});

test("control plane login sends MFA codes only when provided", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/v1/auth/token"));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse(200, { access_token: "token", expires_in: 3600 });
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    await api.login("ada@example.com", "secret");
    await api.login("ada@example.com", "secret", { otpCode: "123456" });
    await api.login("ada@example.com", "secret", { recoveryCode: "abcd-efgh", scope: "admin" });

    assert.deepEqual(bodies[0], { email: "ada@example.com", password: "secret" });
    assert.equal("otp_code" in bodies[0], false);
    assert.equal("recovery_code" in bodies[0], false);
    assert.deepEqual(bodies[1], {
      email: "ada@example.com",
      password: "secret",
      otp_code: "123456",
    });
    assert.deepEqual(bodies[2], {
      email: "ada@example.com",
      password: "secret",
      scope: "admin",
      recovery_code: "abcd-efgh",
    });
    assert.equal(api.accessToken, "token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane lists public hubs without auth", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/v1/public/hubs?limit=12")) {
      return jsonResponse(200, {
        data: [{ id: "hub-public", name: "joke-garden", slug: "joke-garden", title: "Joke Garden" }],
        meta: { count: 1, next: null },
        links: { next: null },
      });
    }
    if (String(url).endsWith("/v1/public/hubs/joke-garden")) {
      return jsonResponse(200, {
        id: "hub-public",
        name: "joke-garden",
        slug: "joke-garden",
        title: "Joke Garden",
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const page = await api.listPublicHubs({ limit: 12 });
    const hub = await api.getPublicHub("joke-garden");

    assert.equal((page.data as Record<string, unknown>[])[0].slug, "joke-garden");
    assert.equal(hub.title, "Joke Garden");
    assert.equal((requests[0].init?.headers as Record<string, string>).authorization, undefined);
    assert.equal((requests[1].init?.headers as Record<string, string>).authorization, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane gets a typed durable operation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/v1/operations/operation-1"));
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer token",
    );
    return jsonResponse(200, {
      id: "operation-1",
      kind: "gitops.commit",
      aggregate_type: "gitops",
      aggregate_id: null,
      status: "committed",
      details: { git_commit_created: true },
      git_commit_sha: "abc123",
      error_code: null,
      error_message: null,
      created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:01Z",
      committed_at: "2026-07-11T00:00:01Z",
      applied_at: null,
      ready_at: null,
      terminal_at: null,
      links: { self: "/v1/operations/operation-1" },
    });
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", {
      accessToken: "token",
    });
    const operation = await api.getOperation("operation-1");

    assert.equal(operation.status, "committed");
    assert.equal(operation.git_commit_sha, "abc123");
    assert.equal(operation.details.git_commit_created, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane manages memory items", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url));
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer token");
    if (init?.method === "GET" && parsed.pathname === "/api/v1/memory") {
      assert.equal(parsed.searchParams.get("scope"), "workspace");
      assert.equal(parsed.searchParams.get("kind"), "preference");
      assert.equal(parsed.searchParams.get("owner_id"), "owner-1");
      assert.equal(parsed.searchParams.get("hub_id"), "hub-1");
      assert.equal(parsed.searchParams.get("q"), "timezone");
      assert.equal(parsed.searchParams.get("include_deleted"), "true");
      assert.equal(parsed.searchParams.get("include_expired"), "true");
      assert.equal(parsed.searchParams.get("limit"), "25");
      assert.equal(parsed.searchParams.get("offset"), "50");
      return jsonResponse(200, {
        data: [{ id: "memory-1", content: "Use UTC." }],
        meta: { count: 1, next: null },
        links: { next: null },
      });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/memory/summary") {
      assert.equal(parsed.searchParams.get("owner_id"), "owner-1");
      return jsonResponse(200, {
        total: 1,
        by_scope: { workspace: 1 },
        by_kind: { preference: 1 },
        expired: 0,
        deleted: 0,
      });
    }
    if (init?.method === "POST" && parsed.pathname === "/api/v1/memory") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(payload.scope, "workspace");
      assert.equal(payload.kind, "preference");
      assert.equal(payload.content, "Use UTC.");
      assert.equal(payload.owner_id, "owner-1");
      assert.equal(payload.hub_id, "hub-1");
      assert.equal(payload.consent_scope, "daily_desk_memory");
      assert.equal(payload.retention_policy, "user_controlled");
      return jsonResponse(201, {
        id: "memory-1",
        scope: "workspace",
        kind: "preference",
        content: "Use UTC.",
      });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/memory/memory-1") {
      return jsonResponse(200, {
        id: "memory-1",
        scope: "workspace",
        kind: "preference",
        content: "Use UTC.",
      });
    }
    if (init?.method === "PATCH" && parsed.pathname === "/api/v1/memory/memory-1") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(payload.content, "Use America/Toronto.");
      assert.equal(payload.clear_expires_at, true);
      return jsonResponse(200, {
        id: "memory-1",
        scope: "workspace",
        kind: "preference",
        content: "Use America/Toronto.",
      });
    }
    if (init?.method === "DELETE" && parsed.pathname === "/api/v1/memory/memory-1") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const page = await api.listMemoryItems({
      scope: "workspace",
      kind: "preference",
      ownerId: "owner-1",
      hubId: "hub-1",
      query: "timezone",
      includeDeleted: true,
      includeExpired: true,
      limit: 25,
      offset: 50,
    });
    const summary = await api.getMemorySummary({ ownerId: "owner-1" });
    const created = await api.createMemoryItem({
      scope: "workspace",
      kind: "preference",
      content: "Use UTC.",
      ownerId: "owner-1",
      hubId: "hub-1",
      consentScope: "daily_desk_memory",
      retentionPolicy: "user_controlled",
    });
    const item = await api.getMemoryItem("memory-1");
    const updated = await api.updateMemoryItem("memory-1", {
      content: "Use America/Toronto.",
      clearExpiresAt: true,
    });
    await api.deleteMemoryItem("memory-1");

    assert.equal((page.data as Record<string, unknown>[]).length, 1);
    assert.equal(summary.total, 1);
    assert.equal(created.id, "memory-1");
    assert.equal(item.content, "Use UTC.");
    assert.equal(updated.content, "Use America/Toronto.");
    assert.equal(requests.length, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane provisions hubs", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let idempotencyKey: string | undefined;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, "Bearer token");
    if (init?.method === "POST" && parsed.pathname === "/api/v1/hubs") {
      idempotencyKey = headers["Idempotency-Key"];
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(payload.name, "joke-garden");
      assert.equal(payload.runtime_group_id, "group-1");
      assert.equal(payload.capacity_profile, "autoscaling");
      assert.equal(payload.owner_id, "owner-1");
      assert.equal(payload.runtimeGroupId, undefined);
      assert.deepEqual(payload.spec, { protocols: { wss: { enabled: true } } });
      return jsonResponse(201, { id: "hub-1", name: "joke-garden", etag: "etag-1" });
    }
    if (init?.method === "PATCH" && parsed.pathname === "/api/v1/hubs/hub-1") {
      assert.equal(headers["If-Match"], "etag-1");
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(payload.active, false);
      assert.equal(payload.is_locked, true);
      return jsonResponse(200, { id: "hub-1", active: false, etag: "etag-2" });
    }
    if (init?.method === "DELETE" && parsed.pathname === "/api/v1/hubs/hub-1") {
      assert.equal(headers["If-Match"], "etag-2");
      return new Response(null, { status: 204 });
    }
    if (init?.method === "POST" && parsed.pathname === "/api/v1/hubs/hub-1/release") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(payload, {
        channel: "stable",
        mode: "custom",
        images: { core: "ghcr.io/thalovant/core:1.2.3" },
        reason: "pin the kiosk fleet",
      });
      return jsonResponse(200, { id: "hub-1", release_channel: "stable" });
    }
    if (init?.method === "PUT" && parsed.pathname === "/api/v1/hubs/hub-2/rating") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(payload, { rating: 5 });
      return jsonResponse(200, { id: "hub-2", rating_average: 5 });
    }
    if (init?.method === "DELETE" && parsed.pathname === "/api/v1/hubs/hub-2/rating") {
      assert.equal(init.body, undefined);
      return jsonResponse(200, { id: "hub-2", rating_average: null });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/hubs/hub-1/runtime-capabilities") {
      return jsonResponse(200, { data: [{ skill_id: "skill-weather" }], counts: { total_intents: 4 } });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const hub = await api.createHub({
      name: "joke-garden",
      runtimeGroupId: "group-1",
      capacityProfile: "autoscaling",
      ownerId: "owner-1",
      spec: { protocols: { wss: { enabled: true } } },
    });
    const updated = await api.updateHub("hub-1", { active: false, isLocked: true }, { etag: "etag-1" });
    await api.deleteHub("hub-1", { etag: "etag-2" });
    const released = await api.releaseHub("hub-1", {
      channel: "stable",
      mode: "custom",
      images: { core: "ghcr.io/thalovant/core:1.2.3" },
      reason: "pin the kiosk fleet",
    });
    const rated = await api.setHubRating("hub-2", 5);
    const cleared = await api.clearHubRating("hub-2");
    const capabilities = await api.getHubRuntimeCapabilities("hub-1");

    assert.equal(hub.id, "hub-1");
    assert.equal(updated.active, false);
    assert.equal(released.release_channel, "stable");
    assert.equal(rated.rating_average, 5);
    assert.equal(cleared.rating_average, null);
    assert.equal((capabilities.counts as Record<string, unknown>).total_intents, 4);
    assert.match(String(idempotencyKey), /^[0-9a-f-]{36}$/);
    assert.equal(requests.length, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane honors a caller-supplied hub idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers["Idempotency-Key"], "retry-key-1");
    return jsonResponse(201, { id: "hub-1" });
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const hub = await api.createHub({ name: "joke-garden", spec: {} }, { idempotencyKey: "retry-key-1" });
    assert.equal(hub.id, "hub-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane manages runtime groups and skills", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers.authorization, "Bearer token");
    // Runtime group routes read neither If-Match nor an idempotency header.
    assert.equal(headers["If-Match"], undefined);
    assert.equal(headers["Idempotency-Key"], undefined);
    if (init?.method === "GET" && parsed.pathname === "/api/v1/runtime-groups") {
      assert.equal(parsed.searchParams.get("owner_id"), "owner-1");
      return jsonResponse(200, { data: [{ id: "group-1", name: "kiosks" }] });
    }
    if (init?.method === "POST" && parsed.pathname === "/api/v1/runtime-groups") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(payload.name, "kiosks");
      assert.equal(payload.owner_id, "owner-1");
      assert.equal(payload.clone_from_default, true);
      assert.equal(payload.cloneFromDefault, undefined);
      return jsonResponse(201, { id: "group-1", name: "kiosks" });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/runtime-groups/group-1") {
      return jsonResponse(200, { id: "group-1", name: "kiosks" });
    }
    if (init?.method === "PATCH" && parsed.pathname === "/api/v1/runtime-groups/group-1") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(payload.description, "Lobby kiosks");
      return jsonResponse(200, { id: "group-1", description: "Lobby kiosks" });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/runtime-groups/group-1/config") {
      return jsonResponse(200, { config: { lang: "en-us" }, personas: {} });
    }
    if (init?.method === "PATCH" && parsed.pathname === "/api/v1/runtime-groups/group-1/config") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(payload, { config: { lang: "en-us" }, personas: { default: "helpful" } });
      return jsonResponse(200, { config: { lang: "en-us" }, pending: true });
    }
    if (init?.method === "POST" && parsed.pathname === "/api/v1/runtime-groups/group-1/release") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(payload, { channel: "stable" });
      return jsonResponse(200, { id: "group-1", release_channel: "stable" });
    }
    if (init?.method === "POST" && parsed.pathname === "/api/v1/runtime-groups/group-1/skills") {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (payload.source_type === "catalog") {
        assert.deepEqual(payload, { skill_id: "skill-weather", source_type: "catalog", active: true });
      } else {
        assert.deepEqual(payload, {
          skill_id: "skill-lab",
          source_type: "git",
          active: false,
          marketplace_skill_id: "marketplace-1",
          source_ref: "https://github.com/example/skill-lab",
          version_pin: "1.2.3",
        });
      }
      // The install route answers 200, not 201.
      return jsonResponse(200, { skill_id: payload.skill_id });
    }
    if (init?.method === "DELETE" && parsed.pathname === "/api/v1/runtime-groups/group-1/skills/skill-weather") {
      return new Response(null, { status: 204 });
    }
    if (init?.method === "DELETE" && parsed.pathname === "/api/v1/runtime-groups/group-1") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const groups = await api.listRuntimeGroups({ ownerId: "owner-1" });
    const created = await api.createRuntimeGroup({
      name: "kiosks",
      ownerId: "owner-1",
      cloneFromDefault: true,
    });
    const group = await api.getRuntimeGroup("group-1");
    const updated = await api.updateRuntimeGroup("group-1", { description: "Lobby kiosks" });
    const config = await api.getRuntimeGroupConfig("group-1");
    const merged = await api.updateRuntimeGroupConfig(
      "group-1",
      { lang: "en-us" },
      { personas: { default: "helpful" } },
    );
    const released = await api.releaseRuntimeGroup("group-1", { channel: "stable" });
    const installed = await api.installRuntimeGroupSkill("group-1", "skill-weather");
    const custom = await api.installRuntimeGroupSkill("group-1", "skill-lab", {
      marketplaceSkillId: "marketplace-1",
      sourceType: "git",
      sourceRef: "https://github.com/example/skill-lab",
      versionPin: "1.2.3",
      active: false,
    });
    await api.uninstallRuntimeGroupSkill("group-1", "skill-weather");
    await api.deleteRuntimeGroup("group-1");

    assert.equal((groups.data as Record<string, unknown>[]).length, 1);
    assert.equal(created.id, "group-1");
    assert.equal(group.name, "kiosks");
    assert.equal(updated.description, "Lobby kiosks");
    assert.deepEqual(config.config, { lang: "en-us" });
    assert.equal(merged.pending, true);
    assert.equal(released.release_channel, "stable");
    assert.equal(installed.skill_id, "skill-weather");
    assert.equal(custom.skill_id, "skill-lab");
    assert.equal(requests.length, 11);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane omits unset runtime group config personas and release fields", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return jsonResponse(200, { id: "group-1" });
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    await api.updateRuntimeGroupConfig("group-1", { lang: "en-us" });
    await api.releaseRuntimeGroup("group-1");
    await api.releaseHub("hub-1");

    assert.deepEqual(bodies[0], { config: { lang: "en-us" } });
    assert.deepEqual(bodies[1], {});
    assert.deepEqual(bodies[2], {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane discovers marketplace skills", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const parsed = new URL(String(url));
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer token");
    if (init?.method === "GET" && parsed.pathname === "/api/v1/marketplace/skills") {
      if (parsed.searchParams.has("owner_id")) {
        assert.equal(parsed.searchParams.get("owner_id"), "owner-1");
        assert.equal(parsed.searchParams.get("include_inactive"), "true");
        assert.equal(parsed.searchParams.get("force_refresh"), "true");
      } else {
        // Falsy booleans are omitted rather than sent as "false".
        assert.equal(parsed.search, "");
      }
      return jsonResponse(200, {
        data: [{ skill_id: "skill-weather", source_type: "catalog", access_tier: "free" }],
      });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/runtime-groups/group-1/marketplace") {
      assert.equal(parsed.searchParams.get("refresh_inventory"), "true");
      return jsonResponse(200, {
        runtime_group_id: "group-1",
        source: "ovos-runtime-operator",
        data: [{ skill_id: "skill-weather", installable: true, purchase_required: false }],
      });
    }
    if (init?.method === "GET" && parsed.pathname === "/api/v1/runtime-groups/group-1/inventory") {
      assert.equal(parsed.search, "");
      // No client connected: an empty list with a pending source, never HTTP 409.
      return jsonResponse(200, { source: "ovos-runtime-operator-pending", data: [] });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const catalog = await api.listMarketplaceSkills();
    const adminCatalog = await api.listMarketplaceSkills({
      ownerId: "owner-1",
      includeInactive: true,
      forceRefresh: true,
    });
    const view = await api.listRuntimeGroupMarketplace("group-1", { refreshInventory: true });
    const inventory = await api.listRuntimeGroupInventory("group-1");

    assert.equal((catalog.data as Record<string, unknown>[])[0].skill_id, "skill-weather");
    assert.equal((adminCatalog.data as Record<string, unknown>[]).length, 1);
    assert.equal((view.data as Record<string, unknown>[])[0].installable, true);
    assert.equal(inventory.source, "ovos-runtime-operator-pending");
    assert.deepEqual(inventory.data, []);
    assert.equal(requests.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane surfaces provisioning plan, scope, and precondition errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/api/v1/hubs") {
      return jsonResponse(402, { detail: "API access requires a paid plan." });
    }
    if (parsed.pathname === "/api/v1/hubs/hub-1") {
      return jsonResponse(412, { detail: "The hub changed since it was read." });
    }
    if (parsed.pathname === "/api/v1/runtime-groups/group-1/marketplace") {
      return jsonResponse(403, { detail: "Insufficient scopes" });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    await assert.rejects(
      () => api.createHub({ name: "joke-garden", spec: {} }),
      (error: unknown) =>
        error instanceof ThalovantApiError && /HTTP 402/.test((error as Error).message) && /paid plan/.test((error as Error).message),
    );
    await assert.rejects(
      () => api.updateHub("hub-1", { active: false }, { etag: "stale" }),
      (error: unknown) => error instanceof ThalovantApiError && /HTTP 412/.test((error as Error).message),
    );
    await assert.rejects(
      () => api.deleteHub("hub-1", { etag: "stale" }),
      (error: unknown) => error instanceof ThalovantApiError && /HTTP 412/.test((error as Error).message),
    );
    await assert.rejects(
      () => api.listRuntimeGroupMarketplace("group-1"),
      (error: unknown) =>
        error instanceof ThalovantApiError && /HTTP 403/.test((error as Error).message) && /Insufficient scopes/.test((error as Error).message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane fetches analytics overview", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    // Only the tenant-scoped route exists; the SDK has no /v1/admin surface.
    assert.equal(parsed.pathname, "/api/v1/analytics/overview");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer token");
    assert.equal(parsed.searchParams.get("range"), "30d");
    assert.equal(parsed.searchParams.get("bucket"), "1d");
    assert.equal(parsed.searchParams.has("owner_id"), false);
    assert.equal(parsed.searchParams.get("hub_id"), "hub-1");
    assert.equal(parsed.searchParams.get("client_id"), "client-1");
    assert.equal(parsed.searchParams.get("country"), "CA");
    assert.equal(parsed.searchParams.get("message"), "speak");
    assert.equal(parsed.searchParams.get("utterance"), "hello");
    assert.equal(parsed.searchParams.get("intent"), "DailyDeskIntent");
    assert.equal(parsed.searchParams.get("time_start"), "2026-05-03T20:00:00Z");
    assert.equal(parsed.searchParams.get("time_end"), "2026-05-03T21:00:00Z");
    assert.equal(parsed.searchParams.get("weekday"), "6");
    assert.equal(parsed.searchParams.get("hour"), "0");
    return jsonResponse(200, { meta: { scope: "tenant" }, totals: { utterances: 7 } });
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const overview = await api.getAnalyticsOverview({
      range: "30d",
      bucket: "1d",
      hubId: "hub-1",
      clientId: "client-1",
      country: "CA",
      message: "speak",
      utterance: "hello",
      intent: "DailyDeskIntent",
      timeStart: "2026-05-03T20:00:00Z",
      timeEnd: "2026-05-03T21:00:00Z",
      weekday: 6,
      hour: 0,
    });

    assert.equal((overview.meta as Record<string, unknown>).scope, "tenant");
    assert.equal((overview.totals as Record<string, unknown>).utterances, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane bootstrap preserves API returned MQTT credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/hubs/hub-mqtt")) {
      return jsonResponse(200, {
        id: "hub-mqtt",
        name: "mqtt-hub",
        domain: "mqtt.thalovant.io",
        data_plane_endpoints: {
          https: "https://mqtt.thalovant.io",
          wss: "wss://mqtt.thalovant.io",
          mqtt: "mqtts://broker.thalovant.io:8883",
        },
        spec: {
          protocols: {
            wss: { enabled: true },
            http: { enabled: true },
            mqtt: { enabled: true, brokerUrl: "mqtts://broker.thalovant.io:8883" },
          },
        },
      });
    }
    if (String(url).endsWith("/v1/clients")) {
      const payload = JSON.parse(String(init?.body)) as Record<string, any>;
      return jsonResponse(201, {
        id: "client-mqtt",
        name: payload.name,
        hub_id: payload.hub_id,
        // The real route echoes the sent spec (apiKey/password/cryptoKey).
        spec: { ...payload.spec, apiKeyRef: { name: "secret", key: "apiKey" } },
        initial_identify_token: "identify-token-1",
        initial_identify: {
          access_key: payload.spec.apiKey,
          password: payload.spec.password,
          crypto_key: payload.spec.cryptoKey,
          site_id: payload.spec.siteId,
          default_master: "wss://mqtt.thalovant.io",
          mqtt: {
            endpoint: "mqtts://broker.thalovant.io:8883",
            username: payload.spec.apiKey,
            password: "broker-password",
            topic_prefix: `hivemind/hub-mqtt/${payload.spec.apiKey}`,
          },
        },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const result = await api.createClientIdentity("hub-mqtt", { name: "kiosk" });

    assert.ok(result.identity.mqtt);
    assert.equal(result.identity.mqtt.endpoint, "mqtts://broker.thalovant.io:8883");
    assert.equal(result.identity.mqtt.password, "broker-password");
    assert.equal(result.identity.endpointFor("mqtt"), "mqtts://broker.thalovant.io:8883");
    assert.deepEqual(api.requireRuntimeProtocol(result, "mqtt"), {
      protocol: "mqtt",
      endpoint: "mqtts://broker.thalovant.io:8883",
    });
    assert.deepEqual((result.asObject().identity as Record<string, any>).mqtt, {
      endpoint: "mqtts://broker.thalovant.io:8883",
      tls: true,
    });

    // Default asObject() also scrubs the raw hub/client records: the
    // initial_identify bundle, its token, and the echoed spec secrets must
    // not appear anywhere in the serialized default view.
    const redacted = result.asObject();
    const redactedClient = redacted.client as Record<string, any>;
    assert.equal("initial_identify" in redactedClient, false);
    assert.equal("initial_identify_token" in redactedClient, false);
    assert.equal("apiKey" in (redactedClient.spec as object), false);
    assert.equal("password" in (redactedClient.spec as object), false);
    assert.equal("cryptoKey" in (redactedClient.spec as object), false);
    assert.equal((redactedClient.spec as Record<string, any>).version, "1");
    assert.deepEqual((redactedClient.spec as Record<string, any>).apiKeyRef, { name: "secret", key: "apiKey" });
    assert.equal(redactedClient.id, "client-mqtt");
    assert.equal((redacted.hub as Record<string, unknown>).id, "hub-mqtt");
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      result.identity.accessKey,
      result.identity.password,
      result.identity.cryptoKey ?? "",
      "broker-password",
      "identify-token-1",
    ]) {
      assert.ok(secret, "expected a non-empty secret to scan for");
      assert.ok(!serialized.includes(secret), "default asObject() leaked a secret value");
    }

    // includeSecrets: true still returns the raw records and real values.
    const full = result.asObject({ includeSecrets: true });
    assert.deepEqual(full.client, result.client);
    assert.deepEqual(full.hub, result.hub);
    const fullIdentity = full.identity as Record<string, any>;
    assert.equal(fullIdentity.access_key, result.identity.accessKey);
    assert.equal(fullIdentity.password, result.identity.password);
    assert.equal(fullIdentity.crypto_key, result.identity.cryptoKey);
    assert.equal(fullIdentity.mqtt.password, "broker-password");

    // The persisted includeSecrets form still round-trips into an identity.
    const restored = new ThalovantIdentity(fullIdentity);
    assert.equal(restored.accessKey, result.identity.accessKey);
    assert.equal(restored.password, result.identity.password);
    assert.equal(restored.cryptoKey, result.identity.cryptoKey);
    assert.equal(restored.siteId, result.identity.siteId);
    assert.equal(restored.mqtt?.password, "broker-password");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identity, MQTT credentials, and control plane redact secrets in debug output", () => {
  const identity = new ThalovantIdentity({
    access_key: "id-access-key-XYZ",
    password: "id-password-XYZ",
    crypto_key: "id-crypto-key-XYZ",
    site_id: "debug-site",
    default_master: "wss://hub.example.com",
    mqtt: {
      endpoint: "mqtts://mqtt.example.com:8883",
      username: "mqtt-user-XYZ",
      password: "mqtt-password-XYZ",
      topic_prefix: "hivemind/hub/access",
    },
  });

  // console.log (util.inspect) and string interpolation never print secrets.
  for (const rendered of [inspect(identity), String(identity)]) {
    for (const secret of [
      "id-access-key-XYZ",
      "id-password-XYZ",
      "id-crypto-key-XYZ",
      "mqtt-user-XYZ",
      "mqtt-password-XYZ",
    ]) {
      assert.ok(!rendered.includes(secret), `identity debug output leaked ${secret}`);
    }
    assert.ok(rendered.includes("ThalovantIdentity"));
    assert.ok(rendered.includes("[redacted]"));
    assert.ok(rendered.includes('"site_id":"debug-site"'));
  }

  assert.ok(identity.mqtt);
  for (const rendered of [inspect(identity.mqtt), String(identity.mqtt)]) {
    assert.ok(!rendered.includes("mqtt-user-XYZ"));
    assert.ok(!rendered.includes("mqtt-password-XYZ"));
    assert.ok(rendered.includes("mqtts://mqtt.example.com:8883"));
  }

  const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "bearer-token-XYZ" });
  for (const rendered of [inspect(api), String(api)]) {
    assert.ok(!rendered.includes("bearer-token-XYZ"), "control plane debug output leaked the bearer token");
    assert.ok(rendered.includes("https://dash.example.com/api"));
    assert.ok(rendered.includes("[redacted]"));
  }

  // No toJSON anywhere: JSON persistence of an identity keeps the real
  // values, so identity files written with JSON.stringify still round-trip.
  const persisted = JSON.parse(JSON.stringify(identity)) as Record<string, any>;
  assert.equal(persisted.accessKey, "id-access-key-XYZ");
  assert.equal(persisted.password, "id-password-XYZ");
  const reloaded = new ThalovantIdentity(persisted);
  assert.equal(reloaded.accessKey, "id-access-key-XYZ");
  assert.equal(reloaded.password, "id-password-XYZ");
  assert.equal(reloaded.cryptoKey, "id-crypto-key-XYZ");
  assert.equal(reloaded.mqtt?.password, "mqtt-password-XYZ");
});

test("control plane API errors keep a bounded detail and never the raw body", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "sk-response-echo-SECRET";
  const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
  try {
    // Structured JSON: only the short string detail is kept, not the body.
    globalThis.fetch = async () =>
      jsonResponse(400, { detail: "spec is invalid", spec: { apiKey: secret, password: secret } });
    await assert.rejects(
      () => api.listHubs(),
      (error: unknown) => {
        assert.ok(error instanceof ThalovantApiError);
        assert.match((error as Error).message, /HTTP 400: spec is invalid/);
        assert.ok(!(error as Error).message.includes(secret), "error message leaked the response body");
        return true;
      },
    );

    // JSON without a recognized string detail is dropped entirely.
    globalThis.fetch = async () => jsonResponse(500, { spec: { apiKey: secret } });
    await assert.rejects(
      () => api.listHubs(),
      (error: unknown) => {
        assert.equal((error as Error).message, "Thalovant API request failed with HTTP 500.");
        return true;
      },
    );

    // Validation arrays keep only the msg string, never the echoed input.
    globalThis.fetch = async () =>
      jsonResponse(422, {
        detail: [{ loc: ["body", "spec", "apiKey"], msg: "value is not a valid string", input: secret }],
      });
    await assert.rejects(
      () => api.listHubs(),
      (error: unknown) => {
        assert.match((error as Error).message, /HTTP 422: value is not a valid string/);
        assert.ok(!(error as Error).message.includes(secret));
        return true;
      },
    );

    // Non-JSON bodies: newline-stripped and length-bounded.
    globalThis.fetch = async () => new Response(`upstream\nexploded ${"x".repeat(500)}`, { status: 502 });
    await assert.rejects(
      () => api.listHubs(),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /HTTP 502: upstream exploded/);
        assert.ok(!message.includes("\n"), "error message kept a newline");
        assert.ok(message.length < 220, `error message is not bounded (${message.length} chars)`);
        return true;
      },
    );

    // The device-token poll terminal branch uses the same bounding.
    globalThis.fetch = async () =>
      jsonResponse(400, { error: "server_error", error_description: "device flow broke", debug_echo: secret });
    await assert.rejects(
      () => api.pollDeviceToken("device-code-1", { sleep: () => {}, now: () => 0 }),
      (error: unknown) => {
        assert.ok(error instanceof ThalovantApiError);
        assert.match((error as Error).message, /HTTP 400: device flow broke/);
        assert.ok(!(error as Error).message.includes(secret));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime crypto key truncates to HiveMind key size", () => {
  assert.deepEqual(runtimeCryptoKey("0123456789abcdef-extra"), Buffer.from("0123456789abcdef"));
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("encryptAsJson emits HiveMind-compatible AES-GCM JSON-HEX payloads", () => {
  const encrypted = encryptAsJson("0123456789abcdef-extra", "hello");
  const parsed = JSON.parse(encrypted) as { ciphertext: string; nonce: string; tag: string };

  assert.match(parsed.ciphertext, /^[0-9a-f]+$/);
  assert.equal(Buffer.from(parsed.nonce, "hex").length, 16);
  assert.equal(Buffer.from(parsed.tag, "hex").length, 16);
  assert.equal(decryptFromJson("0123456789abcdef-extra", encrypted), "hello");
});

test("decryptFromJson accepts legacy AES-GCM JSON-HEX payloads", () => {
  const key = Buffer.from("0123456789abcdef");
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update("hello", "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encrypted = JSON.stringify({
    ciphertext: ciphertext.toString("hex"),
    tag: tag.toString("hex"),
    nonce: nonce.toString("hex"),
  });

  assert.equal(decryptFromJson("0123456789abcdef-extra", encrypted), "hello");
});

test("decryptFromJson accepts AES-GCM JSON-BASE64 payloads", () => {
  const key = Buffer.from("0123456789abcdef");
  const nonce = Buffer.alloc(16, 8);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update("hello", "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encrypted = JSON.stringify({
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
    nonce: nonce.toString("base64"),
  });

  assert.equal(decryptFromJson("0123456789abcdef-extra", encrypted), "hello");
});

test("encryptAsBinary round trips HiveMind MQTT payload bytes", () => {
  const plaintext = Buffer.from("hello", "utf8");
  const encrypted = encryptAsBinary("0123456789abcdef-extra", plaintext);

  assert.deepEqual(decryptBinary("0123456789abcdef-extra", encrypted), plaintext);
});

test("HiveMind binary frames round trip message payloads", () => {
  const encoded = encodeHiveBinaryFrame({
    msg_type: "bus",
    payload: {
      type: "test.event",
      data: { ok: true },
      context: { metadata: { thalovant_owner_id: "owner-1" } },
    },
    metadata: {},
  });
  const decoded = decodeHiveBinaryFrame(encoded);

  assert.equal(encoded[0], 0x82);
  assert.equal(decoded.msg_type, "bus");
  assert.deepEqual(decoded.payload, {
    type: "test.event",
    data: { ok: true },
    context: { metadata: { thalovant_owner_id: "owner-1" } },
  });
});

test("events expose text and match compatible context", () => {
  const context = contextWithCorrelation({}, { sessionId: "session-1", requestId: "request-1" });
  const event = new ThalovantEvent("speak", { utterance: "hi" }, context);

  assert.equal(event.text, "hi");
  assert.equal(event.sessionId, "session-1");
  assert.equal(event.requestId, "request-1");
  assert.equal(eventMatchesContext(event, context), true);
  assert.equal(eventMatchesContext(event, contextWithCorrelation({}, { sessionId: "other" })), false);
});

test("client ask keeps speak listeners open through reply settle", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    emitted: [] as Array<{ eventType: string; data: Record<string, unknown>; context: Record<string, unknown> }>,
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(eventType: string, data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      this.emitted.push({ eventType, data, context });
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "ovos.utterance.handled",
          data: {},
          context,
        },
      }));
      setTimeout(() => {
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "speak",
            data: { utterance: "Late reply" },
            context,
          },
        }));
      }, 10);
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 30 });
  const reply = await client.ask("what is up?");

  assert.equal(reply.text, "Late reply");
  assert.equal(reply.ok, true);
  assert.equal(transport.emitted[0].eventType, "recognizer_loop:utterance");
});

test("client ask waits for a late speak after handled event", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, _data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "ovos.utterance.handled",
          data: {},
          context,
        },
      }));
      setTimeout(() => {
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "speak",
            data: { utterance: "Delayed answer" },
            context,
          },
        }));
      }, 50);
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0, emptyReplyWaitMs: 150 });
  const reply = await client.ask("what is up?");

  assert.equal(reply.text, "Delayed answer");
});

test("client ask treats ovos utterance speak as a reply", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, _data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "ovos.utterance.speak",
          data: { utterance: "It is four twenty four p.m. in Toronto." },
          context,
        },
      }));
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "ovos.utterance.handled",
          data: {},
          context,
        },
      }));
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0 });
  const reply = await client.ask("what time is it?");

  assert.equal(reply.text, "It is four twenty four p.m. in Toronto.");
  assert.deepEqual(reply.events.map((event) => event.name), ["ovos.utterance.speak", "ovos.utterance.handled"]);
});

test("client ask waits for fallback replies after intent failure", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, _data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "complete_intent_failure",
          data: { utterance: "Explain photosynthesis like I am twelve" },
          context,
        },
      }));
      setTimeout(() => {
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "speak",
            data: { utterance: "Photosynthesis is how plants turn light into food." },
            context,
          },
        }));
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "ovos.utterance.handled",
            data: {},
            context,
          },
        }));
      }, 10);
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0 });
  const reply = await client.ask("Explain photosynthesis like I am twelve");

  assert.equal(reply.ok, true);
  assert.equal(reply.text, "Photosynthesis is how plants turn light into food.");
  assert.deepEqual(reply.events.map((event) => event.name), [
    "complete_intent_failure",
    "speak",
    "ovos.utterance.handled",
  ]);
});

test("client ask ignores replies without matching correlation", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, _data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "speak",
          data: { utterance: "Wrong session" },
          context: { session: { session_id: "other" }, request_id: "other" },
        },
      }));
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "speak",
          data: { utterance: "Missing context" },
          context: {},
        },
      }));
      setTimeout(() => {
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "speak",
            data: { utterance: "Right reply" },
            context,
          },
        }));
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "ovos.utterance.handled",
            data: {},
            context,
          },
        }));
      }, 10);
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0 });
  const reply = await client.ask("what is up?");

  assert.equal(reply.text, "Right reply");
  assert.equal(reply.events.length, 2);
});

test("client ask correlates concurrent requests on one transport", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  setMaxListeners(20, eventTarget);
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      const prompt = String((data.utterances as string[] | undefined)?.[0] ?? "");
      const delay = prompt === "first" ? 20 : 5;
      setTimeout(() => {
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "speak",
            data: { utterance: `${prompt} reply` },
            context,
          },
        }));
        eventTarget.dispatchEvent(new CustomEvent("bus", {
          detail: {
            type: "ovos.utterance.handled",
            data: {},
            context,
          },
        }));
      }, delay);
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0 });
  const [first, second] = await Promise.all([
    client.ask("first", { requestId: "request-first" }),
    client.ask("second", { requestId: "request-second" }),
  ]);

  assert.equal(first.text, "first reply");
  assert.equal(first.requestId, "request-first");
  assert.equal(second.text, "second reply");
  assert.equal(second.requestId, "request-second");
  assert.deepEqual(first.events.map(event => event.requestId), [
    "request-first",
    "request-first",
  ]);
  assert.deepEqual(second.events.map(event => event.requestId), [
    "request-second",
    "request-second",
  ]);
});

test("client ask treats HiveMind query timeout as a handled failure", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, _data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "hive.query.timeout",
          data: { utterance: "No answer before HiveMind timed out" },
          context,
        },
      }));
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0 });

  await assert.rejects(
    () => client.ask("what is up?"),
    /No answer before HiveMind timed out/,
  );
});

test("client ask times out when the outbound emit stalls", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const transport = Object.assign(new EventTarget(), {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(): Promise<void> {
      return new Promise(() => undefined);
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0, emptyReplyWaitMs: 0 });

  await assert.rejects(
    () => client.ask("what is up?", { timeoutMs: 10 }),
    /did not finish handling/,
  );
});

test("client ask fails when handled produces no speak reply", async () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    site: "site",
    host: "https://hub.example.com",
  });
  const eventTarget = new EventTarget();
  const transport = Object.assign(eventTarget, {
    async connect(): Promise<void> {},
    async disconnect(): Promise<void> {},
    healthcheck() {
      return {
        connected: true,
        handshakeComplete: true,
        transportAlive: true,
      };
    },
    async emitBus(_eventType: string, _data: Record<string, unknown>, context: Record<string, unknown>): Promise<void> {
      eventTarget.dispatchEvent(new CustomEvent("bus", {
        detail: {
          type: "ovos.utterance.handled",
          data: {},
          context,
        },
      }));
    },
  });

  const client = new ThalovantClient(identity, { transport, replySettleMs: 0, emptyReplyWaitMs: 10 });

  await assert.rejects(
    () => client.ask("what is up?"),
    /did not emit a speak reply/,
  );
});

test("buildClientContext carries generic user auth device metadata", () => {
  const context = buildClientContext({}, {
    userId: "u-1",
    userName: "Ada",
    authToken: "token",
    authProvider: "oidc",
    roles: ["operator"],
    platform: "mobile",
    source: "device-1",
    channel: "chat",
    deviceId: "phone-1",
    metadata: { shift: "night" },
  });

  assert.deepEqual(context.user, { id: "u-1", name: "Ada", roles: ["operator"] });
  assert.deepEqual(context.auth, { token: "token", provider: "oidc" });
  assert.deepEqual(context.device, { id: "phone-1", platform: "mobile" });
  assert.deepEqual(context.metadata, { shift: "night" });
});

test("displayItemsFromEventData extracts text table image and choices", () => {
  const rich = {
    table: '[{"name":"part","status":"ok"}]',
    attachment: { type: "image", payload: { src: "https://example.com/image.png" } },
    quick_replies: [{ title: "Continue", payload: "/continue" }],
  };
  const items = displayItemsFromEventData({
    utterance: "<speak>Hello</speak>",
    rich_media_data: JSON.stringify(rich),
  });

  assert.deepEqual(items.map(item => item.kind), ["text", "table", "image", "choices"]);
  assert.equal(items[0].text, "Hello");
  assert.equal(items[2].url, "https://example.com/image.png");
  assert.deepEqual((items[3].data as Record<string, unknown>[])[0].payload, "/continue");
});

const DEVICE_GRANT = {
  device_code: "device-code-1",
  user_code: "WDJB-MJHT",
  verification_uri: "https://dash.thalovant.com/activate",
  verification_uri_complete: "https://dash.thalovant.com/activate?user_code=WDJB-MJHT",
  expires_in: 900,
  interval: 0,
};

const DEVICE_TOKEN = {
  access_token: "device-token",
  token_type: "bearer",
  scopes: ["hubs:read", "clients:write"],
  expires_at: "2027-08-13T00:00:00Z",
  token_id: "token-1",
};

/** Scripted fetch stub for the device-flow endpoints. */
function deviceFlowFetch(tokenResponses: Array<[number, unknown]>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [...tokenResponses];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    assert.equal(init?.method, "POST");
    assert.equal("authorization" in ((init?.headers ?? {}) as Record<string, string>), false);
    if (String(url).endsWith("/v1/auth/device/authorize")) {
      return jsonResponse(200, DEVICE_GRANT);
    }
    if (String(url).endsWith("/v1/auth/device/token")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { device_code: "device-code-1" });
      const next = responses.shift();
      assert.ok(next, "unexpected extra token poll");
      return jsonResponse(next[0], next[1]);
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

test("control plane loginWithBrowser polls until token and stores it", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const { requests, fetchImpl } = deviceFlowFetch([
    [400, { error: "authorization_pending" }],
    [400, { error: "authorization_pending" }],
    [200, DEVICE_TOKEN],
  ]);
  globalThis.fetch = fetchImpl;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  const opened: string[] = [];

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    const token = await api.loginWithBrowser({
      scopes: ["hubs:read"],
      clientName: "node-test",
      openUrl: url => opened.push(url),
    });

    assert.deepEqual(token, DEVICE_TOKEN);
    assert.equal(api.accessToken, "device-token");
    assert.deepEqual(opened, ["https://dash.thalovant.com/activate?user_code=WDJB-MJHT"]);
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
      scopes: ["hubs:read"],
      client_name: "node-test",
    });
    assert.equal(requests.length, 4);
    assert.ok(
      logs.some(line =>
        line.includes("To sign in, visit https://dash.thalovant.com/activate and enter the code WDJB-MJHT"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("control plane loginWithBrowser custom prompt without opening a browser", async () => {
  const originalFetch = globalThis.fetch;
  const { requests, fetchImpl } = deviceFlowFetch([[200, DEVICE_TOKEN]]);
  globalThis.fetch = fetchImpl;

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    const grants: unknown[] = [];
    await api.loginWithBrowser({
      openBrowser: false,
      prompt: grant => grants.push(grant),
      openUrl: () => assert.fail("browser must not open"),
    });

    assert.deepEqual(grants, [DEVICE_GRANT]);
    assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane device poll slow_down grows the interval", async () => {
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = deviceFlowFetch([
    [400, { error: "authorization_pending" }],
    [400, { error: "slow_down" }],
    [400, { error: "authorization_pending" }],
    [200, DEVICE_TOKEN],
  ]);
  globalThis.fetch = fetchImpl;

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    const sleeps: number[] = [];
    const token = await api.pollDeviceToken("device-code-1", {
      intervalMs: 5000,
      timeoutMs: 900000,
      sleep: ms => {
        sleeps.push(ms);
      },
      now: () => 0,
    });

    assert.deepEqual(token, DEVICE_TOKEN);
    assert.deepEqual(sleeps, [5000, 10000, 10000]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane loginWithBrowser rejects on access_denied", async () => {
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = deviceFlowFetch([[400, { error: "access_denied" }]]);
  globalThis.fetch = fetchImpl;

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    await assert.rejects(
      api.loginWithBrowser({ openBrowser: false, prompt: () => {} }),
      (error: unknown) => error instanceof ThalovantApiError && /denied/.test((error as Error).message),
    );
    assert.equal(api.accessToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane loginWithBrowser rejects on expired_token", async () => {
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = deviceFlowFetch([[400, { error: "expired_token" }]]);
  globalThis.fetch = fetchImpl;

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    await assert.rejects(
      api.loginWithBrowser({ openBrowser: false, prompt: () => {} }),
      (error: unknown) =>
        error instanceof ThalovantApiError && /expired/.test((error as Error).message) && /again/.test((error as Error).message),
    );
    assert.equal(api.accessToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("control plane device poll times out", async () => {
  const originalFetch = globalThis.fetch;
  const { requests, fetchImpl } = deviceFlowFetch([
    [400, { error: "authorization_pending" }],
    [400, { error: "authorization_pending" }],
    [400, { error: "authorization_pending" }],
  ]);
  globalThis.fetch = fetchImpl;

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api");
    let nowMs = 0;
    await assert.rejects(
      api.pollDeviceToken("device-code-1", {
        intervalMs: 5000,
        timeoutMs: 10000,
        sleep: ms => {
          nowMs += ms;
        },
        now: () => nowMs,
      }),
      (error: unknown) => error instanceof ThalovantTimeoutError && /Timed out/.test((error as Error).message),
    );
    assert.equal(requests.length, 3);
    assert.equal(nowMs, 10000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
