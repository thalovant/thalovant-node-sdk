import assert from "node:assert/strict";
import test from "node:test";

import { ThalovantControlPlane, ThalovantIdentity, endpointBase, endpointFromDomain } from "../src/index.js";
import { trimSlashes, trimTrailingSlashes } from "../src/slashes.js";

test("slashes are trimmed as the patterns did, in linear time", () => {
  for (const [text, trailing, both] of [
    ["", "", ""],
    ["/", "", ""],
    ["///a//b///", "///a//b", "a//b"],
    ["a", "a", "a"],
    ["https://hub.example.invalid/", "https://hub.example.invalid", "https://hub.example.invalid"],
  ]) {
    assert.equal(trimTrailingSlashes(text), trailing);
    assert.equal(trimSlashes(text), both);
  }
  // The input a backtracking pattern takes quadratic time over.
  const hostile = `${"/".repeat(200_000)}x`;
  const started = performance.now();
  trimTrailingSlashes(hostile);
  trimSlashes(hostile);
  new ThalovantControlPlane(`https://api.example.invalid${hostile}`);
  endpointFromDomain(`hub.example.invalid${hostile}`, "https");
  endpointBase(`not a url${hostile}`, 443, "");
  new ThalovantIdentity({ key: "k", password: "p", host: `https://hub.example.invalid${hostile}`, site: "s" });
  assert.ok(performance.now() - started < 1_000);
});
