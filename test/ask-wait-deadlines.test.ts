import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { ThalovantClient } from "../src/client.js";
import { ThalovantRuntimeError, ThalovantTimeoutError } from "../src/errors.js";
import type { EventContext } from "../src/events.js";
import { ThalovantIdentity } from "../src/identity.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
class Runtime extends EventTarget {
  ready = false;
  sent = 0;
  closed = 0;
  context: EventContext = {};
  script: (peer: Runtime) => Promise<void> = async () => {};
  async connect() { this.ready = true; }
  async disconnect() { this.closed++; this.ready = false; }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus(_name: string, _data: Record<string, unknown>, context: EventContext) {
    this.sent++; this.context = context; await this.script(this);
  }
  reply(type: string, text?: string, context = this.context) {
    this.dispatchEvent(new CustomEvent("bus", { detail: { type, data: text ? { utterance: text } : {}, context } }));
  }
}
function client(transport: Runtime) {
  return new ThalovantClient(new ThalovantIdentity({ key: "fixture", password: "fixture", host: "https://fixture.invalid", site: "fixture" }), { transport, replySettleMs: 0, emptyReplyWaitMs: 0 });
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test guard: caller budget was not enforced")), 250); })]); }
  finally { clearTimeout(timer); }
}

for (const method of ["ask", "waitForEvent"] as const) {
  test(`${method} deadline includes held connect and never sends after expiry`, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    class Held extends Runtime { override async connect() { await gate; this.ready = true; } }
    const peer = new Held(); const sdk = client(peer);
    peer.script = async p => { p.reply("speak", "late"); p.reply("ovos.utterance.handled"); };
    const pending = method === "ask" ? sdk.ask("hello", { timeoutMs: 25 }) : sdk.waitForEvent("fixture", { timeoutMs: 25 });
    try { await assert.rejects(bounded<unknown>(pending), ThalovantTimeoutError); assert.equal(peer.sent, 0); }
    finally { release(); await sdk.close(); await pending.catch(() => undefined); }
    assert.equal(peer.sent, 0); assert.equal(getEventListeners(peer, "bus").length, 0);
  });
}

test("waitForEvent retains an authenticated event emitted just before connect returns", async () => {
  class Early extends Runtime {
    override async connect() { this.ready = true; this.reply("fixture", "early", { request_id: "match", session: { session_id: "rewritten" } }); }
  }
  const peer = new Early(); const sdk = client(peer);
  try {
    const event = await sdk.waitForEvent("fixture", { timeoutMs: 60, requestId: "match", sessionId: "caller" });
    assert.equal(event.text, "early"); assert.equal(getEventListeners(peer, "bus").length, 0);
  } finally { await sdk.close(); }
});

for (const state of ["empty", "settle"] as const) {
  test(`ask includes ${state} reply collection in its original budget`, async () => {
    const peer = new Runtime(); const sdk = client(peer);
    peer.script = async p => { if (state === "settle") p.reply("speak", "partial"); p.reply("ovos.utterance.handled"); };
    try {
      const result = sdk.ask("hello", { timeoutMs: 35, emptyReplyWaitMs: 1000, replySettleMs: 1000 });
      if (state === "empty") await assert.rejects(bounded(result), ThalovantTimeoutError);
      else assert.equal((await bounded(result)).text, "partial");
      assert.equal(getEventListeners(peer, "bus").length, 0);
    } finally { await sdk.close(); }
  });
}

for (const hard of ["hive.policy.denied", "hive.query.timeout"]) {
  for (const partial of [false, true]) {
    test(`ask freezes ${hard} with partial=${partial}`, async () => {
      const peer = new Runtime(); const sdk = client(peer);
      peer.script = async p => { if (partial) p.reply("speak", "partial"); p.reply(hard); p.reply("speak", "too late"); };
      try {
        const pending = sdk.ask("hello", { timeoutMs: 100, replySettleMs: 0 });
        if (!partial) await assert.rejects(pending, ThalovantRuntimeError);
        else { const reply = await pending; assert.equal(reply.text, "partial"); assert.equal(reply.ok, false); assert.deepEqual(reply.events.map(e => e.name), ["speak", hard]); }
        assert.equal(getEventListeners(peer, "bus").length, 0);
      } finally { await sdk.close(); }
    });
  }
}

test("ask observes a stalled send while enforcing its caller budget", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const peer = new Runtime(); const sdk = client(peer);
  peer.script = async () => { await gate; };
  try { await assert.rejects(bounded(sdk.ask("hello", { timeoutMs: 25 })), ThalovantTimeoutError); assert.equal(getEventListeners(peer, "bus").length, 0); }
  finally { release(); await sdk.close(); }
});

for (const method of ["ask", "waitForEvent"] as const) {
  test(`${method} aborts a queued readiness caller without closing its owner`, async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    class Held extends Runtime { override async connect() { await gate; this.ready = true; } }
    const peer = new Held(); const sdk = client(peer);
    const owner = sdk.connect(500);
    await sleep(0);
    const controller = new AbortController();
    const queued = method === "ask" ? sdk.ask("hello", { timeoutMs: 500, signal: controller.signal }) : sdk.waitForEvent("fixture", { timeoutMs: 500, signal: controller.signal });
    controller.abort();
    try {
      await assert.rejects(queued, { name: "AbortError" });
      assert.equal(peer.closed, 0); assert.equal(peer.sent, 0);
      assert.equal(getEventListeners(peer, "bus").length, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      release(); await owner; assert.equal(peer.ready, true);
    } finally { release(); await sdk.close(); }
  });

  test(`${method} abort cleans its subscription without closing an authenticated connection`, async () => {
    const peer = new Runtime(); const sdk = client(peer);
    const controller = new AbortController();
    await sdk.connect();
    const pending = method === "ask" ? sdk.ask("hello", { signal: controller.signal }) : sdk.waitForEvent("fixture", { signal: controller.signal });
    await sleep(0);
    controller.abort();
    try {
      await assert.rejects(pending, { name: "AbortError" });
      assert.equal(peer.ready, true); assert.equal(peer.closed, 0);
      assert.equal(getEventListeners(peer, "bus").length, 0);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    } finally { await sdk.close(); }
  });
}

test("aborting the connection initiator retains cleanup until its late connect finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Held extends Runtime { override async connect() { await gate; this.ready = true; } }
  const peer = new Held(); const sdk = client(peer);
  const controller = new AbortController();
  const pending = sdk.ask("hello", { signal: controller.signal });
  await sleep(0); controller.abort();
  try {
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(peer.sent, 0);
    release(); await sdk.close(); assert.equal(peer.ready, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally { release(); await sdk.close(); }
});

for (const soft of ["complete_intent_failure", "ovos.intent.unmatched"]) {
  test(`ask accepts bounded delayed speech after ${soft}`, async () => {
    const peer = new Runtime(); const sdk = client(peer);
    peer.script = async p => { p.reply(soft); await sleep(10); p.reply("speak", "recovered"); };
    try {
      const reply = await sdk.ask("hello", { timeoutMs: 150, emptyReplyWaitMs: 100, replySettleMs: 0 });
      assert.equal(reply.text, "recovered"); assert.equal(reply.ok, true); assert.equal(reply.failureEvent, undefined);
    } finally { await sdk.close(); }
  });
}

test("waitForEvent preserves concurrent correlation and reports predicate failures safely", async () => {
  const peer = new Runtime(); const sdk = client(peer);
  const first = sdk.waitForEvent("fixture", { timeoutMs: 200, requestId: "first" });
  const second = sdk.waitForEvent("fixture", { timeoutMs: 200, requestId: "second" });
  await sleep(0);
  peer.reply("fixture", "second reply", { request_id: "second" });
  peer.reply("fixture", "first reply", { request_id: "first" });
  try {
    assert.equal((await first).text, "first reply"); assert.equal((await second).text, "second reply");
    const failed = sdk.waitForEvent("fixture", { predicate: () => { throw new Error("synthetic predicate failure"); } });
    peer.reply("fixture", "anything");
    await assert.rejects(failed, /synthetic predicate failure/);
    assert.equal(getEventListeners(peer, "bus").length, 0);
  } finally { await sdk.close(); }
});

test("ask keeps a hard terminal reply even when its observed write subsequently fails", async () => {
  const peer = new Runtime(); const sdk = client(peer);
  peer.script = async p => { p.reply("speak", "partial"); p.reply("hive.policy.denied"); throw new Error("late write failure"); };
  try { const reply = await sdk.ask("hello"); assert.equal(reply.text, "partial"); assert.equal(reply.ok, false); }
  finally { await sdk.close(); }
});

for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
  test(`invalid request timer ${timeoutMs} fails before connecting`, async () => {
    const peer = new Runtime(); const sdk = client(peer);
    await assert.rejects(sdk.ask("hello", { timeoutMs }), ThalovantTimeoutError);
    await assert.rejects(sdk.waitForEvent("fixture", { timeoutMs }), ThalovantTimeoutError);
    assert.equal(peer.ready, false); assert.equal(peer.sent, 0);
  });
}
