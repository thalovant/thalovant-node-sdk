/**
 * Platform-neutral byte helpers shared by the Node and browser builds.
 *
 * Everything in this module is pure JavaScript on top of `Uint8Array`,
 * `TextEncoder`, and `TextDecoder`, which exist in Node 20+ and every
 * evergreen browser. No `node:` builtins may be imported here.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP: Record<string, number> = {};
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
  BASE64_LOOKUP[BASE64_ALPHABET[index]] = index;
}
BASE64_LOOKUP["-"] = 62;
BASE64_LOOKUP["_"] = 63;

interface BufferLikeConstructor {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
}

export function utf8Encode(text: string): Uint8Array {
  return textEncoder.encode(text);
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Returns a `Buffer` view over the same bytes when running on Node so callers
 * keep receiving `Buffer` instances from public APIs, and the plain
 * `Uint8Array` unchanged in browsers.
 */
export function nativeBytes(bytes: Uint8Array): Uint8Array {
  const BufferCtor = (globalThis as { Buffer?: BufferLikeConstructor }).Buffer;
  return BufferCtor ? BufferCtor.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim();
  if (normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    throw new Error("Invalid hex payload");
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index];
    const b1 = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const b2 = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += index + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : "=";
    out += index + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : "=";
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Accepts standard and URL-safe base64, with or without padding. */
export function base64ToBytes(text: string): Uint8Array {
  const normalized = text.replace(/\s+/g, "").replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((normalized.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of normalized) {
    const value = BASE64_LOOKUP[char];
    if (value === undefined) {
      throw new Error("Invalid base64 payload");
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
}

export function base64FromUtf8(text: string): string {
  return bytesToBase64(utf8Encode(text));
}
