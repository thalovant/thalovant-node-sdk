import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLocation, requestContext, speakable, HubIntent, ThalovantEvent,
  ThalovantClient, ThalovantIdentity, ThalovantControlPlane, ThalovantApiError,
  EVENT_AUDIO_QUEUE, MAX_AUDIO_CLIP_BYTES, type EventContext,
} from "../src/index.js";

const revision = (n: number) => n.toString(16).padStart(64, "0");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("configuration snapshots nested personas and delta before reads and retries", async t => {
  const config = { nested: { value: "original" } };
  const personas = { default: { name: "original" } };
  let writes = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") {
      config.nested.value = "changed";
      personas.default.name = "changed";
      return json({ config: {}, revision: revision(1) });
    }
    const body = JSON.parse(String(init?.body));
    assert.equal(body.config.nested.value, "original");
    assert.equal(body.personas.default.name, "original");
    return json({}, ++writes === 1 ? 412 : 200);
  });
  await new ThalovantControlPlane("https://example.com", { accessToken: "test" })
    .updateRuntimeGroupConfig("g", config, { personas });
  assert.equal(writes, 2);
});

test("request hints preserve caller/session data and omit empty hints", () => {
  const base = { session: { session_id: "kept", pipeline: ["old"] }, extra: true };
  const location = buildLocation({ city: " Montréal ", country: " ca ", region: " QC ", latitude: "45.5", longitude: "-73.5", timezone: "America/Toronto" });
  assert.deepEqual(location, { city: "Montréal", country_code: "CA", region: "QC", coordinate: { latitude: 45.5, longitude: -73.5 }, timezone: { code: "America/Toronto" } });
  assert.deepEqual(requestContext(base, { sttLang: " fr-CA ", pipeline: [" ", "intent"], location }), {
    extra: true, session: { session_id: "kept", pipeline: ["intent"] }, stt_lang: "fr-CA", location,
  });
  assert.deepEqual(base.session.pipeline, ["old"]);
  requestContext(base, { sttLang: "fr" })!.session!.session_id = "changed";
  assert.equal(base.session.session_id, "kept");
  assert.equal(requestContext(), undefined);
  assert.equal(buildLocation({ country: "CA" }), undefined);
  for (const [latitude, longitude] of [[0, 0], [91, 0], [0, 181], [NaN, 2], [Infinity, 1], ["", "5"], ["bad", "2"], ["0x2", "3"]]) {
    assert.deepEqual(buildLocation({ city: "Toronto", latitude, longitude }), { city: "Toronto" });
  }
});

test("speakable examples retain original complete-phrase priority and best duplicate rank", () => {
  assert.equal(speakable("[please] (repeat|say) {item_name}", { item_name: "the time" }), "repeat the time");
  assert.equal(speakable("did i (already |)ask (about|for|to|) {thing}"), "did i ask about thing");
  assert.equal(speakable("mute [it [for a bit]]"), "mute");
  const intent = new HubIntent({ skillId: "x", name: "x", engine: "padatious", phrases: {
    "en-us": ["{x}", "a complete sentence", "[please]", "(x|y)", "x"],
  } });
  assert.deepEqual(intent.examples("en-us", 2, { speakable: true }), ["x", "a complete sentence"]);
  assert.deepEqual(intent.examples("en-us", 0, { speakable: true }), ["x", "a complete sentence"]);
});

test("audio decoding is bounded, strict and never resolves URLs", () => {
  const event = new ThalovantEvent(EVENT_AUDIO_QUEUE, { binary_data: "00 ff\n10", lang: "fr" }, { lang: "en" });
  assert.deepEqual(event.audioBytes(), new Uint8Array([0, 255, 16]));
  assert.equal(event.lang, "fr");
  assert.equal(event.hasAudio, true);
  for (const binary_data of [undefined, "", "0", "0 0", "gg", "https://example.com/audio", "00\u00a0ff"]) {
    assert.throws(() => new ThalovantEvent(EVENT_AUDIO_QUEUE, { binary_data }).audioBytes());
  }
  assert.throws(() => event.audioBytes(1));
  assert.throws(() => event.audioBytes(-1));
  assert.throws(() => new ThalovantEvent("speak", { binary_data: "00" }).audioBytes());
});

test("maximum-size embedded audio decodes without recursive matching", () => {
  const clip = "a5".repeat(MAX_AUDIO_CLIP_BYTES);
  const bytes = new ThalovantEvent(EVENT_AUDIO_QUEUE, { binary_data: clip }).audioBytes();
  assert.equal(bytes.length, MAX_AUDIO_CLIP_BYTES);
  assert.ok(bytes.every(value => value === 0xa5));
  assert.throws(() => new ThalovantEvent(EVENT_AUDIO_QUEUE, { binary_data: clip.slice(0, -1) + "g" }).audioBytes());
});

class AudioTransport extends EventTarget {
  ready = false;
  async connect() { this.ready = true; }
  async disconnect() { this.ready = false; }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus(_type: string, _data: unknown, context: EventContext) {
    assert.equal(context.stt_lang, "fr");
    assert.deepEqual(context.session?.pipeline, ["test"]);
    const emit = (type: string, data: unknown) => {
      const detail = { type, data, context: { ...context, lang: "fr" } };
      this.dispatchEvent(new CustomEvent("bus", { detail }));
      return detail;
    };
    const same = emit(EVENT_AUDIO_QUEUE, { binary_data: "01" });
    this.dispatchEvent(new CustomEvent("bus", { detail: same }));
    emit(EVENT_AUDIO_QUEUE, { binary_data: "00".repeat(MAX_AUDIO_CLIP_BYTES + 1) });
    for (let i = 0; i < 4; i++) emit(EVENT_AUDIO_QUEUE, { binary_data: "00".repeat(MAX_AUDIO_CLIP_BYTES) });
    emit("speak", { utterance: "Bonjour" });
    emit("ovos.utterance.handled", {});
  }
}

test("ask retains ordered audio within clip/aggregate limits and ignores duplicate delivery", async () => {
  const transport = new AudioTransport();
  const client = new ThalovantClient(new ThalovantIdentity({ key: "fixture", password: "fixture", host: "https://fixture.invalid", site: "fixture" }), { transport });
  try {
    const reply = await client.ask("hello", { sttLang: " fr ", pipeline: ["test"], replySettleMs: 0, timeoutMs: 1000 });
    assert.equal(reply.text, "Bonjour");
    assert.equal(reply.lang, "fr");
    assert.equal(reply.hasAudio, true);
    assert.equal(reply.droppedMedia, 2);
    assert.equal(reply.mediaEvents?.length, 5);
    assert.equal(reply.mediaEvents?.at(-1)?.name, "speak");
  } finally { await client.close(); }
});

test("configuration conflicts re-read and re-merge original delta with no lost keys", async t => {
  let config = { nested: { original: true } } as Record<string, unknown>;
  let reads = 0, writes = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") { reads++; return json({ config, revision: revision(reads) }); }
    assert.equal(init?.method, "PUT");
    const body = JSON.parse(String(init?.body));
    writes++;
    if (writes === 1) { config = { nested: { original: true, concurrent: true } }; return json({}, 412); }
    assert.equal(body.expected_revision, revision(2));
    assert.deepEqual(body.personas, {});
    config = body.config;
    return json({ config });
  });
  const delta = { nested: { caller: true }, array: [1] };
  const api = new ThalovantControlPlane("https://example.com/api", { accessToken: "test" });
  await api.updateRuntimeGroupConfig("a/b", delta, { personas: {} });
  assert.deepEqual(config, { nested: { original: true, concurrent: true, caller: true }, array: [1] });
  assert.deepEqual(delta, { nested: { caller: true }, array: [1] });
  assert.equal(reads, 2);
});

for (const status of [400, 401, 403, 405, 409, 412, 429, 500]) {
  test(`configuration retries only 412 and never exceeds three attempts (${status})`, async t => {
    let reads = 0, writes = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "GET") { reads++; return json({ config: {}, revision: revision(1) }); }
      assert.equal(init?.method, "PUT");
      writes++;
      return json({ detail: "rejected" }, status);
    });
    const api = new ThalovantControlPlane("https://example.com/api", { accessToken: "test" });
    await assert.rejects(api.updateRuntimeGroupConfig("x", {}), (e: unknown) => e instanceof ThalovantApiError && e.statusCode === status);
    assert.equal(writes, status === 412 ? 3 : 1);
    assert.equal(reads, writes);
  });
}

for (const snapshot of [{ config: {} }, { config: {}, revision: "invalid" }, { config: [], revision: revision(1) }]) {
  test(`older/malformed server cannot trigger a config write: ${JSON.stringify(snapshot)}`, async t => {
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => { assert.equal(init?.method, "GET"); return json(snapshot); });
    const api = new ThalovantControlPlane("https://example.com/api", { accessToken: "test" });
    await assert.rejects(api.updateRuntimeGroupConfig("x", {}), ThalovantApiError);
  });
}

test("configuration merge treats prototype-named keys as JSON data", async t => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "GET") return json({ config: JSON.parse('{"__proto__":{"kept":true}}'), revision: revision(1) });
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.config, JSON.parse('{"__proto__":{"kept":true,"new":true},"constructor":{"safe":true}}'));
    return json(body);
  });
  await new ThalovantControlPlane("https://example.com", { accessToken: "test" }).updateRuntimeGroupConfig("x", JSON.parse('{"__proto__":{"new":true},"constructor":{"safe":true}}'));
  assert.equal(({} as Record<string, unknown>).kept, undefined);
});
