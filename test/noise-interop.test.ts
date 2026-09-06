/**
 * Live interop against a real HiveMind-core 5.x listener.
 *
 * The unit tests pin the pre-shared key, canonical JSON and prologue against
 * vectors taken from the reference implementation, which catches every
 * byte-level divergence we know to look for. This catches the ones we do not:
 * the wire type names, the envelope shapes, the order of the exchange, and
 * whether the hub actually accepts what we encrypt.
 *
 * It skips unless a hub is named, because it needs a running listener:
 *
 * ```
 * hivemind-core add-client --name node --access-key <key> --password <password>
 * hivemind-core allow-msg recognizer_loop:utterance <id>
 * hivemind-core listen
 *
 * THALOVANT_INTEROP_WSS=ws://127.0.0.1:5678 \
 * THALOVANT_INTEROP_ACCESS_KEY=<key> \
 * THALOVANT_INTEROP_PASSWORD=<password> \
 * npm test
 * ```
 *
 * A hub pins the client static key on first contact, so a run whose state
 * directory has been discarded needs `hivemind-core reset-noise-pin <key>`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ThalovantClient } from "../src/client.js";
import { ThalovantIdentity } from "../src/identity.js";

test("completes a v3 handshake against a live hub", async t => {
  const endpoint = process.env.THALOVANT_INTEROP_WSS;
  const accessKey = process.env.THALOVANT_INTEROP_ACCESS_KEY;
  const password = process.env.THALOVANT_INTEROP_PASSWORD;
  if (!endpoint || !accessKey || !password) {
    t.skip(
      "set THALOVANT_INTEROP_WSS, THALOVANT_INTEROP_ACCESS_KEY and THALOVANT_INTEROP_PASSWORD to run the live interop test",
    );
    return;
  }

  const noiseStateDir =
    process.env.THALOVANT_INTEROP_STATE_DIR || (await mkdtemp(join(tmpdir(), "thalovant-interop-")));
  t.after(async () => {
    if (!process.env.THALOVANT_INTEROP_STATE_DIR) {
      await rm(noiseStateDir, { recursive: true, force: true });
    }
  });

  const identity = new ThalovantIdentity({
    access_key: accessKey,
    password,
    site_id: "node-interop",
    default_master: endpoint,
    data_plane_endpoints: { wss: endpoint },
  });
  const client = new ThalovantClient(identity, { protocol: "wss", noiseStateDir });

  const info = await client.connectWithInfo(40000);
  t.after(async () => {
    await client.close();
  });
  assert.equal(info.phase, "ready", `the v3 handshake against ${endpoint} did not complete`);

  // A message the hub has to decrypt and route proves the transport, not just
  // the handshake.
  await client.emit("recognizer_loop:utterance", { utterances: ["hello from node"], lang: "en-US" });

  // Give the hub a moment to close the socket if it disliked the frame.
  await new Promise(resolve => setTimeout(resolve, 1500));
  const health = client.healthcheck();
  assert.ok(
    health.connected && health.handshakeComplete,
    `the session dropped after the first encrypted message: ${JSON.stringify(health)}`,
  );
});
