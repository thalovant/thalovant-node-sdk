import assert from "node:assert/strict";
import test from "node:test";
import { buildClientContext } from "../src/context.js";
import { decryptBinary, decryptFromJson, encryptAsBinary, encryptAsJson, runtimeCryptoKey } from "../src/crypto.js";
import { contextWithCorrelation, eventMatchesContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HubDataPlaneEndpoints, HubProtocolSettings, selectDataPlaneEndpoint } from "../src/protocols.js";
import { displayItemsFromEventData } from "../src/rich.js";
import { ThalovantControlPlane } from "../src/control.js";
import { ThalovantClient } from "../src/client.js";
import { ThalovantUnsupportedProtocolError } from "../src/errors.js";
import { mqttTopicsForIdentity } from "../src/transport.js";
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

  assert.doesNotThrow(() => new ThalovantClient(identity, { protocol: "wss" }));
  assert.doesNotThrow(() => new ThalovantClient(identity, { protocol: "mqtt" }));
  assert.deepEqual(mqttTopicsForIdentity(identity), {
    c2s: "hivemind/hub/c2s/access",
    s2c: "hivemind/hub/s2c/access",
    status: "hivemind/hub/status/access",
  });
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
    assert.equal(result.selectedProtocol, "https");
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

test("encryptAsJson round trips AES-GCM JSON-HEX payloads", () => {
  const encrypted = encryptAsJson("0123456789abcdef-extra", "hello");

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
