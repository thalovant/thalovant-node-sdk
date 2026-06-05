import assert from "node:assert/strict";
import test from "node:test";
import { decryptFromJson, encryptAsJson, runtimeCryptoKey } from "../src/crypto.js";
import { contextWithCorrelation, eventMatchesContext, ThalovantEvent } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";

test("identity normalizes aliases", () => {
  const identity = new ThalovantIdentity({
    key: "access",
    password: "secret",
    cryptoKey: "0123456789abcdef-extra",
    site: "site",
    host: "https://hub.example.com/",
    port: "443",
  });

  assert.equal(identity.accessKey, "access");
  assert.equal(identity.defaultMaster, "https://hub.example.com");
  assert.equal(identity.defaultPort, 443);
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
