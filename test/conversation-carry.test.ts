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
