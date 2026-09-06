/**
 * Browser platform bindings. Bundlers substitute this module for
 * `./node.js` through the `browser` map in package.json. It must not import
 * any `node:` builtin, `ws`, `mqtt`, or `yaml` — only Web platform APIs
 * (`globalThis.crypto`, the global `WebSocket`, `TextEncoder`).
 *
 * Every export mirrors `./node.js`. Capabilities that have no Web equivalent
 * (identity files, YAML configs, synchronous AES-GCM, zlib inflate) throw a
 * descriptive error instead of breaking the bundle.
 */
import { ThalovantConnectionError, ThalovantIdentityError } from "../errors.js";
import type { PlatformWebSocket } from "./types.js";

const AUTH_TAG_BITS = 128;

const SYNC_CRYPTO_ERROR =
  "Synchronous AES-GCM helpers are not available in browsers. Use the async variants " +
  "(encryptAsJsonAsync, decryptFromJsonAsync, encryptAsBinaryAsync, decryptBinaryAsync) instead.";

interface BrowserWebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: never) => void): void;
}

type BrowserWebSocketConstructor = new (url: string) => BrowserWebSocketLike;

export const isBrowserPlatform = true;

function requireCrypto(): Crypto {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObj) {
    throw new Error("The Web Crypto API (globalThis.crypto) is not available in this environment.");
  }
  return cryptoObj;
}

export function randomUUID(): string {
  const cryptoObj = requireCrypto();
  if (typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  requireCrypto().getRandomValues(out);
  return out;
}

export function aesGcmEncryptSync(_key: Uint8Array, _nonce: Uint8Array, _plaintext: Uint8Array): Uint8Array {
  throw new Error(SYNC_CRYPTO_ERROR);
}

export function aesGcmDecryptSync(_key: Uint8Array, _nonce: Uint8Array, _sealed: Uint8Array): Uint8Array {
  throw new Error(SYNC_CRYPTO_ERROR);
}

/** AES-128-GCM seal via Web Crypto; returns `ciphertext || tag` (tag is 16 bytes). */
export async function aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const subtle = requireCrypto().subtle;
  const cryptoKey = await subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt"]);
  const sealed = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, tagLength: AUTH_TAG_BITS },
    cryptoKey,
    plaintext as BufferSource,
  );
  return new Uint8Array(sealed);
}

/** AES-128-GCM open via Web Crypto; expects `ciphertext || tag` (tag is 16 bytes). */
export async function aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  const subtle = requireCrypto().subtle;
  const cryptoKey = await subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, tagLength: AUTH_TAG_BITS },
    cryptoKey,
    sealed as BufferSource,
  );
  return new Uint8Array(plaintext);
}

export function inflateBytes(_bytes: Uint8Array): Uint8Array {
  throw new Error("Compressed HiveMind binary frames are not supported in browsers.");
}

export function createPlatformWebSocket(url: string): PlatformWebSocket {
  return new BrowserPlatformWebSocket(url);
}

class BrowserPlatformWebSocket implements PlatformWebSocket {
  private readonly socket: BrowserWebSocketLike;

  constructor(readonly url: string) {
    const WebSocketCtor = (globalThis as { WebSocket?: BrowserWebSocketConstructor }).WebSocket;
    if (!WebSocketCtor) {
      throw new ThalovantConnectionError("The global WebSocket constructor is not available in this environment.");
    }
    this.socket = new WebSocketCtor(url);
    this.socket.binaryType = "arraybuffer";
  }

  get isOpen(): boolean {
    return this.socket.readyState === 1;
  }

  onOpen(handler: () => void): void {
    this.socket.addEventListener("open", () => handler());
  }

  onMessage(handler: (data: string | Uint8Array) => void): void {
    this.socket.addEventListener("message", (event: { data?: unknown }) => {
      const data = event?.data;
      if (typeof data === "string") {
        handler(data);
      } else if (data instanceof ArrayBuffer) {
        handler(new Uint8Array(data));
      } else if (data instanceof Uint8Array) {
        handler(data);
      }
    });
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.socket.addEventListener("close", (event: { code?: unknown; reason?: unknown }) => {
      handler(Number(event?.code ?? 1006), String(event?.reason ?? ""));
    });
  }

  onError(handler: (error: Error) => void): void {
    this.socket.addEventListener("error", () => handler(new Error("WebSocket error")));
  }

  async send(data: string | Uint8Array): Promise<void> {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  terminate(): void {
    this.socket.close();
  }
}

export async function readSecretFile(path: string, description: string): Promise<string> {
  throw new ThalovantIdentityError(
    `Reading the ${description} from disk is not supported in browsers: ${path}. ` +
    "Construct ThalovantIdentity with an in-memory identity object instead.",
  );
}

export function parseYamlText(_text: string): unknown {
  throw new ThalovantIdentityError("YAML config files are not supported in browsers.");
}

export function defaultConfigPath(_filename: string): string {
  throw new ThalovantIdentityError("The Thalovant config file path is not available in browsers.");
}

export function envVar(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/**
 * Best-effort attempt to open a URL in a new browser tab. Resolves `false`
 * (never throws) when blocked, for example by a popup blocker, so callers can
 * always fall back to showing the URL.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const opener = (globalThis as { open?: (url: string, target?: string) => unknown }).open;
    if (typeof opener !== "function") {
      return false;
    }
    return opener(url, "_blank") != null;
  } catch {
    return false;
  }
}

export const NOISE_KEY_FILENAME = "noise_key";
export const NOISE_PINS_FILENAME = "noise_pins.json";

/**
 * Browsers have no config directory, so the Noise state is namespaced under a
 * single `localStorage` prefix instead.
 */
export function noiseStateDir(): string {
  return "thalovant:noise";
}

const memoryNoiseState = new Map<string, string>();

function localStore(): Storage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    // Touch it: a browser with site data blocked exposes the object but throws
    // on access, and a private window can throw on write.
    storage?.getItem("thalovant:noise:probe");
    return storage;
  } catch {
    return undefined;
  }
}

/**
 * Read persistent Noise state.
 *
 * The static key is kept in `localStorage` because a hub pins it on first
 * contact: a client that presents a new key every page load is refused, and an
 * operator has to clear the pin by hand. Where `localStorage` is unavailable
 * (a private window, or site data blocked) this falls back to memory, which
 * means the key lasts one page and a hub that has pinned this client will
 * refuse it. That is a browser storage limit, not something the SDK can work
 * around.
 */
export async function readNoiseState(directory: string, filename: string): Promise<string | undefined> {
  const key = `${directory}:${filename}`;
  return localStore()?.getItem(key) ?? memoryNoiseState.get(key) ?? undefined;
}

export async function writeNoiseState(directory: string, filename: string, contents: string): Promise<void> {
  const key = `${directory}:${filename}`;
  memoryNoiseState.set(key, contents);
  try {
    localStore()?.setItem(key, contents);
  } catch {
    // Quota or a private window; the in-memory copy above still serves this page.
  }
}
