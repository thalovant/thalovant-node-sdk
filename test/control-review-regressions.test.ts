import assert from "node:assert/strict";
import test from "node:test";

import { ThalovantControlPlane } from "../src/control.js";
import { ThalovantIdentity } from "../src/identity.js";
import { ThalovantApiError } from "../src/errors.js";

for (const unusable of [0, "", {}, { msg: [] }]) {
  test(`API errors retain a later usable detail after ${JSON.stringify(unusable)}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ detail: { msg: unusable, message: "Meaningful API failure" } }), { status: 400 });
    try {
      const api = new ThalovantControlPlane("https://api.example.test", { accessToken: "test-only-token" });
      await assert.rejects(api.listHubs(), error => error instanceof ThalovantApiError && error.message === "Thalovant API request failed with HTTP 400: Meaningful API failure");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const key of ["apiSecret", "SECRET_KEY", "credentials", "ACCESS-TOKEN", "refresh_token"]) {
  test(`default metadata views omit ${key} without changing persistence`, () => {
    const secret = "test-only-review-redaction-value";
    const reference = { name: "key-reference", key: "apiKey" };
    const metadata = { nested: [{ [key]: secret, apiKeyRef: reference, label: "keep" }] };
    const identity = new ThalovantIdentity({ accessKey: "test-only-access", password: "test-only-password", host: "hub.example.test", site: "test-only-site", metadata });
    assert.deepEqual(identity.asObject().metadata, { nested: [{ apiKeyRef: reference, label: "keep" }] });
    assert.deepEqual(identity.asObject(true).metadata, metadata);
    assert.deepEqual(identity.metadata, metadata);
    assert.ok(!String(identity).includes(secret));
  });
}
