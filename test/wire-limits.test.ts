/**
 * A compressed part of a WIRE-1 frame inflates to at most 32 MiB, and a
 * truncated stream is refused rather than read as far as it goes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { decodeHiveBinaryFrame, MAX_INFLATED_BYTES } from "../src/wire.js";

/** A compressed BUS frame (type 1): metadata and payload each deflated. */
function compressedFrame(payload: Uint8Array): Uint8Array {
  const metadata = deflateSync(Buffer.from("{}"));
  return Uint8Array.from(Buffer.concat([Buffer.of(0x80 | (1 << 1) | 1, metadata.length), metadata, payload]));
}

test("a compressed frame within the limit decodes", () => {
  const message = decodeHiveBinaryFrame(compressedFrame(deflateSync(Buffer.from('{"type":"speak","data":{}}'))));
  assert.equal(message.msg_type, "bus");
  assert.deepEqual(message.payload, { type: "speak", data: {} });
});

test("a frame that inflates past 32 MiB is refused", () => {
  assert.equal(MAX_INFLATED_BYTES, 32 * 1024 * 1024);
  // About 40 KB on the wire, 40 MiB once inflated.
  const bomb = deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
  assert.throws(() => decodeHiveBinaryFrame(compressedFrame(bomb)), /inflates past the size limit/);
});

test("a truncated compressed stream is refused", () => {
  const whole = deflateSync(Buffer.from(JSON.stringify({ type: "speak", data: { utterance: "x".repeat(4096) } })));
  assert.throws(
    () => decodeHiveBinaryFrame(compressedFrame(whole.subarray(0, whole.length - 8))),
    /compressed stream that does not inflate/,
  );
});
