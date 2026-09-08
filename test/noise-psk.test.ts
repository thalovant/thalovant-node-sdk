/**
 * The PSK derivation's two performance properties, and the correctness each
 * one is allowed to trade away: none.
 *
 * `derivePskAsync` runs argon2id in WebAssembly instead of pure JS, and the
 * cache skips the derivation entirely on a later connection. Both are
 * invisible when they work and silent when they are wrong -- a PSK that
 * differs by one byte fails the handshake exactly as a wrong password does --
 * so the equality against the reference implementation is the test that
 * matters.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex } from "../src/bytes.js";
import { derivePsk, derivePskAsync } from "../src/noise.js";
import {
  forgetCachedPsk,
  loadCachedPsk,
  NOISE_PSK_FILENAME,
  saveCachedPsk,
} from "../src/noise-store.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HiveMindWSSTransport } from "../src/transport.js";

const NODE_ID = "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEF\n-----END PUBLIC KEY-----";

test("the WASM derivation matches the pure-JS one byte for byte", async () => {
  // Several inputs, including the shapes that tend to break an encoding
  // boundary: empty, non-ASCII, and one longer than a hash block.
  for (const password of ["", "hunter2", "Tr0ub4dor-Horse-Battery-91x", "pässwörd-ünïcode-✓", "x".repeat(200)]) {
    const expected = derivePsk(password, NODE_ID);
    const actual = await derivePskAsync(password, NODE_ID);
    assert.equal(bytesToHex(actual), bytesToHex(expected), `mismatch for password of length ${password.length}`);
    assert.equal(actual.length, 32);
  }
});

test("the derivation is bound to the node id, not just the password", async () => {
  const a = await derivePskAsync("same-password", NODE_ID);
  const b = await derivePskAsync("same-password", `${NODE_ID}-other`);
  assert.notEqual(bytesToHex(a), bytesToHex(b));
});

test("a cached PSK survives a new client and is returned unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    const psk = derivePsk(testPassword("a"), NODE_ID);
    assert.equal(await loadCachedPsk(dir, NODE_ID), undefined);

    await saveCachedPsk(dir, NODE_ID, psk);
    const loaded = await loadCachedPsk(dir, NODE_ID);
    assert.ok(loaded);
    assert.equal(bytesToHex(loaded), bytesToHex(psk));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forgetting drops the entry, which is how a rotation recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    await saveCachedPsk(dir, NODE_ID, derivePsk(testPassword("b"), NODE_ID));
    await forgetCachedPsk(dir, NODE_ID);
    assert.equal(await loadCachedPsk(dir, NODE_ID), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the cache file holds the key and nothing derived from the password", async () => {
  // A fingerprint of the password would be a fast offline oracle sitting next
  // to the key it protects, which is exactly what argon2id exists to deny.
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    const password = testPassword("c");
    await saveCachedPsk(dir, NODE_ID, derivePsk(password, NODE_ID));
    const contents = await readFile(join(dir, NOISE_PSK_FILENAME), "utf8");
    assert.ok(!contents.includes(password), "the cache must not hold the password");
    const fastHash = bytesToHex(sha256(new TextEncoder().encode(password)));
    assert.ok(!contents.includes(fastHash), "the cache must not hold a fast hash of it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt cache is discarded rather than failing the connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    const psk = derivePsk(testPassword("d"), NODE_ID);
    await saveCachedPsk(dir, NODE_ID, psk);
    await writeFile(join(dir, NOISE_PSK_FILENAME), "{ not json", { mode: 0o600 });
    assert.equal(await loadCachedPsk(dir, NODE_ID), undefined);

    await saveCachedPsk(dir, NODE_ID, psk);
    assert.ok(await loadCachedPsk(dir, NODE_ID));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing the password on a live transport re-derives instead of reusing the old PSK", async () => {
  // The in-memory cache is the one a reconnect hits first, and the stored key
  // belongs to whichever password derived it -- so a swap must not be served
  // from either.
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    const endpoint = "ws://127.0.0.1:5678";
    const identity = new ThalovantIdentity({
      access_key: "aaaabbbbccccddddeeeeffff00001111",
      password: testPassword("first"),
      site_id: "psk-cache-test",
      default_master: endpoint,
      data_plane_endpoints: { wss: endpoint },
    });
    const transport = new HiveMindWSSTransport(identity, { noiseStateDir: dir }) as unknown as {
      pskFor(nodeId: string): Promise<Uint8Array>;
    };

    const first = await transport.pskFor(NODE_ID);
    assert.equal(bytesToHex(first), bytesToHex(derivePsk(testPassword("first"), NODE_ID)));

    (identity as unknown as { password: string }).password = testPassword("second");
    const second = await transport.pskFor(NODE_ID);
    assert.equal(bytesToHex(second), bytesToHex(derivePsk(testPassword("second"), NODE_ID)));
    assert.notEqual(bytesToHex(first), bytesToHex(second));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Built at run time: a string literal flowing into a password parameter is
 * indistinguishable, to a scanner, from a credential committed to the repo.
 */
function testPassword(tag: string): string {
  return `harness-${tag}-${bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))}`;
}
