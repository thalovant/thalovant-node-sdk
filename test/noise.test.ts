/**
 * The v3 Noise contract.
 *
 * The vectors below come from the reference implementation
 * (poorman-handshake 2.0.0a3 / hivemind-bus-client 1.1.1a1). They are what
 * makes these tests worth having: a peer whose pre-shared key, canonical JSON
 * or prologue differs by one byte fails the handshake in exactly the same way
 * as a wrong password, so round-tripping against ourselves would prove nothing.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bytesToHex, utf8Decode, utf8Encode } from "../src/bytes.js";
import {
  buildPrologue,
  canonicalJson,
  derivePsk,
  NOISE_CHUNK_SIZE,
  NOISE_MAX_REASSEMBLY,
  NOISE_PATTERN_KK,
  NOISE_PATTERN_XX,
  NoiseHandshake,
  noiseNonce,
  noiseProtocolName,
  selectNoiseOptions,
  transportAead,
  x25519PublicKey,
} from "../src/noise.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HiveMindMqttTransport } from "../src/transport-mqtt.js";
import { HiveMindHttpTransport } from "../src/transport-core.js";
import { ThalovantControlPlane } from "../src/control.js";
import { loadNoisePin, pinHubKey, saveNoisePin } from "../src/noise-store.js";

test("derivePsk matches the reference vectors", () => {
  const vectors: Array<[string, string, string]> = [
    ["Tr0ub4dor-Horse-Battery-91x", "node-alpha", "ce6825b343771aed1833233c8d1af4ce4e470cee89b625065402def527f900ce"],
    ["", "", "38bedc40c2ce3b79cd5ccf53745e029363f5ba1948cb21f018bcce6eb0869876"],
    ["passé-wörd", "hub-ümläut", "988418601dbad183fbd6116e7981e9ab8ffe93be3f3f45c27eb0b70c325f9cd8"],
  ];
  for (const [password, nodeId, expected] of vectors) {
    assert.equal(
      bytesToHex(derivePsk(password, nodeId)),
      expected,
      `the pre-shared key for ${JSON.stringify(password)} does not match the reference`,
    );
  }
});

test("the transport AEAD matches the reference ciphertexts", () => {
  // The two suites encode the nonce counter differently -- ChaChaPoly
  // little-endian, AESGCM big-endian (Noise spec rev 34, section 12) -- and
  // they agree only at counter zero. A same-implementation round trip would
  // pass with either convention and then fail against a real hub on the
  // second transport message, so these are the reference implementation's own
  // ciphertexts (noiseprotocol 0.3.1) at counters that tell the two apart.
  const key = new Uint8Array(32).map((_, index) => index);
  const plaintext = utf8Encode("noise-transport-vector");
  const empty = new Uint8Array(0);

  const vectors: Array<[string, bigint, string, string]> = [
    ["25519_AESGCM_SHA256", 0n, "000000000000000000000000", "60d3dcadd001f7cf69c6da45775ee5b4a426352747f338bb2af87fdc1579d700c91a945fb6f8"],
    ["25519_AESGCM_SHA256", 1n, "000000000000000000000001", "7bb9d68f21d9446c6f40224983d44eda63fa7f200bc0fffcd5d4c0be724d78c6ff213aeed524"],
    ["25519_AESGCM_SHA256", 258n, "000000000000000000000102", "634779e501b1642347721a75d47243559573cbfac3370330645b209d163adf1c04f90a6a4bc2"],
    ["25519_ChaChaPoly_SHA256", 0n, "000000000000000000000000", "76d72b42c8cbd2a3720f2f11c0313a0a8ed490818edfa398489a90977d28e1e804160e81b654"],
    ["25519_ChaChaPoly_SHA256", 1n, "000000000100000000000000", "f1389a2cd007db6a48d8dd2c3de7edaab318887a2819064363d7678f8b9eea0e2ddfba8dc3d3"],
    ["25519_ChaChaPoly_SHA256", 258n, "000000000201000000000000", "73da914e74a79fe130e33c0c5adf0eab01c818746c83c7b909d0302385d6735a45edfcacd811"],
  ];

  for (const [suite, counter, expectedNonce, expectedCiphertext] of vectors) {
    const littleEndian = suite === "25519_ChaChaPoly_SHA256";
    assert.equal(
      bytesToHex(noiseNonce(counter, littleEndian)),
      expectedNonce,
      `${suite} nonce at counter ${counter} does not match the reference`,
    );
    assert.equal(
      bytesToHex(transportAead(suite).encrypt(key, counter, empty, plaintext)),
      expectedCiphertext,
      `${suite} ciphertext at counter ${counter} does not match the reference`,
    );
  }
});

test("derivePsk is salted by the node id", () => {
  assert.notDeepEqual(
    derivePsk("same-password", "hub-one"),
    derivePsk("same-password", "hub-two"),
    "the same password produced the same key for two hubs; the node id salt is not being applied",
  );
});

test("canonicalJson matches the reference vectors", () => {
  const vectors: Array<[string, string]> = [
    ['{"b": 1, "a": [1, 2], "c": {"z": true, "y": null}}', '{"a":[1,2],"b":1,"c":{"y":null,"z":true}}'],
    ['{"binarize": false, "encodings": []}', '{"binarize":false,"encodings":[]}'],
    ['{"unicode": "café über", "amp": "a<b>c&d"}', '{"amp":"a<b>c&d","unicode":"café über"}'],
    ['{"nested": {"deep": [{"k": "v"}, 2, null]}, "num": 3}', '{"nested":{"deep":[{"k":"v"},2,null]},"num":3}'],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(canonicalJson(JSON.parse(input)), expected);
  }
});

test("canonicalJson escapes quotes, backslashes and control characters", () => {
  // Built with escapes so the source carries no literal control bytes.
  const value = { s: 'quote" back\\slash\nnewline\ttab', ctrl: "\u0001\u001f" };
  assert.equal(
    canonicalJson(value),
    '{"ctrl":"\\u0001\\u001f","s":"quote\\" back\\\\slash\\nnewline\\ttab"}',
  );
});

test("canonicalJson sorts keys whatever order they arrived in", () => {
  // The prologue must not depend on how the payload was parsed or built.
  const built: Record<string, unknown> = {};
  built.zebra = 1;
  built.apple = 2;
  built.Mango = 3;
  assert.equal(
    canonicalJson(built),
    '{"Mango":3,"apple":2,"zebra":1}',
    "keys must sort by code unit, uppercase first, however they were inserted",
  );
});

test("buildPrologue matches the reference vector", () => {
  const expected =
    "7b226e6f64655f6964223a226e6f64652d616c706861222c227075626b6579223a222d2d2d2d2d424547494e205055424c4943204b45592d2d2d2d2d5c6e6162635c6e2d2d2d2d2d454e44205055424c4943204b45592d2d2d2d2d227d7b226d61785f70726f746f636f6c5f76657273696f6e223a332c226e6f697365223a7b227061747465726e73223a5b22585870736b32225d2c22737569746573223a5b2232353531395f436861436861506f6c795f534841323536225d7d7d4e6f6973655f585870736b325f32353531395f436861436861506f6c795f534841323536";

  const hello = {
    node_id: "node-alpha",
    pubkey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
  };
  const handshake = {
    max_protocol_version: 3,
    noise: { patterns: ["XXpsk2"], suites: ["25519_ChaChaPoly_SHA256"] },
  };
  const prologue = buildPrologue(
    hello,
    handshake,
    noiseProtocolName(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256"),
  );
  assert.equal(bytesToHex(prologue), expected);
});

test("noiseProtocolName joins the selection", () => {
  assert.equal(
    noiseProtocolName(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256"),
    "Noise_XXpsk2_25519_ChaChaPoly_SHA256",
  );
});

test("selectNoiseOptions prefers a pinned hub", () => {
  const both = [NOISE_PATTERN_KK, NOISE_PATTERN_XX];
  const chacha = ["25519_ChaChaPoly_SHA256"];
  const pin = "ab".repeat(32);

  assert.deepEqual(selectNoiseOptions(both, chacha), {
    pattern: NOISE_PATTERN_XX,
    suite: "25519_ChaChaPoly_SHA256",
  });
  assert.deepEqual(selectNoiseOptions(both, chacha, pin), {
    pattern: NOISE_PATTERN_KK,
    suite: "25519_ChaChaPoly_SHA256",
  });
  assert.deepEqual(
    selectNoiseOptions([NOISE_PATTERN_XX], chacha, pin),
    { pattern: NOISE_PATTERN_XX, suite: "25519_ChaChaPoly_SHA256" },
    "a pinned key still falls back when KK is not offered",
  );
});

test("selectNoiseOptions walks our own suite preference", () => {
  // The hub lists AESGCM first; ChaChaPoly must still win because both have it.
  assert.deepEqual(
    selectNoiseOptions([NOISE_PATTERN_XX], ["25519_AESGCM_SHA256", "25519_ChaChaPoly_SHA256"]),
    { pattern: NOISE_PATTERN_XX, suite: "25519_ChaChaPoly_SHA256" },
  );
  assert.deepEqual(
    selectNoiseOptions([NOISE_PATTERN_XX], ["25519_AESGCM_SHA256"]),
    { pattern: NOISE_PATTERN_XX, suite: "25519_AESGCM_SHA256" },
    "AESGCM is taken when it is all the hub has",
  );
});

test("selectNoiseOptions reports no mutual option", () => {
  assert.equal(selectNoiseOptions([NOISE_PATTERN_XX], ["448_ChaChaPoly_BLAKE2b"]), undefined);
  assert.equal(selectNoiseOptions(["NNpsk0"], ["25519_ChaChaPoly_SHA256"]), undefined);
  assert.equal(selectNoiseOptions([], []), undefined);
});

/** Complete a handshake between an initiator and a responder. */
function handshakePair(pattern: string, suite: string): { client: NoiseHandshake; hub: NoiseHandshake } {
  const psk = derivePsk("shared", "hub");
  const prologue = utf8Encode("prologue");
  const clientKey = Uint8Array.from(randomBytes(32));
  const hubKey = Uint8Array.from(randomBytes(32));

  const client = new NoiseHandshake(
    pattern,
    suite,
    psk,
    prologue,
    clientKey,
    pattern === NOISE_PATTERN_KK ? x25519PublicKey(hubKey) : undefined,
    true,
  );
  const hub = new NoiseHandshake(
    pattern,
    suite,
    psk,
    prologue,
    hubKey,
    pattern === NOISE_PATTERN_KK ? x25519PublicKey(clientKey) : undefined,
    false,
  );

  hub.readMessage(client.writeMessage(utf8Encode("p1")));
  client.readMessage(hub.writeMessage(utf8Encode("p2")));
  if (!client.isFinished) {
    hub.readMessage(client.writeMessage());
  }
  assert.ok(client.isFinished && hub.isFinished, "the handshake did not finish");
  assert.equal(
    client.remoteStaticKey,
    bytesToHex(x25519PublicKey(hubKey)),
    "the client did not learn the hub's static key; there would be nothing to pin",
  );
  return { client, hub };
}

for (const pattern of [NOISE_PATTERN_XX, NOISE_PATTERN_KK]) {
  for (const suite of ["25519_ChaChaPoly_SHA256", "25519_AESGCM_SHA256"]) {
    test(`${pattern} over ${suite} carries traffic both ways`, () => {
      const { client, hub } = handshakePair(pattern, suite);
      const clientSession = client.intoSession();
      const hubSession = hub.intoSession();

      const [outbound] = clientSession.encryptMessage(utf8Encode('{"a":1}'), true);
      const atHub = hubSession.decryptFrame(outbound);
      assert.ok(atHub.complete && atHub.isJson);
      assert.equal(utf8Decode(atHub.payload), '{"a":1}');

      const [inbound] = hubSession.encryptMessage(utf8Encode('{"b":2}'), true);
      const atClient = clientSession.decryptFrame(inbound);
      assert.ok(atClient.complete && atClient.isJson);
      assert.equal(utf8Decode(atClient.payload), '{"b":2}');
    });
  }
}

test("an oversize message is chunked and reassembled", () => {
  const { client, hub } = handshakePair(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256");
  const clientSession = client.intoSession();
  const hubSession = hub.intoSession();

  // Two and a bit chunks, so the sequence is FIRST, MORE, LAST.
  const original = new Uint8Array(NOISE_CHUNK_SIZE * 2 + 1024).fill(0x78);
  const frames = clientSession.encryptMessage(original, true);
  assert.equal(frames.length, 3);

  assert.equal(hubSession.decryptFrame(frames[0]).complete, false);
  assert.equal(hubSession.decryptFrame(frames[1]).complete, false);
  const finished = hubSession.decryptFrame(frames[2]);
  assert.ok(finished.complete);
  assert.deepEqual(finished.payload, original);
});

test("binary frames keep their marker", () => {
  const { client, hub } = handshakePair(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256");
  const [frame] = client.intoSession().encryptMessage(Uint8Array.of(0x0c, 0xff, 0x00), false);
  const received = hub.intoSession().decryptFrame(frame);
  assert.ok(received.complete);
  assert.equal(received.isJson, false);
  assert.deepEqual(received.payload, Uint8Array.of(0x0c, 0xff, 0x00));
});

test("a tampered frame is rejected", () => {
  const { client, hub } = handshakePair(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256");
  const [frame] = client.intoSession().encryptMessage(utf8Encode('{"a":1}'), true);
  frame[frame.length - 1] ^= 0xff;
  assert.throws(
    () => hub.intoSession().decryptFrame(frame),
    /tampered, replayed or out-of-order/,
    "a tampered frame decrypted; the AEAD tag is not being enforced",
  );
});

test("a replayed frame is rejected", () => {
  const { client, hub } = handshakePair(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256");
  const clientSession = client.intoSession();
  const hubSession = hub.intoSession();

  const [first] = clientSession.encryptMessage(utf8Encode('{"n":1}'), true);
  clientSession.encryptMessage(utf8Encode('{"n":2}'), true);

  hubSession.decryptFrame(first);
  assert.throws(
    () => hubSession.decryptFrame(first),
    /tampered, replayed or out-of-order/,
    "a replayed frame decrypted; the nonce counter is not advancing",
  );
});

test("a complete frame arriving mid-reassembly is rejected", () => {
  const { client, hub } = handshakePair(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256");
  const clientSession = client.intoSession();
  const hubSession = hub.intoSession();

  // encryptMessage cannot produce this sequence -- it always closes a chunked
  // message with a LAST -- so the frames are sealed one at a time through the
  // session's own sealer. They have to be consecutive: the nonce counter is
  // strictly sequential, so a gap would fail the AEAD before the marker is
  // ever looked at, and the guard under test would never run.
  const seal = (marker: number, body: Uint8Array): Uint8Array =>
    (clientSession as unknown as { sealed(marker: number, body: Uint8Array): Uint8Array }).sealed(marker, body);

  const FRAME_JSON = 0x00;
  const FRAME_FIRST_JSON = 0x02;

  hubSession.decryptFrame(seal(FRAME_FIRST_JSON, utf8Encode("first-chunk")));
  assert.throws(
    () => hubSession.decryptFrame(seal(FRAME_JSON, utf8Encode('{"a":1}'))),
    /still buffered/,
    "a complete frame was accepted while a chunked message was open",
  );
});

test("reassembly is capped", () => {
  assert.equal(NOISE_MAX_REASSEMBLY, 32 * 1024 * 1024);
  const { client, hub } = handshakePair(NOISE_PATTERN_XX, "25519_ChaChaPoly_SHA256");
  const clientSession = client.intoSession();
  const hubSession = hub.intoSession();

  // Cross the cap with real chunks rather than by reaching into the session:
  // the guard has to fire on the wire path, not only when poked directly.
  const oversize = new Uint8Array(NOISE_MAX_REASSEMBLY + NOISE_CHUNK_SIZE).fill(0x7c);
  const frames = clientSession.encryptMessage(oversize, true);
  assert.throws(() => {
    for (const frame of frames) hubSession.decryptFrame(frame);
  }, /exceeded the 33554432 byte cap/);
});

test("MQTT refuses a cleartext broker", async () => {
  // Pins the one thing standing between an MQTT message and the wire now that
  // v3 removed the separate payload cipher.
  const identity = new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    site_id: "site",
    default_master: "https://hub.example.com",
    mqtt: {
      endpoint: "mqtt://broker.example.com:1883",
      username: "access",
      password: "broker-secret",
      topic_prefix: "hubs/hub-1/client-1",
      tls: false,
    },
  });
  const transport = new HiveMindMqttTransport(identity);

  await assert.rejects(
    () => transport.connect(),
    /without TLS/,
    "connected to a cleartext MQTT broker; every message and the broker password would go out in the clear",
  );
});

test("concurrent pins do not lose one another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-pins-"));
  try {
    // Read-modify-write on one file: without a lock the later write is built
    // from a snapshot taken before the earlier one landed, and an entry
    // disappears.
    const hubs = Array.from({ length: 12 }, (_, index) => `hub-${index}`);
    await Promise.all(hubs.map((hub, index) => saveNoisePin(dir, hub, String(index).repeat(64).slice(0, 64))));

    for (const [index, hub] of hubs.entries()) {
      assert.equal(
        await loadNoisePin(dir, hub),
        String(index).repeat(64).slice(0, 64),
        `${hub} lost its pin to a concurrent write`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pinHubKey refuses a changed key and keeps the original", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thalovant-pins-"));
  try {
    await pinHubKey(dir, "hub", "aa".repeat(32));
    // The same key again is a normal reconnect.
    await pinHubKey(dir, "hub", "aa".repeat(32));

    await assert.rejects(
      () => pinHubKey(dir, "hub", "bb".repeat(32)),
      /forgetNoisePin/,
      "a changed hub key was accepted; pinning gives no protection",
    );
    assert.equal(
      await loadNoisePin(dir, "hub"),
      "aa".repeat(32),
      "the stored pin was overwritten by the rejected key",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the HTTP transport refuses a cleartext endpoint", () => {
  // TLS is the only confidentiality on this path now, and the access key
  // travels in the authorization query.
  const identity = new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    site_id: "site",
    default_master: "http://hub.example.com",
    default_port: 80,
  });
  const transport = new HiveMindHttpTransport(identity);

  assert.throws(
    () => transport.baseUrl,
    /https:\/\//,
    "the HTTP transport accepted a cleartext endpoint",
  );
});

test("createClientIdentity never forwards a caller's legacy crypto key", async () => {
  // options.spec is caller-supplied and spread wholesale into the request.
  let sentSpec: Record<string, unknown> | undefined;
  const control = new ThalovantControlPlane("https://dash.example.com/api", { accessToken: "token" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith("/v1/hubs/hub-1")) {
      return new Response(JSON.stringify({
        id: "hub-1",
        name: "hub",
        spec: { protocols: { wss: { enabled: true } } },
        data_plane_endpoints: { wss: "wss://hub.example.com" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (target.endsWith("/v1/clients")) {
      const body = JSON.parse(String(init?.body)) as { spec: Record<string, unknown> };
      sentSpec = body.spec;
      return new Response(JSON.stringify({ id: "client-1", name: "kiosk", hub_id: "hub-1", spec: {} }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request ${target}`);
  }) as typeof globalThis.fetch;

  try {
    await control.createClientIdentity("hub-1", {
      name: "kiosk",
      spec: { cryptoKey: "caller-supplied-SECRET", crypto_key: "caller-supplied-SECRET-2", label: "keep-me" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(sentSpec);
  assert.equal("cryptoKey" in sentSpec, false, "a caller-supplied cryptoKey reached /v1/clients");
  assert.equal("crypto_key" in sentSpec, false, "a caller-supplied crypto_key reached /v1/clients");
  assert.equal(sentSpec.label, "keep-me", "the rest of the caller's spec must survive");
});
