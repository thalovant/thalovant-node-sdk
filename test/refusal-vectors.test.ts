/**
 * What an ask does when the hub refuses it, against the vectors every SDK shares.
 *
 * `contracts/conformance/refusal-vectors.json` in the Python SDK, vendored
 * here unchanged and pinned by the parity contract: a refusal becomes a typed
 * error carrying the hub's code and, for a spent quota, its numbers; an
 * unmatched intent is an unanswered question; and a denial with no request id
 * is taken only by the ask that can be the one it refused.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ThalovantClient } from "../src/client.js";
import { ThalovantPolicyDeniedError, ThalovantTimeoutError, ThalovantUnansweredError } from "../src/errors.js";
import { ThalovantEvent, type EventContext } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";
import { failureError, refusalBelongsToAsk, UNTRACKED_UTTERANCE_GRACE_MS } from "../src/refusal.js";

function loadVectors(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../test/${name}`, import.meta.url), "utf8"));
}
const spec = loadVectors("refusal-vectors.json");

function eventOf(wire: { type: string; data?: Record<string, unknown>; context?: EventContext }): ThalovantEvent {
  return new ThalovantEvent(wire.type, wire.data ?? {}, wire.context ?? {});
}

for (const vector of spec.classification) {
  test(`classification: ${vector.name}`, () => {
    const error = failureError(eventOf(vector.event));
    if (vector.expect.kind === "unanswered") {
      assert.ok(error instanceof ThalovantUnansweredError, String(error));
      // What the person said, which is what a caller shows.
      assert.equal(error.said, vector.expect.said);
      return;
    }
    assert.ok(error instanceof ThalovantPolicyDeniedError, String(error));
    assert.deepEqual(
      {
        kind: "refused",
        denied_type: error.deniedType,
        code: error.code,
        reason: error.reason,
        allowed: [...error.allowed],
        quota: error.quota
          ? { period: error.quota.period, limit: error.quota.limit, used: error.quota.used, reset_after: error.quota.resetAfter }
          : null,
      },
      vector.expect,
    );
  });
}

for (const vector of spec.correlation) {
  test(`correlation: ${vector.name}`, () => {
    const requestId = vector.request_id === "own" ? "req-own" : vector.request_id === "other" ? "req-other" : undefined;
    assert.equal(
      refusalBelongsToAsk({
        requestId,
        ownRequestId: "req-own",
        deniedType: vector.denied_type,
        asksInFlight: vector.asks_in_flight,
        queriesInFlight: vector.queries_in_flight,
        sendsInFlight: vector.sends_in_flight,
      }),
      vector.taken,
    );
  });
}

test("the grace window is the one the vectors name", () => {
  assert.equal(UNTRACKED_UTTERANCE_GRACE_MS, spec.untracked_grace_seconds * 1000);
});

test("the vectors cover every kind of refusal", () => {
  // A copy that quietly lost its quota or its unanswered case would still pass.
  const codes = new Set(spec.classification.map((v: any) => v.expect.code));
  for (const code of ["acl_disallowed_type", "intent_quota_exceeded", "backend_unavailable"]) assert.ok(codes.has(code), code);
  assert.deepEqual(new Set(spec.classification.map((v: any) => v.expect.kind)), new Set(["refused", "unanswered"]));
  assert.deepEqual(new Set(spec.correlation.map((v: any) => v.taken)), new Set([true, false]));
});

class Hub extends EventTarget {
  ready = false;
  sends = 0;
  contexts: EventContext[] = [];
  onSend: (hub: Hub, send: number) => void = () => {};
  async connect() { this.ready = true; }
  async disconnect() { this.ready = false; }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus(_name: string, _data: Record<string, unknown>, context: EventContext) {
    this.sends += 1; this.contexts.push(context); this.onSend(this, this.sends);
  }
  bus(type: string, data: Record<string, unknown> = {}, context: EventContext = {}) {
    this.dispatchEvent(new CustomEvent("bus", { detail: { type, data, context } }));
  }
}
function client(hub: Hub, replySettleMs = 50) {
  return new ThalovantClient(
    new ThalovantIdentity({ key: "fixture", password: "fixture", host: "https://fixture.invalid", site: "fixture" }),
    { transport: hub, replySettleMs, emptyReplyWaitMs: 50 },
  );
}
const quotaDenial = {
  denied_type: "recognizer_loop:utterance", code: "intent_quota_exceeded", reason: "daily intent quota exceeded",
  data: { period: "daily", limit: 50, used: 50, reset_after: 36120 },
};

test("an uncorrelated quota refusal ends the ask at once, with its numbers", async () => {
  // The production shape: denied at once, no request id, the numbers nested.
  const hub = new Hub();
  hub.onSend = h => h.bus("hive.policy.denied", quotaDenial, { source: "hivemind-core" });
  const sdk = client(hub);
  const started = performance.now();
  try {
    const error = await sdk.ask("what time is it", { timeoutMs: 5000 }).then(() => undefined, e => e);
    assert.ok(error instanceof ThalovantPolicyDeniedError, String(error));
    assert.ok(performance.now() - started < 2000, "it waited out the deadline instead of taking the refusal");
    assert.deepEqual(error.quota, { period: "daily", limit: 50, used: 50, resetAfter: 36120 });
    assert.ok(!error.message.includes("dashboard"), "a spent day is not an allow-list to edit");
  } finally { await sdk.close(); }
});

test("an unmatched intent is an unanswered question, not a failure", async () => {
  const hub = new Hub();
  hub.onSend = h => h.bus("ovos.intent.unmatched", { utterance: "book me a flight to the moon" }, h.contexts.at(-1));
  const sdk = client(hub);
  try {
    await assert.rejects(sdk.ask("book me a flight to the moon", { timeoutMs: 1000 }), ThalovantUnansweredError);
  } finally { await sdk.close(); }
});

test("with two asks in flight an uncorrelated denial fails neither", async () => {
  // Either could be the one refused; ending the wrong one fails a question the
  // hub never refused. Delivered on the second send, when both are out.
  const hub = new Hub();
  hub.onSend = (h, send) => { if (send === 2) h.bus("hive.policy.denied", quotaDenial, { source: "hivemind-core" }); };
  const sdk = client(hub);
  try {
    const first = sdk.ask("first", { timeoutMs: 300 }).then(() => undefined, e => e);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = sdk.ask("second", { timeoutMs: 300 }).then(() => undefined, e => e);
    const outcomes = await Promise.all([first, second]);
    assert.equal(hub.sends, 2);
    for (const outcome of outcomes) assert.ok(outcome instanceof ThalovantTimeoutError, String(outcome));
  } finally { await sdk.close(); }
});

test("an ask does not take a denial a fire-and-forget send could own", async () => {
  // sendUtterance() has no reply and no id, but the hub can refuse it, and that
  // refusal names only the type. Arriving while an ask waits, it could be
  // either message's -- so the ask is left to its own deadline.
  const hub = new Hub();
  hub.onSend = (h, send) => { if (send === 2) h.bus("hive.policy.denied", quotaDenial, { source: "hivemind-core" }); };
  const sdk = client(hub);
  try {
    await sdk.sendUtterance("turn the lights off");
    await assert.rejects(sdk.ask("what time is it", { timeoutMs: 300 }), ThalovantTimeoutError);
    assert.equal(hub.sends, 2);
  } finally { await sdk.close(); }
});

test("a send that never left is not in flight", async () => {
  // A phantom would suppress a real refusal for the whole grace window.
  class Broken extends Hub {
    breaking = true;
    override async emitBus(name: string, data: Record<string, unknown>, context: EventContext): Promise<void> {
      if (this.breaking) throw new Error("no route to the hub");
      return super.emitBus(name, data, context);
    }
  }
  const hub = new Broken();
  const sdk = client(hub);
  try {
    await assert.rejects(sdk.sendUtterance("turn the lights off"));
    hub.breaking = false;
    hub.onSend = h => h.bus("hive.policy.denied", quotaDenial, { source: "hivemind-core" });
    // The refusal is this ask's: nothing else is out.
    await assert.rejects(sdk.ask("what time is it", { timeoutMs: 5000 }), ThalovantPolicyDeniedError);
  } finally { await sdk.close(); }
});
