import assert from "node:assert/strict";
import test from "node:test";
import { buildClientContext } from "../src/context.js";
import { decryptFromJson, encryptAsJson, runtimeCryptoKey } from "../src/crypto.js";
import { contextWithCorrelation, eventMatchesContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { displayItemsFromEventData } from "../src/rich.js";

test("identity normalizes aliases", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    cryptoKey: "0123456789abcdef-extra",
    site: "site",
    host: "https://hub.example.com/",
    port: "443",
    path: "/hivemind/public",
  });

  assert.equal(identity.accessKey, "access");
  assert.equal(identity.defaultMaster, "https://hub.example.com");
  assert.equal(identity.defaultPort, 443);
  assert.equal(identity.defaultPath, "/hivemind/public");
  assert.equal(identity.endpointBase(), "https://hub.example.com/hivemind/public");
});

test("runtime crypto key truncates to HiveMind key size", () => {
  assert.deepEqual(runtimeCryptoKey("0123456789abcdef-extra"), Buffer.from("0123456789abcdef"));
});

test("encryptAsJson round trips AES-GCM JSON-HEX payloads", () => {
  const encrypted = encryptAsJson("0123456789abcdef-extra", "hello");

  assert.equal(decryptFromJson("0123456789abcdef-extra", encrypted), "hello");
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
