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
  noiseStateDir,
  randomBytes,
  readNoiseState,
  writeNoiseState,
} from "./platform/node.js";

export { NOISE_KEY_FILENAME, NOISE_PINS_FILENAME, noiseStateDir };

const KEY_LENGTH = 32;

/**
 * Return this client's persistent static X25519 private key, generating and
 * storing one on first use.
 *
 * It has to persist: a hub pins it on first contact, so a client that
 * regenerates it looks like a different peer and is refused.
 */
export async function loadOrCreateNoiseKey(directory?: string): Promise<Uint8Array> {
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

/** The pinned hub static key for a node id, or undefined for an unseen hub. */
export async function loadNoisePin(directory: string | undefined, nodeId: string): Promise<string | undefined> {
  const pins = await readPins(directory ?? noiseStateDir());
  return pins[nodeId];
}

/** Record the hub static key for a node id on first contact. */
export async function saveNoisePin(directory: string | undefined, nodeId: string, publicKey: string): Promise<void> {
  if (!nodeId.trim() || !publicKey.trim()) return;
  const dir = directory ?? noiseStateDir();
  const pins = await readPins(dir);
  if (pins[nodeId] === publicKey) return;
  pins[nodeId] = publicKey;
  await writeNoiseState(dir, NOISE_PINS_FILENAME, `${JSON.stringify(pins, null, 2)}\n`);
}

/**
 * Drop a pinned hub key.
 *
 * Use it when a hub was deliberately reinstalled or replaced. A pin that stops
 * matching on its own is a failure to investigate, not one to clear.
 */
export async function forgetNoisePin(directory: string | undefined, nodeId: string): Promise<void> {
  const dir = directory ?? noiseStateDir();
  const pins = await readPins(dir);
  if (!(nodeId in pins)) return;
  delete pins[nodeId];
  await writeNoiseState(dir, NOISE_PINS_FILENAME, `${JSON.stringify(pins, null, 2)}\n`);
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
  const pinned = await loadNoisePin(directory, nodeId);
  if (!pinned) {
    await saveNoisePin(directory, nodeId, remoteStaticKey);
    return;
  }
  if (pinned !== remoteStaticKey) {
    throw new ThalovantConnectionError(
      "The hub's Noise static key changed. If the hub was not reinstalled or replaced, another machine may be answering at this address. If it was, drop the stale pin with forgetNoisePin and reconnect to trust the new key.",
    );
  }
}
