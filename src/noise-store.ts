/**
 * Persistent state for the v3 Noise handshake: this client's static key and the
 * hub keys it has pinned.
 *
 * Where that state actually lives is the platform's business — files beside the
 * SDK config file in Node, `localStorage` in a browser — so this module only
 * decides *what* is stored and enforces trust on first use on top of it.
 */

import { bytesToHex, hexToBytes } from "./bytes.js";
import { ThalovantConnectionError, ThalovantIdentityError } from "./errors.js";
import {
  NOISE_KEY_FILENAME,
  NOISE_PINS_FILENAME,
  NOISE_PSK_FILENAME,
  noiseStateDir,
  randomBytes,
  readNoiseState,
  writeNoiseState,
} from "./platform/node.js";

export { NOISE_KEY_FILENAME, NOISE_PINS_FILENAME, NOISE_PSK_FILENAME, noiseStateDir };

const KEY_LENGTH = 32;

/**
 * Serializes the read-modify-write of the pin file, so two connections pinning
 * different hubs at once cannot lose one another's entry. This is the
 * in-process half; the atomic rename in `writeNoiseState` covers a second
 * process racing the same file.
 */
let pinChain: Promise<unknown> = Promise.resolve();

function withPinLock<T>(work: () => Promise<T>): Promise<T> {
  const result = pinChain.then(work, work);
  pinChain = result.catch(() => undefined);
  return result;
}

/**
 * Return this client's persistent static X25519 private key, generating and
 * storing one on first use.
 *
 * It has to persist: a hub pins it on first contact, so a client that
 * regenerates it looks like a different peer and is refused.
 */
export async function loadOrCreateNoiseKey(directory?: string): Promise<Uint8Array> {
  return withPinLock(async () => loadOrCreateNoiseKeyLocked(directory));
}

async function loadOrCreateNoiseKeyLocked(directory?: string): Promise<Uint8Array> {
  const dir = directory ?? noiseStateDir();
  const stored = await readNoiseState(dir, NOISE_KEY_FILENAME);
  if (stored) {
    const trimmed = stored.trim();
    if (trimmed.length !== KEY_LENGTH * 2) {
      throw new ThalovantIdentityError(
        `The stored Noise key is not a ${KEY_LENGTH}-byte hex key. Remove ${NOISE_KEY_FILENAME} to generate a new one; a hub that pinned the old key will need \`hivemind-core reset-noise-pin\`.`,
      );
    }
    return hexToBytes(trimmed);
  }
  const key = randomBytes(KEY_LENGTH);
  await writeNoiseState(dir, NOISE_KEY_FILENAME, bytesToHex(key));
  return key;
}

async function readPins(directory: string): Promise<Record<string, string>> {
  const raw = await readNoiseState(directory, NOISE_PINS_FILENAME);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    throw new ThalovantIdentityError(
      `The stored Noise pins are not a JSON object of node id to key. Remove ${NOISE_PINS_FILENAME} to start over.`,
    );
  }
}

async function writePins(directory: string, pins: Record<string, string>): Promise<void> {
  await writeNoiseState(directory, NOISE_PINS_FILENAME, `${JSON.stringify(pins, null, 2)}\n`);
}

/** The pinned hub static key for a node id, or undefined for an unseen hub. */
export async function loadNoisePin(directory: string | undefined, nodeId: string): Promise<string | undefined> {
  const pins = await readPins(directory ?? noiseStateDir());
  return pins[nodeId];
}

/** Record the hub static key for a node id on first contact. */
export async function saveNoisePin(directory: string | undefined, nodeId: string, publicKey: string): Promise<void> {
  if (!nodeId.trim() || !publicKey.trim()) return;
  await withPinLock(() => saveNoisePinLocked(directory, nodeId, publicKey));
}

async function saveNoisePinLocked(
  directory: string | undefined,
  nodeId: string,
  publicKey: string,
): Promise<void> {
  const dir = directory ?? noiseStateDir();
  const pins = await readPins(dir);
  if (pins[nodeId] === publicKey) return;
  pins[nodeId] = publicKey;
  await writePins(dir, pins);
}

/**
 * Drop a pinned hub key.
 *
 * Use it when a hub was deliberately reinstalled or replaced. A pin that stops
 * matching on its own is a failure to investigate, not one to clear.
 */
export async function forgetNoisePin(directory: string | undefined, nodeId: string): Promise<void> {
  await withPinLock(async () => {
    const dir = directory ?? noiseStateDir();
    const pins = await readPins(dir);
    if (!(nodeId in pins)) return;
    delete pins[nodeId];
    await writePins(dir, pins);
  });
}

/**
 * Enforce trust on first use: the first key seen for a node id is recorded, and
 * a later key that does not match it is refused.
 *
 * A changed key means either the hub was reinstalled or another machine is
 * answering at this address. The SDK cannot tell those apart, so it refuses and
 * leaves clearing the pin (`forgetNoisePin`) as a deliberate act.
 */
export async function pinHubKey(
  directory: string | undefined,
  nodeId: string,
  remoteStaticKey: string,
): Promise<void> {
  if (!remoteStaticKey) return;
  // Read and write inside one critical section. Checking for a pin and then
  // writing it as separate steps is the race itself: two connections could
  // both see no pin and the later one would overwrite the earlier decision.
  await withPinLock(async () => {
    const pins = await readPins(directory ?? noiseStateDir());
    const pinned = pins[nodeId];
    if (!pinned) {
      await saveNoisePinLocked(directory, nodeId, remoteStaticKey);
      return;
    }
    if (pinned !== remoteStaticKey) {
      throw new ThalovantConnectionError(
        "The hub's Noise static key changed. If the hub was not reinstalled or replaced, another machine may be answering at this address. If it was, drop the stale pin with forgetNoisePin and reconnect to trust the new key.",
      );
    }
  });
}

/**
 * Cached pre-shared keys, keyed by hub node id.
 *
 * The derivation is argon2id at 64 MiB and depends only on the password and
 * the hub's node id, both constant for the life of the pairing -- so it is the
 * same answer every time, and recomputing it on every connection is pure cost.
 * The in-memory cache on the transport only helps one client object; this
 * survives reconnects, new clients in the same process, and process restarts.
 *
 * Only the key is stored. A fingerprint of the password would make rotation
 * cheap to detect, but it would also put a fast hash of the password in the
 * same file as the key it protects -- and a fast hash is exactly the offline
 * oracle argon2id exists to deny. A password rotated elsewhere is noticed when
 * the hub rejects the stale key, and `forgetCachedPsk` drops it.
 */
async function readPskCache(directory: string): Promise<Record<string, string>> {
  const raw = await readNoiseState(directory, NOISE_PSK_FILENAME);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    // A corrupt cache is derivable state, not a reason to fail a connection.
    return {};
  }
}

/** The cached PSK for a hub, or undefined when there is none. */
export async function loadCachedPsk(
  directory: string | undefined,
  nodeId: string,
): Promise<Uint8Array | undefined> {
  if (!nodeId.trim()) return undefined;
  const encoded = (await readPskCache(directory ?? noiseStateDir()))[nodeId];
  if (typeof encoded !== "string" || encoded.trim().length !== KEY_LENGTH * 2) return undefined;
  try {
    return hexToBytes(encoded.trim());
  } catch {
    return undefined;
  }
}

/** Record a derived PSK so the next connection to this hub skips argon2id. */
export async function saveCachedPsk(
  directory: string | undefined,
  nodeId: string,
  psk: Uint8Array,
): Promise<void> {
  if (!nodeId.trim() || psk.length !== KEY_LENGTH) return;
  await withPinLock(async () => {
    const dir = directory ?? noiseStateDir();
    const cache = await readPskCache(dir);
    const encoded = bytesToHex(psk);
    if (cache[nodeId] === encoded) return;
    cache[nodeId] = encoded;
    await writeNoiseState(dir, NOISE_PSK_FILENAME, `${JSON.stringify(cache, null, 2)}\n`);
  });
}

/**
 * Drop a stored PSK.
 *
 * The handshake calls this when the hub rejects the key we offered, which is
 * how a password rotated elsewhere is noticed: the next attempt derives again.
 */
export async function forgetCachedPsk(
  directory: string | undefined,
  nodeId: string,
): Promise<void> {
  await withPinLock(async () => {
    const dir = directory ?? noiseStateDir();
    const cache = await readPskCache(dir);
    if (!(nodeId in cache)) return;
    delete cache[nodeId];
    await writeNoiseState(dir, NOISE_PSK_FILENAME, `${JSON.stringify(cache, null, 2)}\n`);
  });
}
