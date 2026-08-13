import { concatBytes, nativeBytes, utf8Decode, utf8Encode } from "./bytes.js";
import { inflateBytes } from "./platform/node.js";

export interface HiveWireMessage {
  msg_type: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  route?: unknown[];
  node?: unknown;
  target_site_id?: unknown;
  target_pubkey?: unknown;
  source_peer?: unknown;
}

const TYPE_TO_INT: Record<string, number> = {
  shake: 0,
  handshake: 0,
  bus: 1,
  shared_bus: 2,
  broadcast: 3,
  propagate: 4,
  escalate: 5,
  hello: 6,
  query: 7,
  cascade: 8,
  ping: 9,
  rendezvous: 10,
  "3rdparty": 11,
  bin: 12,
};

const INT_TO_TYPE: Record<number, string> = {
  0: "shake",
  1: "bus",
  2: "shared_bus",
  3: "broadcast",
  4: "propagate",
  5: "escalate",
  6: "hello",
  7: "query",
  8: "cascade",
  9: "ping",
  10: "rendezvous",
  11: "3rdparty",
  12: "bin",
};

export function encodeHiveBinaryFrame(message: HiveWireMessage): Uint8Array {
  const typeId = TYPE_TO_INT[message.msg_type] ?? 11;
  const metadata = utf8Encode(JSON.stringify(message.metadata ?? {}));
  if (metadata.length > 255) {
    throw new Error("HiveMind binary metadata cannot exceed 255 bytes.");
  }
  const payload = utf8Encode(JSON.stringify(message.payload ?? {}));
  return nativeBytes(concatBytes(
    Uint8Array.of(0x80 | ((typeId & 0x1f) << 1), metadata.length),
    metadata,
    payload,
  ));
}

export function decodeHiveBinaryFrame(payload: Uint8Array): HiveWireMessage {
  const reader = new BitReader(payload);
  reader.skipLeftPadding();
  const versioned = reader.readBit() === 1;
  if (versioned) {
    const version = reader.readUInt(8);
    if (version > 1) {
      throw new Error(`Unsupported HiveMind binary protocol version: ${version}`);
    }
  }
  const typeId = reader.readUInt(5);
  const compressed = reader.readBit() === 1;
  const metadataLength = reader.readUInt(8);
  const metadata = parseRecord(bytesToText(reader.readBytes(metadataLength), compressed));
  const rawPayload = reader.readRemainingBytes();
  const payloadText = bytesToText(rawPayload, compressed);
  return {
    msg_type: INT_TO_TYPE[typeId] ?? "3rdparty",
    payload: parseRecord(payloadText),
    metadata,
    route: [],
    node: null,
    target_site_id: null,
    target_pubkey: null,
    source_peer: null,
  };
}

function bytesToText(bytes: Uint8Array, compressed: boolean): string {
  return utf8Decode(compressed ? inflateBytes(bytes) : bytes);
}

function parseRecord(raw: string): Record<string, unknown> {
  const parsed = raw ? JSON.parse(raw) : {};
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { value: parsed };
}

class BitReader {
  private bitOffset = 0;

  constructor(private readonly payload: Uint8Array) {}

  skipLeftPadding(): void {
    while (this.bitOffset < this.payload.length * 8 && this.readBit() === 0) {
      // scan until the first set bit
    }
  }

  readBit(): number {
    if (this.bitOffset >= this.payload.length * 8) {
      throw new Error("Unexpected end of HiveMind binary frame.");
    }
    const byte = this.payload[Math.floor(this.bitOffset / 8)];
    const bit = (byte >> (7 - (this.bitOffset % 8))) & 1;
    this.bitOffset += 1;
    return bit;
  }

  readUInt(width: number): number {
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  readBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      out[index] = this.readUInt(8);
    }
    return out;
  }

  readRemainingBytes(): Uint8Array {
    const remainingBits = this.payload.length * 8 - this.bitOffset;
    return this.readBytes(Math.floor(remainingBits / 8));
  }
}
