/**
 * Where an identity's Noise key lives (0.9.1): beside the identity file it was
 * read from, unless a folder is named, with the key it had in the old shared
 * folder copied -- never moved -- the first time, when that key has met this
 * hub.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  NOISE_KEY_FILENAME,
  NOISE_PINS_FILENAME,
  ThalovantClient,
  ThalovantClientKeyRejectedError,
  ThalovantIdentity,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/bytes.js";
import { x25519PublicKey } from "../src/noise.js";
import { createV3HubPeer, V3_HUB_NODE_ID } from "./v3-hub.js";

const HUB_KEY = new Uint8Array(32).fill(7);
const OLD_CLIENT_KEY = "11".repeat(32);

interface Scene {
  root: string;
  /** The shared default folder: $XDG_CONFIG_HOME/thalovant. */
  legacy: string;
  url: string;
  /** Client static keys the hub saw, in order. */
  clientKeys: string[];
  /** Close every link right after the handshake, as a hub that pinned another client key does. */
  refuse: boolean;
}

async function scene(t: test.TestContext): Promise<Scene> {
  const root = await mkdtemp(join(tmpdir(), "thalovant-key-folder-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const state: Scene = {
    root,
    legacy: join(root, "config", "thalovant"),
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clientKeys: [],
    refuse: false,
  };
  server.on("connection", (socket) => {
    const hub = createV3HubPeer("secret", (data, binary) => socket.send(data, { binary }), { staticPrivateKey: HUB_KEY });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      hub.onMessage(isBinary ? new Uint8Array(data) : data.toString());
      if (hub.clientStaticKey && !state.clientKeys.includes(hub.clientStaticKey)) state.clientKeys.push(hub.clientStaticKey);
      if (state.refuse && hub.received.length === 1) socket.close();
    });
    hub.start();
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  return state;
}

async function identityFile(folder: string, url: string): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, "identity.json");
  await writeFile(path, JSON.stringify({ access_key: "a", password: "secret", site_id: "s", default_master: url }), { mode: 0o600 });
  return path;
}

/** The old shared folder, holding a key that has (or has not) met this hub. */
async function legacyKey(legacy: string, nodeId: string): Promise<void> {
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  await writeFile(join(legacy, NOISE_KEY_FILENAME), OLD_CLIENT_KEY, { mode: 0o600 });
  await writeFile(join(legacy, NOISE_PINS_FILENAME), JSON.stringify({ [nodeId]: bytesToHex(x25519PublicKey(HUB_KEY)) }), { mode: 0o600 });
}

async function connectOnce(identity: ThalovantIdentity, options: { noiseStateDir?: string } = {}): Promise<void> {
  const client = new ThalovantClient(identity, { protocol: "wss", ...options });
  try {
    await client.connect(10_000);
  } finally {
    await client.close();
  }
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const oldPublicKey = () => bytesToHex(x25519PublicKey(hexToBytes(OLD_CLIENT_KEY)));

test("an identity read from a file knows it, keeps it out of every serialized form, and compares as before", async (t) => {
  const { root, url } = await scene(t);
  const path = await identityFile(join(root, "elsewhere"), url);
  const read = await ThalovantIdentity.fromFile(path);
  assert.equal(read.sourcePath, path);
  const built = new ThalovantIdentity({ access_key: "a", password: "secret", site_id: "s", default_master: url });
  assert.equal(built.sourcePath, undefined);
  assert.deepStrictEqual(read, built);
  for (const form of [JSON.stringify(read.asObject(true)), JSON.stringify(read.asObject())]) assert.ok(!form.includes(path));
});

test("with no folder named, the key lives beside the identity file", async (t) => {
  const { root, url, legacy } = await scene(t);
  const folder = join(root, "elsewhere");
  await connectOnce(await ThalovantIdentity.fromFile(await identityFile(folder, url)));
  assert.ok(await exists(join(folder, NOISE_KEY_FILENAME)));
  assert.ok(await exists(join(folder, NOISE_PINS_FILENAME)));
  assert.equal(await exists(join(legacy, NOISE_KEY_FILENAME)), false, "the shared folder is not used");
});

test("the key this hub already pinned is copied from the old shared folder, once, and left there", async (t) => {
  const { root, url, legacy, clientKeys } = await scene(t);
  await legacyKey(legacy, V3_HUB_NODE_ID);
  const folder = join(root, "elsewhere");
  const identity = await ThalovantIdentity.fromFile(await identityFile(folder, url));
  await connectOnce(identity);
  assert.equal((await readFile(join(folder, NOISE_KEY_FILENAME), "utf8")).trim(), OLD_CLIENT_KEY);
  assert.deepEqual(clientKeys, [oldPublicKey()], "the hub sees the key it pinned");
  assert.equal(await readFile(join(legacy, NOISE_KEY_FILENAME), "utf8"), OLD_CLIENT_KEY, "copied, never moved");
  // Once: the folder has its key now, and a changed old key is not taken again.
  await writeFile(join(legacy, NOISE_KEY_FILENAME), "22".repeat(32), { mode: 0o600 });
  await connectOnce(identity);
  assert.equal((await readFile(join(folder, NOISE_KEY_FILENAME), "utf8")).trim(), OLD_CLIENT_KEY);
});

test("a copy cut short before the key fails the connection, and the next connect copies again", async (t) => {
  const { root, url, legacy, clientKeys } = await scene(t);
  await legacyKey(legacy, V3_HUB_NODE_ID);
  const folder = join(root, "elsewhere");
  const identity = await ThalovantIdentity.fromFile(await identityFile(folder, url));
  // The pins are copied, then writing the key fails once (a full disk, say).
  const fs = createRequire(import.meta.url)("node:fs/promises") as { rename: (from: string, to: string) => Promise<void> };
  const rename = fs.rename;
  let failures = 1;
  fs.rename = async (from, to) => {
    if (failures > 0 && to.endsWith(NOISE_KEY_FILENAME)) {
      failures -= 1;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.rename = rename;
    syncBuiltinESMExports();
  });
  await assert.rejects(connectOnce(identity));
  assert.equal(failures, 0, "the copy reached the key");
  assert.ok(await exists(join(folder, NOISE_PINS_FILENAME)), "the pins went first");
  assert.equal(await exists(join(folder, NOISE_KEY_FILENAME)), false, "no key of its own the hub would refuse");
  assert.deepEqual(clientKeys, []);
  await connectOnce(identity);
  assert.equal((await readFile(join(folder, NOISE_KEY_FILENAME), "utf8")).trim(), OLD_CLIENT_KEY);
  assert.deepEqual(clientKeys, [oldPublicKey()], "the hub sees the key it pinned");
});

test("an old key that never met this hub is not copied", async (t) => {
  const { root, url, legacy, clientKeys } = await scene(t);
  await legacyKey(legacy, "another-hub-node-id");
  const folder = join(root, "elsewhere");
  await connectOnce(await ThalovantIdentity.fromFile(await identityFile(folder, url)));
  assert.notEqual((await readFile(join(folder, NOISE_KEY_FILENAME), "utf8")).trim(), OLD_CLIENT_KEY);
  assert.notDeepEqual(clientKeys, [oldPublicKey()]);
});

test("an identity file in the shared folder keeps its key where it always was", async (t) => {
  const { url, legacy, clientKeys } = await scene(t);
  await legacyKey(legacy, V3_HUB_NODE_ID);
  await connectOnce(await ThalovantIdentity.fromFile(await identityFile(legacy, url)));
  assert.deepEqual(clientKeys, [oldPublicKey()]);
});

test("a named folder wins, and a refused key names it and the folder beside the identity file", async (t) => {
  const state = await scene(t);
  const folder = join(state.root, "elsewhere");
  const named = join(state.root, "named");
  const identity = await ThalovantIdentity.fromFile(await identityFile(folder, state.url));
  await connectOnce(identity, { noiseStateDir: named });
  assert.ok(await exists(join(named, NOISE_KEY_FILENAME)));
  assert.equal(await exists(join(folder, NOISE_KEY_FILENAME)), false);

  state.refuse = true;
  const client = new ThalovantClient(identity, { protocol: "wss", noiseStateDir: named });
  t.after(() => client.close());
  // XX (the named folder pinned the hub, but this hub offers only XX), then a
  // close before the hub said anything: the hub refused this client's key.
  const error = await client.connect(10_000).then(
    () => new Promise<unknown>((resolve) => setTimeout(() => resolve(client.connectionInfo()), 300)),
    (caught: unknown) => caught,
  );
  const info = error instanceof ThalovantClientKeyRejectedError
    ? { keyFolder: error.keyFolder, otherKeyFolder: error.otherKeyFolder }
    : error as { keyFolder?: string; otherKeyFolder?: string; clientKeyRejected?: boolean };
  if (!(error instanceof ThalovantClientKeyRejectedError)) assert.equal((error as { clientKeyRejected?: boolean }).clientKeyRejected, true);
  assert.equal(info.keyFolder, named);
  assert.equal(info.otherKeyFolder, folder);
});
