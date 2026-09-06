/**
 * A minimal HiveMind-core 5.x hub for the transport tests.
 *
 * It runs the responder side of the real v3 Noise handshake rather than
 * agreeing with whatever the client sends, so a test that connects proves the
 * client can complete a handshake and encrypt under the session keys. Protocol
 * correctness against the reference implementation is pinned separately, by the
 * vectors in `noise.test.ts` and by the live interop test.
 */

import { randomBytes } from "node:crypto";

import { utf8Decode, utf8Encode } from "../src/bytes.js";
import {
  buildPrologue,
  canonicalJson,
  derivePsk,
  NoiseHandshake,
  NoiseSession,
  noiseProtocolName,
  x25519PublicKey,
} from "../src/noise.js";

export const V3_HUB_NODE_ID = "test-hub-node-id";

export interface V3HubPeer {
  /** Frames the client sent after the session came up, decrypted. */
  readonly received: string[];
  readonly staticPublicKey: Uint8Array;
}

type Send = (data: string | Uint8Array, binary: boolean) => void;

/**
 * Drive the hub side of one connection.
 *
 * `send` puts a frame on the wire; feed every client frame to the returned
 * `onMessage`. The caller supplies the transport, so this works for both a real
 * `ws` server and the browser test's stub socket.
 */
export function createV3HubPeer(
  password: string,
  send: Send,
  options: { staticPrivateKey?: Uint8Array; nodeId?: string } = {},
): V3HubPeer & { onMessage(data: string | Uint8Array): void; start(): void } {
  const nodeId = options.nodeId ?? V3_HUB_NODE_ID;
  const staticPrivateKey = options.staticPrivateKey ?? Uint8Array.from(randomBytes(32));
  const received: string[] = [];

  const helloPayload = { node_id: nodeId, pubkey: "test-hub-pubkey" };
  const handshakePayload = {
    max_protocol_version: 3,
    binarize: false,
    encodings: [],
    noise: { patterns: ["XXpsk2"], suites: ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"] },
  };

  let handshake: NoiseHandshake | undefined;
  let session: NoiseSession | undefined;

  return {
    received,
    staticPublicKey: x25519PublicKey(staticPrivateKey),

    start(): void {
      send(JSON.stringify({ msg_type: "hello", payload: helloPayload, metadata: {} }), false);
      send(JSON.stringify({ msg_type: "shake", payload: handshakePayload, metadata: {} }), false);
    },

    onMessage(data: string | Uint8Array): void {
      if (session) {
        const bytes = typeof data === "string" ? utf8Encode(data) : data;
        const frame = session.decryptFrame(bytes);
        if (frame.complete && frame.isJson) {
          received.push(utf8Decode(frame.payload));
        }
        return;
      }

      const message = JSON.parse(typeof data === "string" ? data : utf8Decode(data)) as {
        msg_type?: string;
        payload?: { noise?: { pattern?: string; suite?: string; msg?: string } };
      };
      const noise = message.payload?.noise;
      if (message.msg_type !== "shake" || !noise?.msg) return;

      if (!handshake) {
        const suite = noise.suite ?? "25519_ChaChaPoly_SHA256";
        const pattern = noise.pattern ?? "XXpsk2";
        handshake = new NoiseHandshake(
          pattern,
          suite,
          derivePsk(password, nodeId),
          buildPrologue(helloPayload, handshakePayload, noiseProtocolName(pattern, suite)),
          staticPrivateKey,
          undefined,
          false,
        );
        handshake.readMessage(hexBytes(noise.msg));
        const reply = handshake.writeMessage(utf8Encode(canonicalJson({ encoding: "JSON-HEX" })));
        send(JSON.stringify({ msg_type: "shake", payload: { noise: { msg: hexString(reply) } }, metadata: {} }), false);
        return;
      }

      handshake.readMessage(hexBytes(noise.msg));
      session = handshake.intoSession();
    },
  };
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function hexString(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
