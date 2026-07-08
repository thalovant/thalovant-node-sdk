import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { buildClientContext } from "../src/context.js";
import { decryptBinary, decryptFromJson, encryptAsBinary, encryptAsJson, runtimeCryptoKey } from "../src/crypto.js";
import { contextWithCorrelation, eventMatchesContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HubDataPlaneEndpoints, HubProtocolSettings, selectDataPlaneEndpoint } from "../src/protocols.js";
import { displayItemsFromEventData } from "../src/rich.js";
import { ThalovantControlPlane } from "../src/control.js";
import { ThalovantClient } from "../src/client.js";
import { ThalovantUnsupportedProtocolError } from "../src/errors.js";
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

test("control plane fetches analytics overview", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, "/api/v1/admin/analytics/overview");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer token");
    assert.equal(parsed.searchParams.get("range"), "30d");
    assert.equal(parsed.searchParams.get("bucket"), "1d");
    assert.equal(parsed.searchParams.get("owner_id"), "owner-1");
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
    return jsonResponse(200, { meta: { scope: "admin" }, totals: { utterances: 7 } });
  };

  try {
    const api = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
    const overview = await api.getAnalyticsOverview({
      admin: true,
      range: "30d",
      bucket: "1d",
      ownerId: "owner-1",
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

    assert.equal((overview.meta as Record<string, unknown>).scope, "admin");
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
        spec: { version: "1", apiKeyRef: { name: "secret", key: "apiKey" } },
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
