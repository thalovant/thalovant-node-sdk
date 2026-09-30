import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { replyClaimMetadata, ThalovantEvent, type EventContext } from "../src/index.js";
import { record } from "./conformance-record.js";
const vectors = JSON.parse(readFileSync(new URL("../../test/reply-claim-vectors.json", import.meta.url), "utf8"));
for (const row of vectors.cases) test(`reply claim: ${row.name}`, () => {
  const metas: Array<Record<string, unknown> | null> = row.metas ?? row.contexts.map(() => null);
  const names: string[] = row.names ?? row.contexts.map(() => "speak");
  const reply = { events: row.contexts.map((context: EventContext, index: number) => {
      const meta = metas[index];
      return new ThalovantEvent(names[index] ?? "speak", meta ? { meta } : {}, context);
    }),
    handled: row.handled, ok: row.handled && !row.failed,
    failureEvent: row.failed ? new ThalovantEvent("failure") : undefined };
  const produced = replyClaimMetadata(reply);
  assert.deepEqual(produced, { pipelineIds: row.expected.pipeline_ids,
    skillIds: row.expected.skill_ids, claimed: row.expected.claimed });
  record("reply-claim-vectors.json", row.name, produced);
});
