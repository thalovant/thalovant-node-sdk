import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const BINARY_NONCE_SIZE = 16;
const AUTH_TAG_SIZE = 16;
const JSON_ENCODING = "hex";

export function runtimeCryptoKey(raw?: string): Buffer | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  return Buffer.from(normalized.slice(0, 16), "utf8");
}

export function encryptAsJson(key: string | Buffer, plaintext: string): string {
  const runtimeKey = Buffer.isBuffer(key) ? key : runtimeCryptoKey(key);
  if (!runtimeKey) {
    throw new Error("Missing crypto key");
  }
  const nonce = randomBytes(BINARY_NONCE_SIZE);
  const cipher = createCipheriv("aes-128-gcm", runtimeKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    ciphertext: ciphertext.toString(JSON_ENCODING),
    tag: tag.toString(JSON_ENCODING),
    nonce: nonce.toString(JSON_ENCODING),
  });
}

export function decryptFromJson(key: string | Buffer, ciphertextJson: string | Record<string, unknown>): string {
  const runtimeKey = Buffer.isBuffer(key) ? key : runtimeCryptoKey(key);
  if (!runtimeKey) {
    throw new Error("Missing crypto key");
  }
  const parsed = typeof ciphertextJson === "string" ? JSON.parse(ciphertextJson) : ciphertextJson;
  const encoding = detectJsonEncoding(parsed.nonce);
  const nonce = Buffer.from(String(parsed.nonce), encoding);
  const tag = Buffer.from(String(parsed.tag), encoding);
  const ciphertext = Buffer.from(String(parsed.ciphertext), encoding);
  const decipher = createDecipheriv("aes-128-gcm", runtimeKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptAsBinary(key: string | Buffer, plaintext: Buffer | Uint8Array): Buffer {
  const runtimeKey = Buffer.isBuffer(key) ? key : runtimeCryptoKey(key);
  if (!runtimeKey) {
    throw new Error("Missing crypto key");
  }
  const nonce = randomBytes(BINARY_NONCE_SIZE);
  const cipher = createCipheriv("aes-128-gcm", runtimeKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

export function decryptBinary(key: string | Buffer, payload: Buffer | Uint8Array): Buffer {
  const runtimeKey = Buffer.isBuffer(key) ? key : runtimeCryptoKey(key);
  if (!runtimeKey) {
    throw new Error("Missing crypto key");
  }
  const raw = Buffer.from(payload);
  if (raw.length <= BINARY_NONCE_SIZE + AUTH_TAG_SIZE) {
    throw new Error("Invalid encrypted binary payload");
  }
  const nonce = raw.subarray(0, BINARY_NONCE_SIZE);
  const tag = raw.subarray(raw.length - AUTH_TAG_SIZE);
  const ciphertext = raw.subarray(BINARY_NONCE_SIZE, raw.length - AUTH_TAG_SIZE);
  const decipher = createDecipheriv("aes-128-gcm", runtimeKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function detectJsonEncoding(value: unknown): BufferEncoding {
  const text = String(value ?? "");
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
    const hexBytes = text.length / 2;
    if (hexBytes === BINARY_NONCE_SIZE || hexBytes === 12) {
      return "hex";
    }
  }
  return "base64";
}
