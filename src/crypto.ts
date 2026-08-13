import {
  base64ToBytes,
  bytesToHex,
  concatBytes,
  hexToBytes,
  nativeBytes,
  utf8Decode,
  utf8Encode,
} from "./bytes.js";
import {
  aesGcmDecrypt,
  aesGcmDecryptSync,
  aesGcmEncrypt,
  aesGcmEncryptSync,
  randomBytes,
} from "./platform/node.js";

const BINARY_NONCE_SIZE = 16;
const AUTH_TAG_SIZE = 16;

/**
 * The synchronous helpers (`encryptAsJson`, `decryptFromJson`,
 * `encryptAsBinary`, `decryptBinary`) require Node's synchronous AES-GCM and
 * throw in browsers. The `*Async` variants work on both platforms: Node keeps
 * using `node:crypto`, browsers use Web Crypto (`globalThis.crypto.subtle`).
 */

export function runtimeCryptoKey(raw?: string): Uint8Array | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  return nativeBytes(utf8Encode(normalized.slice(0, 16)));
}

export function encryptAsJson(key: string | Uint8Array, plaintext: string): string {
  const runtimeKey = requireRuntimeKey(key);
  const nonce = randomBytes(BINARY_NONCE_SIZE);
  return sealedToJson(aesGcmEncryptSync(runtimeKey, nonce, utf8Encode(plaintext)), nonce);
}

export async function encryptAsJsonAsync(key: string | Uint8Array, plaintext: string): Promise<string> {
  const runtimeKey = requireRuntimeKey(key);
  const nonce = randomBytes(BINARY_NONCE_SIZE);
  return sealedToJson(await aesGcmEncrypt(runtimeKey, nonce, utf8Encode(plaintext)), nonce);
}

export function decryptFromJson(key: string | Uint8Array, ciphertextJson: string | Record<string, unknown>): string {
  const envelope = parseJsonEnvelope(key, ciphertextJson);
  return utf8Decode(aesGcmDecryptSync(envelope.runtimeKey, envelope.nonce, envelope.sealed));
}

export async function decryptFromJsonAsync(
  key: string | Uint8Array,
  ciphertextJson: string | Record<string, unknown>,
): Promise<string> {
  const envelope = parseJsonEnvelope(key, ciphertextJson);
  return utf8Decode(await aesGcmDecrypt(envelope.runtimeKey, envelope.nonce, envelope.sealed));
}

export function encryptAsBinary(key: string | Uint8Array, plaintext: Uint8Array): Uint8Array {
  const runtimeKey = requireRuntimeKey(key);
  const nonce = randomBytes(BINARY_NONCE_SIZE);
  return nativeBytes(concatBytes(nonce, aesGcmEncryptSync(runtimeKey, nonce, plaintext)));
}

export async function encryptAsBinaryAsync(key: string | Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const runtimeKey = requireRuntimeKey(key);
  const nonce = randomBytes(BINARY_NONCE_SIZE);
  return nativeBytes(concatBytes(nonce, await aesGcmEncrypt(runtimeKey, nonce, plaintext)));
}

export function decryptBinary(key: string | Uint8Array, payload: Uint8Array): Uint8Array {
  const envelope = parseBinaryEnvelope(key, payload);
  return nativeBytes(aesGcmDecryptSync(envelope.runtimeKey, envelope.nonce, envelope.sealed));
}

export async function decryptBinaryAsync(key: string | Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const envelope = parseBinaryEnvelope(key, payload);
  return nativeBytes(await aesGcmDecrypt(envelope.runtimeKey, envelope.nonce, envelope.sealed));
}

interface CipherEnvelope {
  runtimeKey: Uint8Array;
  nonce: Uint8Array;
  sealed: Uint8Array;
}

function requireRuntimeKey(key: string | Uint8Array): Uint8Array {
  const runtimeKey = typeof key === "string" ? runtimeCryptoKey(key) : key;
  if (!runtimeKey) {
    throw new Error("Missing crypto key");
  }
  return runtimeKey;
}

function sealedToJson(sealed: Uint8Array, nonce: Uint8Array): string {
  const ciphertext = sealed.subarray(0, sealed.length - AUTH_TAG_SIZE);
  const tag = sealed.subarray(sealed.length - AUTH_TAG_SIZE);
  return JSON.stringify({
    ciphertext: bytesToHex(ciphertext),
    tag: bytesToHex(tag),
    nonce: bytesToHex(nonce),
  });
}

function parseJsonEnvelope(key: string | Uint8Array, ciphertextJson: string | Record<string, unknown>): CipherEnvelope {
  const runtimeKey = requireRuntimeKey(key);
  const parsed = (typeof ciphertextJson === "string" ? JSON.parse(ciphertextJson) : ciphertextJson) as Record<string, unknown>;
  const decode = detectJsonEncoding(parsed.nonce) === "hex" ? hexToBytes : base64ToBytes;
  const nonce = decode(String(parsed.nonce));
  const tag = decode(String(parsed.tag));
  const ciphertext = decode(String(parsed.ciphertext));
  return { runtimeKey, nonce, sealed: concatBytes(ciphertext, tag) };
}

function parseBinaryEnvelope(key: string | Uint8Array, payload: Uint8Array): CipherEnvelope {
  const runtimeKey = requireRuntimeKey(key);
  if (payload.length <= BINARY_NONCE_SIZE + AUTH_TAG_SIZE) {
    throw new Error("Invalid encrypted binary payload");
  }
  return {
    runtimeKey,
    nonce: payload.subarray(0, BINARY_NONCE_SIZE),
    sealed: payload.subarray(BINARY_NONCE_SIZE),
  };
}

function detectJsonEncoding(value: unknown): "hex" | "base64" {
  const text = String(value ?? "");
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    const hexBytes = text.length / 2;
    if (hexBytes === BINARY_NONCE_SIZE || hexBytes === 12) {
      return "hex";
    }
  }
  return "base64";
}
