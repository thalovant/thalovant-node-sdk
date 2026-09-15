import assert from "node:assert/strict";
import test from "node:test";
import { hubDisplayName } from "../src/hubs.js";

/** What a phone calls a hub. It called them slugs until 2026-09-15. */

test("a hub is called what a person was shown, not what the row is keyed by", () => {
  // Exactly what a phone was offered: name IS the slug, and the readable
  // title sits in the catalog entry.
  assert.equal(
    hubDisplayName({ name: "ops-copilot", slug: "ops-copilot", spec: { catalog: { title: "Ops Copilot" } } }),
    "Ops Copilot",
  );
});

test("a real name wins when there is no catalog entry", () => {
  assert.equal(hubDisplayName({ name: "The Kitchen", slug: "kitchen" }), "The Kitchen");
});

test("a hub with nothing but a slug is made readable rather than shown raw", () => {
  assert.equal(hubDisplayName({ slug: "daily-desk" }), "Daily Desk");
  assert.equal(hubDisplayName({ name: "news-stream", slug: "news-stream" }), "News Stream");
  assert.equal(hubDisplayName({ slug: "local_pulse" }), "Local Pulse");
});

test("a hub described with nothing at all still says something", () => {
  assert.equal(hubDisplayName({ id: "1" }), "A Thalovant hub");
  assert.equal(hubDisplayName({ name: "", slug: "   " }), "A Thalovant hub");
});

test("a spec that is not shaped like a catalog does not throw", () => {
  assert.equal(hubDisplayName({ spec: "nonsense", slug: "kitchen" }), "Kitchen");
  assert.equal(hubDisplayName({ spec: { catalog: [] }, name: "Kitchen" }), "Kitchen");
});
