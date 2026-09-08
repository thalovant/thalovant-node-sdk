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

import { bytesToHex } from "../src/bytes.js";
import { derivePsk, derivePskAsync, pskPasswordVerifier } from "../src/noise.js";
import { loadCachedPsk, NOISE_PSK_FILENAME, saveCachedPsk } from "../src/noise-store.js";
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
    const psk = derivePsk("hunter2", NODE_ID);
    const verifier = pskPasswordVerifier("hunter2");
    assert.equal(await loadCachedPsk(dir, NODE_ID, verifier), undefined);

    await saveCachedPsk(dir, NODE_ID, psk, verifier);
    const loaded = await loadCachedPsk(dir, NODE_ID, verifier);
    assert.ok(loaded);
    assert.equal(bytesToHex(loaded), bytesToHex(psk));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a rotated password invalidates the cache instead of offering a stale key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    await saveCachedPsk(dir, NODE_ID, derivePsk("old-password", NODE_ID), pskPasswordVerifier("old-password"));
    // The hub would refuse the old PSK in a way indistinguishable from a wrong
    // password, so the cache has to notice the rotation itself.
    assert.equal(await loadCachedPsk(dir, NODE_ID, pskPasswordVerifier("new-password")), undefined);
    assert.ok(await loadCachedPsk(dir, NODE_ID, pskPasswordVerifier("old-password")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the cache file never contains the password itself", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    const password = "a-very-distinctive-password-9931";
    await saveCachedPsk(dir, NODE_ID, derivePsk(password, NODE_ID), pskPasswordVerifier(password));
    const contents = await readFile(join(dir, NOISE_PSK_FILENAME), "utf8");
    assert.ok(!contents.includes(password), "the verifier must not be reversible to the password");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt cache is discarded rather than failing the connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    await saveCachedPsk(dir, NODE_ID, derivePsk("hunter2", NODE_ID), pskPasswordVerifier("hunter2"));
    await writeFile(join(dir, NOISE_PSK_FILENAME), "{ not json", { mode: 0o600 });
    assert.equal(await loadCachedPsk(dir, NODE_ID, pskPasswordVerifier("hunter2")), undefined);
    // and it recovers: a fresh save replaces the damaged file
    await saveCachedPsk(dir, NODE_ID, derivePsk("hunter2", NODE_ID), pskPasswordVerifier("hunter2"));
    assert.ok(await loadCachedPsk(dir, NODE_ID, pskPasswordVerifier("hunter2")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing the password on a live transport re-derives instead of reusing the old PSK", async () => {
  // The in-memory cache is the one a reconnect hits first, so keying it on the
  // node id alone would hand back the previous password's PSK -- and the hub
  // would refuse it exactly as it refuses a wrong password.
  const dir = await mkdtemp(join(tmpdir(), "thalovant-psk-"));
  try {
    const endpoint = "ws://127.0.0.1:5678";
    const identity = new ThalovantIdentity({
      access_key: "aaaabbbbccccddddeeeeffff00001111",
      password: "first-password",
      site_id: "psk-cache-test",
      default_master: endpoint,
      data_plane_endpoints: { wss: endpoint },
    });
    const transport = new HiveMindWSSTransport(identity, { noiseStateDir: dir }) as unknown as {
      pskFor(nodeId: string): Promise<Uint8Array>;
    };

    const first = await transport.pskFor(NODE_ID);
    assert.equal(bytesToHex(first), bytesToHex(derivePsk("first-password", NODE_ID)));

    (identity as unknown as { password: string }).password = "second-password";
    const second = await transport.pskFor(NODE_ID);
    assert.equal(bytesToHex(second), bytesToHex(derivePsk("second-password", NODE_ID)));
    assert.notEqual(bytesToHex(first), bytesToHex(second));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
