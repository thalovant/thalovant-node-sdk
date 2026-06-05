import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", runtimeKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    ciphertext: ciphertext.toString("hex"),
    tag: tag.toString("hex"),
    nonce: nonce.toString("hex"),
  });
}

export function decryptFromJson(key: string | Buffer, ciphertextJson: string | Record<string, unknown>): string {
  const runtimeKey = Buffer.isBuffer(key) ? key : runtimeCryptoKey(key);
  if (!runtimeKey) {
    throw new Error("Missing crypto key");
  }
  const parsed = typeof ciphertextJson === "string" ? JSON.parse(ciphertextJson) : ciphertextJson;
  const nonce = Buffer.from(String(parsed.nonce), "hex");
  const tag = Buffer.from(String(parsed.tag), "hex");
  const ciphertext = Buffer.from(String(parsed.ciphertext), "hex");
  const decipher = createDecipheriv("aes-128-gcm", runtimeKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
