/**
 * Node platform bindings. This is the only SDK module (besides
 * `../transport-mqtt.js`) allowed to import `node:` builtins or the `ws`
 * package. Browser bundlers swap this file for `./browser.js` through the
 * `browser` map in package.json, so nothing here may be imported from shared
 * code except through the `./platform/node.js` specifier.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
