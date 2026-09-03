import assert from "node:assert/strict";
import test from "node:test";
import { eventMatchesContext, sessionIdsMatch } from "../src/events.js";
import type { ThalovantEvent } from "../src/events.js";

// A hub rewrites a client-declared session id before the orchestrator sees it:
// hivemind-core derives a Layer-1 identity as `${conn_nonce}:${declared}` so two
// clients cannot collide on the same name (HIVEMIND-BRIDGE-1 §4). Comparing the
// returned id to the sent one for equality rejected every reply: ask() timed out
// while the hub had already answered and emitted ovos.utterance.handled.
// Reproduced against a live hub on 2026-09-03 - 480ms with no session id, a
// full timeout with one.

const event = (sessionId: string): ThalovantEvent =>
  ({
    name: "ovos.utterance.handled",
    data: {},
    context: { session: { session_id: sessionId } },
    sessionId,
    requestId: undefined,
  }) as unknown as ThalovantEvent;

const asked = (sessionId: string) => ({ session: { session_id: sessionId } });

test("a NAT-rewritten reply is recognised", () => {
  assert.equal(eventMatchesContext(event("d41d8cd98f00b204:my-session"), asked("my-session")), true);
});

test("an unrewritten reply is still recognised", () => {
  assert.equal(eventMatchesContext(event("my-session"), asked("my-session")), true);
});

test("a reply for a different session is still rejected", () => {
  assert.equal(eventMatchesContext(event("nonce:other"), asked("my-session")), false);
  assert.equal(eventMatchesContext(event("other"), asked("my-session")), false);
});

test("asking without a session accepts anything", () => {
  assert.equal(eventMatchesContext(event("nonce:whatever"), undefined), true);
});

test("only the declared half after the first colon matches", () => {
  assert.equal(sessionIdsMatch("abc", "nonce:abc"), true);
  assert.equal(sessionIdsMatch("abc", "abc"), true);
  // a bare endsWith would wrongly accept these
  assert.equal(sessionIdsMatch("abc", "nonce:xabc"), false);
  assert.equal(sessionIdsMatch("abc", "nonce:abc:def"), false);
  // a declared id containing a colon still matches as a whole
  assert.equal(sessionIdsMatch("a:b", "nonce:a:b"), true);
  assert.equal(sessionIdsMatch("abc", ""), false);
  assert.equal(sessionIdsMatch("abc", "nonce:"), false);
});
