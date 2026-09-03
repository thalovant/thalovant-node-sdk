import assert from "node:assert/strict";
import test from "node:test";
import { eventMatchesContext } from "../src/events.js";
import type { ThalovantEvent } from "../src/events.js";

// A hub substitutes its own session id; the request id is what correlates.
// Observed against a live hub on 2026-09-03: a client declaring
// session_id="observe-me" gets every reply back carrying
// "71048b7f-e7b0-4360-8fb5-a03816f78617". Comparing session ids rejected
// replies the request id had already identified as ours, so ask() timed out
// while the hub had answered. Verified across a matched skill, an unmatched
// fallback and a French utterance.

const ev = (sessionId?: string, requestId?: string): ThalovantEvent =>
  ({ name: "ovos.utterance.handled", data: {}, context: {}, sessionId, requestId }) as unknown as ThalovantEvent;

const asked = (sessionId?: string, requestId?: string) => {
  const c: Record<string, unknown> = {};
  if (sessionId) c.session = { session_id: sessionId };
  if (requestId) c.request_id = requestId;
  return c;
};

test("a matching request id wins over a substituted session", () => {
  assert.equal(
    eventMatchesContext(ev("71048b7f-e7b0-4360-8fb5-a03816f78617", "req-1"), asked("observe-me", "req-1")),
    true,
  );
});

test("a wrong request id is rejected even if sessions agree", () => {
  assert.equal(eventMatchesContext(ev("same", "req-2"), asked("same", "req-1")), false);
});

test("a reply without a request id falls back to the session", () => {
  assert.equal(eventMatchesContext(ev("s1", undefined), asked("s1", "req-1")), true);
  assert.equal(eventMatchesContext(ev("other", undefined), asked("s1", "req-1")), false);
});

test("without request ids the session still decides", () => {
  assert.equal(eventMatchesContext(ev("s1"), asked("s1")), true);
  assert.equal(eventMatchesContext(ev("s2"), asked("s1")), false);
});

test("asking for nothing accepts anything", () => {
  assert.equal(eventMatchesContext(ev("x", "y"), undefined), true);
});
