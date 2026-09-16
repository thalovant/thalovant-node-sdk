/**
 * Binary frames, against the vectors every SDK shares.
 *
 * A hub answers `speak:synth` by rendering the utterance and sending the audio
 * back, so a client with no synthesiser of its own can still speak. The cases
 * are `contracts/conformance/binary-vectors.json` in the Python SDK, vendored
 * here, so "on par" is something a machine checks rather than something a
 * digest asserts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { BINARY_PAYLOAD_KINDS, binaryKindName } from "../src/events.js";
import { decodeHiveBinaryFrame } from "../src/wire.js";
import { record } from "./conformance-record.js";

const spec = JSON.parse(readFileSync(new URL("../../test/binary-vectors.json", import.meta.url), "utf8"));

/** Build the frame a hub sends: WIRE-1, BINARY, with the clip after the type. */
function frame(binType: number, metadata: Record<string, unknown>, clip: Uint8Array, compressed = false): Uint8Array {
  const metadataBytes = compressed
    ? new Uint8Array(deflateSync(Buffer.from(JSON.stringify(metadata), "utf8")))
    : new TextEncoder().encode(JSON.stringify(metadata));
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let index = width - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };
  bits.push(1);             // the marker bit the left padding is scanned to
  bits.push(1);             // versioned
  push(1, 8);               // version 1
  push(12, 5);              // BINARY
  bits.push(compressed ? 1 : 0);
  push(metadataBytes.length, 8);
  for (const byte of metadataBytes) push(byte, 8);
  push(binType, 4);
  for (const byte of clip) push(byte, 8);
  // Padding goes on the FRONT, which is what leaves the clip bit-misaligned.
  const pad = (8 - (bits.length % 8)) % 8;
  const all = [...new Array(pad).fill(0), ...bits];
  const out = new Uint8Array(all.length / 8);
  for (let index = 0; index < all.length; index += 1) {
    out[index >> 3] |= all[index] << (7 - (index % 8));
  }
  return out;
}

test("the payload numbers are the ones binary-vectors.json names", () => {
  const named: Record<string, string> = {};
  for (const [wire, name] of Object.entries(BINARY_PAYLOAD_KINDS)) named[wire] = name;
  assert.deepEqual(named, spec.payload_kinds);
});

test("a payload type nobody named arrives under its number", () => {
  // Only 0-15 can travel: the wire field is four bits. The naming has to hold
  // for every number all the same -- it is the last thing between a payload
  // type nobody has named yet and a frame that disappears.
  for (const [wire, name] of Object.entries(spec.unnamed_kind_names as Record<string, string>)) {
    assert.equal(binaryKindName(Number(wire)), name, wire);
  }
  assert.equal(binaryKindName(99), String(spec.unnamed_kind_format).replace("<wire number>", "99"));
});

test("every case in binary-vectors.json decodes as it says", () => {
  const clip = new Uint8Array([0xff, 0x00, 0x13, 0x37]);
  for (const row of spec.cases as Array<Record<string, any>>) {
    const message = decodeHiveBinaryFrame(frame(row.bin_type, row.metadata, clip));
    assert.equal(message.msg_type, "bin", row.name);
    const binary = message.binary!;
    // Recorded before the assert: what this SDK produced, not a restatement of
    // what the vector says it should have. `file_name` is the wire spelling the
    // reference records under; `fileName` is only how this language spells it.
    record("binary-vectors.json", row.name, {
      kind: binary.kind,
      utterance: binary.utterance,
      lang: binary.lang,
      file_name: binary.fileName,
    });
    assert.equal(binary.kind, row.expected.kind, row.name);
    assert.equal(binary.utterance, row.expected.utterance, row.name);
    assert.equal(binary.lang, row.expected.lang, row.name);
    assert.equal(binary.fileName, row.expected.file_name, row.name);
    // The clip itself, byte for byte, through the misalignment.
    assert.deepEqual([...binary.data], [...clip], row.name);
  }
});

test("every payload type the vectors name is actually delivered", () => {
  // Not the name map -- the decode. Checking the map alone is how the Python
  // SDK shipped four of six payload types reaching nobody.
  const clip = new Uint8Array([1, 2, 3]);
  for (const wire of Object.keys(spec.payload_kinds)) {
    const message = decodeHiveBinaryFrame(frame(Number(wire), {}, clip));
    assert.equal(message.binary?.kind, spec.payload_kinds[wire], wire);
    assert.deepEqual([...(message.binary?.data ?? [])], [...clip], wire);
  }
});

test("a compressed frame keeps its clip raw", () => {
  // Compression covers the metadata. The clip is never inflated.
  const clip = new Uint8Array([9, 9, 9]);
  const message = decodeHiveBinaryFrame(frame(6, { utterance: "Pfffft." }, clip, true));
  assert.equal(message.binary?.kind, "tts_audio");
  assert.equal(message.binary?.utterance, "Pfffft.");
  assert.deepEqual([...(message.binary?.data ?? [])], [...clip]);
});

const frames = JSON.parse(readFileSync(new URL("../../test/binary-frames.json", import.meta.url), "utf8"));

test("the frames the reference encoder produced decode here too", () => {
  // Not built by this test: `binary-frames.json` is hivemind-bus-client's own
  // `get_bitstring` output, so this is the wire a hub actually puts out rather
  // than a reading of the specification.
  for (const row of frames.cases as Array<Record<string, any>>) {
    const message = decodeHiveBinaryFrame(new Uint8Array(Buffer.from(row.frame, "base64")));
    assert.equal(message.msg_type, "bin", row.name);
    assert.equal(message.binary?.kind, row.expected_kind, row.name);
    assert.deepEqual(message.binary?.metadata, row.expected_metadata, row.name);
    assert.deepEqual(
      [...(message.binary?.data ?? [])],
      [...Buffer.from(row.expected_payload, "base64")],
      row.name,
    );
  }
});

test("a binarized bus frame is still text", () => {
  // Only BINARY carries bytes; every other type binarized on the wire is JSON
  // and has to keep decoding as it always did.
  const message = decodeHiveBinaryFrame(new Uint8Array(Buffer.from(frames.bus_frame, "base64")));
  assert.equal(message.msg_type, "bus");
  assert.equal(message.binary, undefined);
  assert.equal(message.payload.type, "speak");
});
