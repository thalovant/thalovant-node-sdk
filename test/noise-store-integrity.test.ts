import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";

import { ThalovantIdentityError } from "../src/errors.js";
import { forgetNoisePin, loadNoisePin, loadOrCreateNoiseKey, pinHubKey, saveNoisePin, NOISE_KEY_FILENAME, NOISE_PINS_FILENAME } from "../src/noise-store.js";
import { withNoiseStateLock } from "../src/platform/node.js";

for (const raw of ["", "null", "[]", '"text"', '{"hub":null}', '{"hub":false}', '{"hub":0}', '{"hub":""}', '{"hub":"not-a-key"}']) {
  test(`corrupt pin bytes fail closed without publishing new trust: ${JSON.stringify(raw)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "thalovant-pin-corruption-"));
    const path = join(directory, NOISE_PINS_FILENAME);
    try {
      await writeFile(path, raw, { mode: 0o600 });
      await assert.rejects(loadNoisePin(directory, "hub"), ThalovantIdentityError);
      await assert.rejects(pinHubKey(directory, "hub", "ab".repeat(32)), ThalovantIdentityError);
      assert.equal(await readFile(path, "utf8"), raw);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a separately held process lock blocks pin publication and a timed-out waiter preserves its owner", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-process-lock-"));
  const lockPath = join(directory, ".noise-state.lock");
  const owner = "test-only-other-process-owner";
  let child: ReturnType<typeof fork> | undefined;
  try {
    await writeFile(lockPath, owner, { mode: 0o600 });
    let entered = false;
    await assert.rejects(withNoiseStateLock(directory, async () => { entered = true; }, 50), /locked by another writer/);
    assert.equal(entered, false);
    assert.equal(await readFile(lockPath, "utf8"), owner);
    child = fork(new URL("./noise-store-process-fixture.js", import.meta.url), [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    await once(child, "message"); // Child is loaded and ready to start its transaction.
    let completed = false;
    const result = once(child, "message").then(([value]) => { completed = true; return value; });
    child.send("pin");
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    assert.equal(completed, false, "another process wrote through the active state owner");
    await assert.rejects(readFile(join(directory, NOISE_PINS_FILENAME)), { code: "ENOENT" });
    await rm(lockPath);
    assert.deepEqual(await result, { result: "pinned" });
    assert.equal(await loadNoisePin(directory, "process-peer"), "cd".repeat(32));
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two Node processes initialize one persistent static key", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-key-processes-"));
  const children: ReturnType<typeof fork>[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const child = fork(new URL("./noise-store-process-fixture.js", import.meta.url), [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      children.push(child);
      await once(child, "message");
    }
    const results = children.map(child => once(child, "message").then(([value]) => value as { key: string }));
    for (const child of children) child.send("key");
    const [first, second] = await Promise.all(results);
    assert.match(first.key, /^[0-9a-f]{64}$/);
    assert.equal(first.key, second.key);
    assert.equal(await readFile(join(directory, NOISE_KEY_FILENAME), "utf8"), first.key);
  } finally {
    for (const child of children) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const conflict of [false, true]) {
  test(`independent process pin transactions ${conflict ? "accept one competing hub key" : "preserve every different hub"}`, { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "thalovant-pin-processes-"));
    const children: ReturnType<typeof fork>[] = [];
    try {
      for (let index = 0; index < 6; index++) {
        const nodeId = conflict ? "shared-hub" : `hub-${index}`;
        const byte = (index + 10).toString(16).padStart(2, "0");
        const child = fork(new URL("./noise-store-process-fixture.js", import.meta.url), [directory, nodeId, byte], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        children.push(child);
        await once(child, "message");
      }
      const results = children.map(child => once(child, "message").then(([value]) => value as { result: string }));
      for (const child of children) child.send("pin");
      const completed = await Promise.all(results);
      assert.equal(completed.filter(item => item.result === "pinned").length, conflict ? 1 : children.length);
      if (conflict) {
        const winner = completed.findIndex(item => item.result === "pinned");
        assert.equal(await loadNoisePin(directory, "shared-hub"), (winner + 10).toString(16).padStart(2, "0").repeat(32));
      } else {
        for (let index = 0; index < children.length; index++) {
          assert.equal(await loadNoisePin(directory, `hub-${index}`), (index + 10).toString(16).padStart(2, "0").repeat(32));
        }
      }
    } finally {
      for (const child of children) child.kill();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("existing trust survives an unreadable pin path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-unreadable-pins-"));
  try {
    // A directory at the file path fails deterministically even for privileged CI users.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, NOISE_PINS_FILENAME));
    await assert.rejects(pinHubKey(directory, "hub", "ab".repeat(32)), ThalovantIdentityError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const raw of ["", " ", "zz".repeat(32)]) {
  test(`corrupt static key bytes are never replaced: ${JSON.stringify(raw)}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "thalovant-key-corruption-"));
    const path = join(directory, NOISE_KEY_FILENAME);
    try {
      await writeFile(path, raw, { mode: 0o600 });
      await assert.rejects(loadOrCreateNoiseKey(directory), ThalovantIdentityError);
      assert.equal(await readFile(path, "utf8"), raw);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("invalid pin input never poisons existing trust and explicit valid overwrite remains available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-pin-input-"));
  try {
    await saveNoisePin(directory, "hub", "aa".repeat(32));
    const before = await readFile(join(directory, NOISE_PINS_FILENAME), "utf8");
    for (const value of ["invalid", "zz".repeat(32), "ab".repeat(31), " ab".repeat(32)]) {
      await assert.rejects(saveNoisePin(directory, "other", value), ThalovantIdentityError);
      await assert.rejects(pinHubKey(directory, "other", value), ThalovantIdentityError);
      assert.equal(await readFile(join(directory, NOISE_PINS_FILENAME), "utf8"), before);
    }
    await saveNoisePin(directory, "hub", "bb".repeat(32));
    assert.equal(await loadNoisePin(directory, "hub"), "bb".repeat(32));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("prototype-shaped node IDs are ordinary own pin entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-pin-node-ids-"));
  try {
    for (const nodeId of ["__proto__", "toString", "constructor"]) {
      assert.equal(await loadNoisePin(directory, nodeId), undefined);
      await pinHubKey(directory, nodeId, "aa".repeat(32));
      await assert.rejects(pinHubKey(directory, nodeId, "bb".repeat(32)), /static key changed/);
      assert.equal(await loadNoisePin(directory, nodeId), "aa".repeat(32));
      await forgetNoisePin(directory, nodeId);
      assert.equal(await loadNoisePin(directory, nodeId), undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("equivalent hexadecimal key casing preserves verified pin bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-pin-case-"));
  try {
    for (const [stored, incoming] of [["AB", "ab"], ["ab", "AB"]]) {
      await saveNoisePin(directory, "hub", stored.repeat(32));
      const before = await readFile(join(directory, NOISE_PINS_FILENAME), "utf8");
      await pinHubKey(directory, "hub", incoming.repeat(32));
      assert.equal(await readFile(join(directory, NOISE_PINS_FILENAME), "utf8"), before);
      assert.equal(await loadNoisePin(directory, "hub"), stored.repeat(32));
      await assert.rejects(pinHubKey(directory, "hub", "cd".repeat(32)), /static key changed/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
