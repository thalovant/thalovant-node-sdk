/**
 * HiveMind protocol v3: the Noise handshake and its transport framing.
 *
 * A HiveMind-core 5.x hub accepts one transport key exchange and closes
 * anything else with WebSocket `1008`. There is no pre-shared `crypto_key` any
 * more and no cleartext path.
 *
 * The Noise state machine below is written out against the Noise Protocol
 * Framework spec (revision 34) because no dependency-light JavaScript library
 * implements the `XXpsk2` and `KKpsk0` patterns this protocol uses. Every
 * primitive underneath it — X25519, ChaCha20-Poly1305, AES-GCM, SHA-256, HMAC,
 * argon2id — comes from the audited `@noble` packages, which behave identically
 * in Node and in a browser bundle. What is hand-written is the sequencing, and
 * that is checked against reference vectors and against a real hub.
 */

import { argon2id } from "@noble/hashes/argon2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";

import { concatBytes, utf8Encode } from "./bytes.js";
import { ThalovantConnectionError } from "./errors.js";

/** HiveMind protocol version that switches the handshake to Noise. */
export const PROTOCOL_V3 = 3;

/** Registered handshake pattern for a peer whose static key is already pinned. */
export const NOISE_PATTERN_KK = "KKpsk0";
/** Registered handshake pattern for first contact, trust on first use. */
export const NOISE_PATTERN_XX = "XXpsk2";

/**
 * Registered cipher suites in *our* preference order. The selection walks this
 * list rather than the hub's, so ChaChaPoly wins whenever both peers have it
 * however the hub ordered its advertisement.
 */
export const NOISE_SUITES = ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"] as const;
export type NoiseSuite = (typeof NOISE_SUITES)[number];

/**
 * argon2id parameters for the password to pre-shared-key derivation. These are
 * part of the wire contract: a peer deriving with different parameters produces
 * a different key, and the handshake then fails as it would on a wrong password.
 */
const PSK_TIME_COST = 3;
const PSK_MEMORY_KIB = 64 * 1024;
const PSK_LANES = 1;
const PSK_LENGTH = 32;

/**
 * Transport frame markers. The first plaintext byte of every Noise transport
 * message says how to parse the rest and where it sits in a chunked message.
 */
const FRAME_JSON = 0x00;
const FRAME_BINARY = 0x01;
const FRAME_FIRST_JSON = 0x02;
const FRAME_FIRST_BINARY = 0x03;
const FRAME_MORE = 0x04;
const FRAME_LAST = 0x05;

/**
 * A Noise transport message caps at 65535 bytes. Chunking well below that
 * leaves room for the AEAD tag, the marker, and implementation overhead.
 */
export const NOISE_CHUNK_SIZE = 65_000;

/**
 * Bounded reassembly budget, so one peer cannot make us allocate without limit
 * from a single message.
 */
export const NOISE_MAX_REASSEMBLY = 32 * 1024 * 1024;

const HASH_LENGTH = 32;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;

/**
 * Stretch the shared site password into the 32-byte Noise pre-shared key,
 * salted with SHA-256 of the *hub's* node id.
 *
 * This costs 64 MiB and a few hundred milliseconds, and the result is fixed for
 * a `(password, nodeId)` pair, so a caller that reconnects should derive once
 * and keep it.
 */
export function derivePsk(password: string, nodeId: string): Uint8Array {
  return argon2id(utf8Encode(password), sha256(utf8Encode(nodeId)), {
    t: PSK_TIME_COST,
    m: PSK_MEMORY_KIB,
    p: PSK_LANES,
    dkLen: PSK_LENGTH,
  });
}

/** The full Noise protocol name for a pattern and suite selection. */
export function noiseProtocolName(pattern: string, suite: string): string {
  return `Noise_${pattern}_${suite}`;
}

/**
 * Pick the handshake pattern and suite from the hub's advertised lists.
 *
 * `KKpsk0` is chosen only when a static key for this hub is already pinned and
 * the hub offers it; otherwise `XXpsk2`. `undefined` means there is no mutual
 * option and the connection cannot proceed.
 */
export function selectNoiseOptions(
  hubPatterns: readonly string[],
  hubSuites: readonly string[],
  pinnedRemoteKey?: string,
): { pattern: string; suite: string } | undefined {
  const suite = NOISE_SUITES.find(candidate => hubSuites.includes(candidate));
  if (!suite) return undefined;
  if (pinnedRemoteKey && hubPatterns.includes(NOISE_PATTERN_KK)) {
    return { pattern: NOISE_PATTERN_KK, suite };
  }
  if (hubPatterns.includes(NOISE_PATTERN_XX)) {
    return { pattern: NOISE_PATTERN_XX, suite };
  }
  return undefined;
}

/**
 * Serialize a JSON value the way the reference implementation does: sorted
 * keys, no whitespace, and no ASCII escaping of non-ASCII characters.
 *
 * Both peers must produce identical prologue bytes. `JSON.stringify` already
 * escapes exactly what Python's `json.dumps(ensure_ascii=False)` escapes, so
 * strings are handed to it; only key order has to be imposed.
 *
 * One divergence has no fix on this platform: JavaScript has a single number
 * type, so a hub payload carrying a non-integer float would be re-rendered by
 * its own rules rather than Python's (`3.0` becomes `3`). Every field in the
 * HELLO and HANDSHAKE payloads is a string, a boolean, an array or an integer,
 * where the two agree, and a float appearing there would break the prologue
 * loudly on the first connection rather than silently.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * Prologue bytes: the hub's cleartext HELLO payload, its cleartext parameter
 * HANDSHAKE payload, and the selected protocol name, concatenated in that order
 * with no separators.
 *
 * This is the downgrade and tampering protection. If either peer computed the
 * negotiation differently the handshake aborts rather than quietly proceeding
 * on weaker terms.
 */
export function buildPrologue(
  helloPayload: Record<string, unknown>,
  handshakePayload: Record<string, unknown>,
  protocolName: string,
): Uint8Array {
  return concatBytes(
    utf8Encode(canonicalJson(helloPayload)),
    utf8Encode(canonicalJson(handshakePayload)),
    utf8Encode(protocolName),
  );
}

/** AEAD binding for one cipher suite. */
interface Aead {
  encrypt(key: Uint8Array, nonce: bigint, associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array;
  decrypt(key: Uint8Array, nonce: bigint, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

/**
 * Noise nonces are 96 bits: four zero bytes then the 64-bit counter.
 *
 * The byte order is per cipher, not per protocol: ChaChaPoly encodes the
 * counter little-endian and AESGCM big-endian (Noise spec revision 34, §12).
 * They agree only at counter zero, so getting this wrong survives a handshake
 * and then fails on the second transport message against a conformant peer.
 */
export function noiseNonce(counter: bigint, littleEndian: boolean): Uint8Array {
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setBigUint64(4, counter, littleEndian);
  return nonce;
}

function aeadFor(suite: string): Aead {
  switch (suite) {
    case "25519_ChaChaPoly_SHA256":
      return {
        encrypt: (key, nonce, ad, plaintext) =>
          chacha20poly1305(key, noiseNonce(nonce, true), ad).encrypt(plaintext),
        decrypt: (key, nonce, ad, ciphertext) =>
          chacha20poly1305(key, noiseNonce(nonce, true), ad).decrypt(ciphertext),
      };
    case "25519_AESGCM_SHA256":
      return {
        encrypt: (key, nonce, ad, plaintext) => gcm(key, noiseNonce(nonce, false), ad).encrypt(plaintext),
        decrypt: (key, nonce, ad, ciphertext) => gcm(key, noiseNonce(nonce, false), ad).decrypt(ciphertext),
      };
    default:
      throw new ThalovantConnectionError(`Unsupported Noise cipher suite ${suite}.`);
  }
}

/**
 * The transport AEAD for a suite, exported so the tests can check it against
 * reference ciphertexts rather than only against itself.
 */
export function transportAead(suite: string): Aead {
  return aeadFor(suite);
}

export type { Aead };

/** Noise HKDF: two or three 32-byte outputs chained from one HMAC key. */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const first = hmac(sha256, tempKey, Uint8Array.of(0x01));
  const second = hmac(sha256, tempKey, concatBytes(first, Uint8Array.of(0x02)));
  if (outputs === 2) return [first, second];
  return [first, second, hmac(sha256, tempKey, concatBytes(second, Uint8Array.of(0x03)))];
}

/**
 * One direction of a Noise session: a key and a strictly sequential nonce
 * counter. The counter is what gives replay and reordering resistance, so it
 * must never be reset or skipped.
 */
class CipherState {
  private counter = 0n;

  constructor(
    private readonly aead: Aead,
    private key?: Uint8Array,
  ) {}

  hasKey(): boolean {
    return this.key !== undefined;
  }

  encryptWithAd(associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    const sealed = this.aead.encrypt(this.key, this.counter, associatedData, plaintext);
    this.counter += 1n;
    return sealed;
  }

  decryptWithAd(associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    const plaintext = this.aead.decrypt(this.key, this.counter, associatedData, ciphertext);
    this.counter += 1n;
    return plaintext;
  }
}

/** The Noise `SymmetricState`: the chaining key and the running transcript hash. */
class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  cipher: CipherState;

  constructor(
    private readonly aead: Aead,
    protocolName: string,
  ) {
    const name = utf8Encode(protocolName);
    if (name.length <= HASH_LENGTH) {
      const padded = new Uint8Array(HASH_LENGTH);
      padded.set(name);
      this.hash = padded;
    } else {
      this.hash = sha256(name);
    }
    this.chainingKey = this.hash;
    this.cipher = new CipherState(aead);
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concatBytes(this.hash, data));
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, tempKey] = hkdf(this.chainingKey, inputKeyMaterial, 2);
    this.chainingKey = chainingKey;
    this.cipher = new CipherState(this.aead, tempKey.slice(0, KEY_LENGTH));
  }

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, tempHash, tempKey] = hkdf(this.chainingKey, inputKeyMaterial, 3);
    this.chainingKey = chainingKey;
    this.mixHash(tempHash);
    this.cipher = new CipherState(this.aead, tempKey.slice(0, KEY_LENGTH));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = hkdf(this.chainingKey, new Uint8Array(0), 2);
    return [
      new CipherState(this.aead, first.slice(0, KEY_LENGTH)),
      new CipherState(this.aead, second.slice(0, KEY_LENGTH)),
    ];
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

/**
 * The message patterns, with the psk modifier already applied.
 *
 * `psk0` places the psk token at the start of message 1; `pskN` for N above
 * zero places it at the end of message N. `KKpsk0` also has pre-messages: both
 * static public keys are known before the handshake starts and are mixed into
 * the transcript in initiator-then-responder order.
 */
const PATTERNS: Record<string, { preMessages: { initiator: Token[]; responder: Token[] }; messages: Token[][] }> = {
  [NOISE_PATTERN_XX]: {
    preMessages: { initiator: [], responder: [] },
    messages: [["e"], ["e", "ee", "s", "es", "psk"], ["s", "se"]],
  },
  [NOISE_PATTERN_KK]: {
    preMessages: { initiator: ["s"], responder: ["s"] },
    messages: [["psk", "e", "es", "ss"], ["e", "ee", "se"]],
  },
};

interface Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/** Derive the public half of a stored X25519 private key. */
export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/**
 * One side of a v3 handshake.
 *
 * The SDK only ever initiates, but the responder side is implemented too so a
 * test can stand up a genuine peer rather than a stub that agrees with whatever
 * the client sends.
 */
export class NoiseHandshake {
  readonly pattern: string;
  private readonly symmetric: SymmetricState;
  private readonly messages: Token[][];
  private readonly staticKey: Keypair;
  private ephemeral?: Keypair;
  private remoteStatic?: Uint8Array;
  private remoteEphemeral?: Uint8Array;
  private index = 0;
  private transport?: [CipherState, CipherState];

  /**
   * @param staticPrivateKey this side's persistent X25519 private key. On the
   *   client it has to persist: a hub pins it on first contact, so regenerating
   *   it makes every connection look like a new peer.
   * @param pinnedRemoteKey the peer's static public key, required for `KKpsk0`
   *   and ignored otherwise.
   * @param initiator false to run the responder side. The SDK always initiates.
   */
  constructor(
    pattern: string,
    suite: string,
    psk: Uint8Array,
    prologue: Uint8Array,
    staticPrivateKey: Uint8Array,
    pinnedRemoteKey?: Uint8Array,
    initiator = true,
  ) {
    const shape = PATTERNS[pattern];
    if (!shape) {
      throw new ThalovantConnectionError(`Unsupported Noise pattern ${pattern}.`);
    }
    if (psk.length !== KEY_LENGTH) {
      throw new ThalovantConnectionError("The Noise pre-shared key must be exactly 32 bytes.");
    }
    this.pattern = pattern;
    this.initiator = initiator;
    this.psk = psk;
    this.messages = shape.messages;
    this.staticKey = { privateKey: staticPrivateKey, publicKey: x25519PublicKey(staticPrivateKey) };

    if (pattern === NOISE_PATTERN_KK) {
      if (!pinnedRemoteKey || pinnedRemoteKey.length !== KEY_LENGTH) {
        throw new ThalovantConnectionError("KKpsk0 needs a pinned 32-byte hub static key.");
      }
      this.remoteStatic = pinnedRemoteKey;
    }

    this.symmetric = new SymmetricState(aeadFor(suite), noiseProtocolName(pattern, suite));
    this.symmetric.mixHash(prologue);

    // Pre-message public keys enter the transcript in initiator-then-responder
    // order, whichever side we are.
    const local = this.staticKey.publicKey;
    const remote = this.remoteStatic;
    const ordered: Array<[Token[], Uint8Array | undefined]> = initiator
      ? [[shape.preMessages.initiator, local], [shape.preMessages.responder, remote]]
      : [[shape.preMessages.initiator, remote], [shape.preMessages.responder, local]];
    for (const [tokens, key] of ordered) {
      for (const token of tokens) {
        if (token === "s" && key) this.symmetric.mixHash(key);
      }
    }
  }

  private readonly psk: Uint8Array;
  private readonly initiator: boolean;

  get isFinished(): boolean {
    return this.transport !== undefined;
  }

  /** The hub's static public key, hex encoded, once it is known. */
  get remoteStaticKey(): string | undefined {
    if (!this.remoteStatic) return undefined;
    return Array.from(this.remoteStatic, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  /** Produce the next outgoing handshake message. */
  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const tokens = this.messages[this.index];
    if (!tokens) {
      throw new ThalovantConnectionError("The Noise handshake has no message left to write.");
    }
    this.index += 1;

    let buffer: Uint8Array = new Uint8Array(0);
    for (const token of tokens) {
      switch (token) {
        case "e": {
          const privateKey = x25519.utils.randomSecretKey();
          this.ephemeral = { privateKey, publicKey: x25519PublicKey(privateKey) };
          buffer = concatBytes(buffer, this.ephemeral.publicKey);
          this.symmetric.mixHash(this.ephemeral.publicKey);
          // In a psk handshake the ephemeral public key is also mixed into the
          // chaining key, so the psk cannot be attacked offline.
          this.symmetric.mixKey(this.ephemeral.publicKey);
          break;
        }
        case "s":
          buffer = concatBytes(buffer, this.symmetric.encryptAndHash(this.staticKey.publicKey));
          break;
        case "psk":
          this.symmetric.mixKeyAndHash(this.psk);
          break;
        default:
          this.symmetric.mixKey(this.dh(token));
      }
    }

    buffer = concatBytes(buffer, this.symmetric.encryptAndHash(payload));
    this.finishIfDone();
    return buffer;
  }

  /**
   * Consume an incoming handshake message and return its payload.
   *
   * A failure here is authentication failing: a wrong password, a tampered
   * negotiation, or a static key contradicting the pinned one. It is fatal, and
   * the connection must be rejected rather than retried on weaker terms.
   */
  readMessage(message: Uint8Array): Uint8Array {
    const tokens = this.messages[this.index];
    if (!tokens) {
      throw new ThalovantConnectionError("The Noise handshake has no message left to read.");
    }
    this.index += 1;

    let rest = message;
    const take = (length: number): Uint8Array => {
      if (rest.length < length) {
        throw new ThalovantConnectionError("Truncated Noise handshake message.");
      }
      const head = rest.subarray(0, length);
      rest = rest.subarray(length);
      return head;
    };

    try {
      for (const token of tokens) {
        switch (token) {
          case "e": {
            this.remoteEphemeral = take(KEY_LENGTH).slice();
            this.symmetric.mixHash(this.remoteEphemeral);
            this.symmetric.mixKey(this.remoteEphemeral);
            break;
          }
          case "s": {
            const length = this.symmetric.cipher.hasKey() ? KEY_LENGTH + TAG_LENGTH : KEY_LENGTH;
            const learned = this.symmetric.decryptAndHash(take(length).slice());
            if (this.remoteStatic && !equalBytes(this.remoteStatic, learned)) {
              throw new ThalovantConnectionError(
                "The hub presented a static key that contradicts the pinned one.",
              );
            }
            this.remoteStatic = learned;
            break;
          }
          case "psk":
            this.symmetric.mixKeyAndHash(this.psk);
            break;
          default:
            this.symmetric.mixKey(this.dh(token));
        }
      }
      const payload = this.symmetric.decryptAndHash(rest.slice());
      this.finishIfDone();
      return payload;
    } catch (error) {
      if (error instanceof ThalovantConnectionError) throw error;
      throw new ThalovantConnectionError(
        `Noise handshake authentication failed (wrong password or tampered negotiation): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Take the completed session. Throws while the handshake is still running. */
  intoSession(): NoiseSession {
    if (!this.transport) {
      throw new ThalovantConnectionError("The Noise handshake is not finished.");
    }
    // Split() returns the initiator's send state first. The responder uses the
    // same pair the other way round.
    const [first, second] = this.transport;
    const [send, receive] = this.initiator ? [first, second] : [second, first];
    return new NoiseSession(send, receive, this.remoteStaticKey);
  }

  private finishIfDone(): void {
    if (this.index >= this.messages.length && !this.transport) {
      this.transport = this.symmetric.split();
    }
  }

  /**
   * The Diffie-Hellman a token names, from this side.
   *
   * `es` always means "initiator ephemeral with responder static" and `se` the
   * reverse, so which local key each names flips with the role.
   */
  private dh(token: Token): Uint8Array {
    const initiatorEphemeralWithResponderStatic: [Uint8Array | undefined, Uint8Array | undefined] = this.initiator
      ? [this.ephemeral?.privateKey, this.remoteStatic]
      : [this.staticKey.privateKey, this.remoteEphemeral];
    const initiatorStaticWithResponderEphemeral: [Uint8Array | undefined, Uint8Array | undefined] = this.initiator
      ? [this.staticKey.privateKey, this.remoteEphemeral]
      : [this.ephemeral?.privateKey, this.remoteStatic];
    const pairs: Partial<Record<Token, [Uint8Array | undefined, Uint8Array | undefined]>> = {
      ee: [this.ephemeral?.privateKey, this.remoteEphemeral],
      es: initiatorEphemeralWithResponderStatic,
      se: initiatorStaticWithResponderEphemeral,
      ss: [this.staticKey.privateKey, this.remoteStatic],
    };
    const pair = pairs[token];
    if (!pair?.[0] || !pair[1]) {
      throw new ThalovantConnectionError(`The Noise handshake reached '${token}' without both keys.`);
    }
    return x25519.getSharedSecret(pair[0], pair[1]);
  }
}

/** One decrypted incoming message, or a marker that more chunks are due. */
export type NoiseFrame =
  | { complete: true; payload: Uint8Array; isJson: boolean }
  | { complete: false };

/**
 * A completed v3 session: the transport cipher states plus the HiveMind frame
 * markers that separate JSON from binary after decryption.
 */
export class NoiseSession {
  private reassembly?: { buffer: Uint8Array; isJson: boolean };

  constructor(
    private readonly sendState: CipherState,
    private readonly receiveState: CipherState,
    readonly remoteStaticKey?: string,
  ) {}

  /**
   * Encrypt one message into the Noise transport messages that carry it,
   * chunking when it does not fit in one.
   *
   * The chunks of one message must reach the wire contiguously and in order:
   * the cipher state nonce counter is strictly sequential, so interleaving two
   * messages would break decryption at the hub. The caller sends the returned
   * array without awaiting anything between its entries.
   */
  encryptMessage(payload: Uint8Array, isJson: boolean): Uint8Array[] {
    const single = isJson ? FRAME_JSON : FRAME_BINARY;
    const first = isJson ? FRAME_FIRST_JSON : FRAME_FIRST_BINARY;

    if (payload.length <= NOISE_CHUNK_SIZE) {
      return [this.sealed(single, payload)];
    }

    const lastOffset = payload.length - NOISE_CHUNK_SIZE;
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < payload.length; offset += NOISE_CHUNK_SIZE) {
      const marker = offset === 0 ? first : offset >= lastOffset ? FRAME_LAST : FRAME_MORE;
      frames.push(this.sealed(marker, payload.subarray(offset, offset + NOISE_CHUNK_SIZE)));
    }
    return frames;
  }

  /**
   * Decrypt one incoming Noise transport message.
   *
   * Every error here is fatal for the session. A message that fails to decrypt
   * at the current counter means tampering, replay or reordering, and so does a
   * malformed chunk sequence; the connection must be dropped rather than the
   * frame skipped.
   */
  decryptFrame(data: Uint8Array): NoiseFrame {
    let plaintext: Uint8Array;
    try {
      plaintext = this.receiveState.decryptWithAd(new Uint8Array(0), data);
    } catch (error) {
      throw new ThalovantConnectionError(
        `Noise transport message rejected (tampered, replayed or out-of-order): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (plaintext.length === 0) {
      throw new ThalovantConnectionError("Empty Noise transport message.");
    }

    const marker = plaintext[0];
    const body = plaintext.subarray(1);

    switch (marker) {
      case FRAME_JSON:
      case FRAME_BINARY: {
        const buffered = this.reassembly?.buffer.length;
        this.reassembly = undefined;
        if (buffered !== undefined) {
          throw new ThalovantConnectionError(
            `A complete frame arrived while ${buffered} bytes of a chunked message were still buffered.`,
          );
        }
        return { complete: true, payload: body.slice(), isJson: marker === FRAME_JSON };
      }
      case FRAME_FIRST_JSON:
      case FRAME_FIRST_BINARY: {
        const buffered = this.reassembly?.buffer.length;
        this.reassembly = undefined;
        if (buffered !== undefined) {
          throw new ThalovantConnectionError(
            `A new chunked message started while ${buffered} bytes of a previous one were still buffered.`,
          );
        }
        this.reassembly = { buffer: body.slice(), isJson: marker === FRAME_FIRST_JSON };
        this.guardReassemblyCap();
        return { complete: false };
      }
      case FRAME_MORE: {
        if (!this.reassembly) {
          throw new ThalovantConnectionError("A middle chunk arrived with no chunked message open.");
        }
        this.reassembly.buffer = concatBytes(this.reassembly.buffer, body);
        this.guardReassemblyCap();
        return { complete: false };
      }
      case FRAME_LAST: {
        if (!this.reassembly) {
          throw new ThalovantConnectionError("A final chunk arrived with no chunked message open.");
        }
        this.reassembly.buffer = concatBytes(this.reassembly.buffer, body);
        this.guardReassemblyCap();
        const finished = this.reassembly;
        this.reassembly = undefined;
        return { complete: true, payload: finished.buffer, isJson: finished.isJson };
      }
      default:
        throw new ThalovantConnectionError(
          `Unknown v3 frame marker 0x${marker.toString(16).padStart(2, "0")}.`,
        );
    }
  }

  private sealed(marker: number, body: Uint8Array): Uint8Array {
    return this.sendState.encryptWithAd(new Uint8Array(0), concatBytes(Uint8Array.of(marker), body));
  }

  /** Drop the whole buffer once it passes the cap, so a peer cannot grow it without limit. */
  private guardReassemblyCap(): void {
    const buffered = this.reassembly?.buffer.length ?? 0;
    if (buffered <= NOISE_MAX_REASSEMBLY) return;
    this.reassembly = undefined;
    throw new ThalovantConnectionError(
      `Chunked reassembly exceeded the ${NOISE_MAX_REASSEMBLY} byte cap (${buffered} buffered); dropping the message.`,
    );
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
