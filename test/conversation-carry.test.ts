/**
 * Carrying a conversation between the turns of a named session.
 *
 * A hub keeps nothing for one: OVOS-SESSION-2 §2.2 makes the orchestrator
 * stateless, so the carrier a client sends is the whole snapshot and whatever
 * the last turn activated is discarded the moment it ends. Without
 * `converse_handlers` the converse pipeline has no skill to poll and every
 * follow-up reaches the fallback instead of the skill that just answered.
 *
 * The cases are `contracts/conformance/conversation-vectors.json` and
 * `mesh-vectors.json`, shared with every other SDK so that "on par" is
 * something a machine checks rather than something a digest asserts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONVERSATION_SESSION_FIELDS,
  HIVE_KINDS,
  carryConversation,
} from "../src/events.js";

function vectors(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../test/${name}`, import.meta.url), "utf8"));
}

test("the carry matches conversation-vectors.json", () => {
  for (const row of vectors("conversation-vectors.json").cases as Array<Record<string, never>>) {
    assert.deepEqual(carryConversation(row.previous, row.session), row.expected, row.name);
  }
});

test("the carried fields are the ones conversation-vectors.json names", () => {
  const spec = vectors("conversation-vectors.json");
  assert.deepEqual([...CONVERSATION_SESSION_FIELDS].sort(), [...(spec.carried_fields as string[])].sort());
});

test("the fields conversation-vectors.json forbids never travel", () => {
  // A remembered `lang` would pin a bilingual conversation to whichever
  // language it opened in, which is the failure this list prevents.
  for (const field of vectors("conversation-vectors.json").never_carried as string[]) {
    assert.ok(!(CONVERSATION_SESSION_FIELDS as readonly string[]).includes(field), field);
  }
});

test("the hive kinds are the ones mesh-vectors.json names", () => {
  const spec = vectors("mesh-vectors.json");
  assert.deepEqual([...HIVE_KINDS].sort(), [...(spec.kinds as string[])].sort());
});

test("this client's own traffic is not a hive kind", () => {
  // `query` and `cascade` belong to ask(); subscribing to one here would
  // quietly compete for the same replies.
  for (const refused of vectors("mesh-vectors.json").refused_kinds as string[]) {
    assert.ok(!(HIVE_KINDS as readonly string[]).includes(refused), refused);
  }
});

test("the carry survives whichever session id the caller sends back", async () => {
  // A reply's `sessionId` is the first non-empty *event* session id, so when a
  // hub answers under an id of its own the reply hands the caller an id the
  // carry used to be filed under nothing. Both are kept now: the request's,
  // which a satellite reuses, and the hub's, which the reply offers.
  const { ThalovantClient } = await import("../src/client.js");
  const { ThalovantIdentity } = await import("../src/identity.js");
  const identity = new ThalovantIdentity({
    accessKey: "key", password: "password", siteId: "site",
    defaultMaster: "http://hub.local", defaultPort: 5679,
  });
  const client = new ThalovantClient(identity, { transport: {} as never });

  const handlers = {
    converse_handlers: [{ skill_id: "fart", activated_at: 1 }],
  };
  (client as never as { rememberConversation(id: string, ctx: unknown): void })
    .rememberConversation("sat-1", { session: { ...handlers } });
  (client as never as { rememberConversation(id: string, ctx: unknown): void })
    .rememberConversation("hub-namespace:sat-1", { session: { ...handlers } });

  const viaRequestId = (client as never as {
    continueConversation(ctx: unknown, id: string): Record<string, never>;
  }).continueConversation({}, "sat-1");
  const viaReplyId = (client as never as {
    continueConversation(ctx: unknown, id: string): Record<string, never>;
  }).continueConversation({}, "hub-namespace:sat-1");

  for (const [name, next] of [["request id", viaRequestId], ["reply id", viaReplyId]] as const) {
    const session = (next as Record<string, Record<string, unknown>>).session;
    assert.ok(session?.converse_handlers, `${name} lost the carry`);
  }
});

test("an empty string is a cleared field, not conversation state", async () => {
  const { carryConversation } = await import("../src/events.js");
  const carried = carryConversation({ response_mode: "" }, {});
  assert.equal(carried.response_mode, undefined, JSON.stringify(carried));
});
