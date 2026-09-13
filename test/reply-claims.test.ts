import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { replyClaimMetadata, ThalovantEvent, type EventContext } from "../src/index.js";
const vectors = JSON.parse(readFileSync(new URL("../../test/reply-claim-vectors.json", import.meta.url), "utf8"));
for (const row of vectors.cases) test(`reply claim: ${row.name}`, () => {
  const reply = { events: row.contexts.map((context: EventContext) => new ThalovantEvent("speak", {}, context)),
    handled: row.handled, ok: row.handled && !row.failed,
    failureEvent: row.failed ? new ThalovantEvent("failure") : undefined };
  assert.deepEqual(replyClaimMetadata(reply), { pipelineIds: row.expected.pipeline_ids,
    skillIds: row.expected.skill_ids, claimed: row.expected.claimed });
});
