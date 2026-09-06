/**
 * Node platform bindings. This is the only SDK module (besides
 * `../transport-mqtt.js`) allowed to import `node:` builtins or the `ws`
 * package. Browser bundlers swap this file for `./browser.js` through the
 * `browser` map in package.json, so nothing here may be imported from shared
 * code except through the `./platform/node.js` specifier.
 */
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import WebSocket from "ws";
import { parse as parseYaml } from "yaml";

import { ThalovantIdentityError } from "../errors.js";
import type { PlatformWebSocket } from "./types.js";

const AUTH_TAG_SIZE = 16;

export const isBrowserPlatform = false;

export function randomUUID(): string {
  return nodeRandomUUID();
}

export function randomBytes(size: number): Uint8Array {
  return nodeRandomBytes(size);
}

/** AES-128-GCM seal; returns `ciphertext || tag` (tag is 16 bytes). */
export function aesGcmEncryptSync(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** AES-128-GCM open; expects `ciphertext || tag` (tag is 16 bytes). */
export function aesGcmDecryptSync(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array {
  const raw = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const tag = raw.subarray(raw.length - AUTH_TAG_SIZE);
  const ciphertext = raw.subarray(0, raw.length - AUTH_TAG_SIZE);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return aesGcmEncryptSync(key, nonce, plaintext);
}

export async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  return aesGcmDecryptSync(key, nonce, sealed);
}

export function inflateBytes(bytes: Uint8Array): Uint8Array {
  return inflateSync(bytes);
}

export function createPlatformWebSocket(url: string): PlatformWebSocket {
  return new NodePlatformWebSocket(url);
}

class NodePlatformWebSocket implements PlatformWebSocket {
  private readonly socket: WebSocket;

  constructor(readonly url: string) {
    this.socket = new WebSocket(url);
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  onOpen(handler: () => void): void {
    this.socket.on("open", handler);
  }

  onMessage(handler: (data: string | Uint8Array) => void): void {
    this.socket.on("message", data => handler(normalizeWsData(data)));
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.socket.on("close", (code, reason) => handler(code, reason.toString("utf8")));
  }

  onError(handler: (error: Error) => void): void {
    this.socket.on("error", handler);
  }

  send(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(data, error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): void {
    this.socket.close();
  }

  terminate(): void {
    this.socket.terminate();
  }
}

function normalizeWsData(data: WebSocket.RawData): string | Uint8Array {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** Reads a secret file after enforcing owner-only permissions. */
export async function readSecretFile(path: string, description: string): Promise<string> {
  let mode: number;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    throw new ThalovantIdentityError(`Unable to read ${description}: ${path}`);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new ThalovantIdentityError(`${capitalize(description)} is too permissive: ${path}. Run \`chmod 600 ${path}\`.`);
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ThalovantIdentityError(`Unable to read ${description}: ${path}`);
  }
}

export function parseYamlText(text: string): unknown {
  return parseYaml(text);
}

export function defaultConfigPath(filename: string): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, "thalovant", filename);
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "Thalovant", filename);
  }
  return join(homedir(), ".config", "thalovant", filename);
}

export function envVar(name: string): string | undefined {
  return process.env[name];
}

/**
 * Best-effort attempt to open a URL in the user's default browser. Resolves
 * `false` (never throws) when no opener is available, so callers can always
 * fall back to printing the URL.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    return await new Promise(resolve => {
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
  } catch {
    return false;
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Persistent state for the v3 Noise handshake, kept beside the SDK config file.
 *
 * `noise_key` holds this client's static X25519 private key and `noise_pins.json`
 * the hub keys it has pinned. Both are written `0600`, and the key file is
 * refused if it is group- or world-accessible, matching every other on-disk
 * secret the SDK reads.
 *
 * The static key has to persist: a hub pins it on first contact, so a client
 * that regenerates it looks like a different peer and is refused.
 */
export async function readNoiseState(directory: string, filename: string): Promise<string | undefined> {
  const path = join(directory, filename);
  try {
    await stat(path);
  } catch {
    return undefined;
  }
  if (filename === NOISE_KEY_FILENAME) {
    return readSecretFile(path, "Noise key file");
  }
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeNoiseState(directory: string, filename: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // mode on writeFile only applies at creation, so an existing file keeps
  // whatever it had; chmod after the write makes it 0600 either way.
  const path = join(directory, filename);
  await writeFile(path, contents, { mode: 0o600 });
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}

export const NOISE_KEY_FILENAME = "noise_key";
export const NOISE_PINS_FILENAME = "noise_pins.json";

export function noiseStateDir(): string {
  return dirname(defaultConfigPath("config.yaml"));
}
