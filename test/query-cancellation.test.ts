import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { ThalovantClient } from "../src/client.js";
import { ThalovantConnectionError, ThalovantTimeoutError } from "../src/errors.js";
import { ThalovantIdentity } from "../src/identity.js";
import type { HiveMessage } from "../src/transport.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("query cancellation did not stop the caller")), 300);
    })]);
  } finally { clearTimeout(timer); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

class QueryPeer extends EventTarget {
  ready = false;
  connects = 0;
  disconnects = 0;
  sent: HiveMessage[] = [];
  script: (peer: QueryPeer, message: HiveMessage) => Promise<void> = async () => {};
  async connect() { this.connects++; this.ready = true; }
  async disconnect() { this.disconnects++; this.ready = false; }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus() {}
  sendHiveMessage(message: HiveMessage): Promise<void> {
    this.sent.push(message);
    return this.script(this, message);
  }
  reply(message: HiveMessage, type: string, text?: string, channel = "query") {
    this.dispatchEvent(new CustomEvent(channel, { detail: {
      msg_type: channel,
      metadata: message.metadata,
      payload: { type, data: text ? { utterance: text } : {}, context: { session: { session_id: "runtime-session" } } },
    } }));
  }
}
function client(peer: QueryPeer) {
  return new ThalovantClient(new ThalovantIdentity({
    key: "fixture", password: "fixture", host: "https://fixture.invalid", site: "fixture",
  }), { transport: peer });
}
function assertClean(peer: QueryPeer, signal: AbortSignal) {
  for (const type of ["query", "cascade"]) assert.equal(getEventListeners(peer, type).length, 0);
  assert.equal(getEventListeners(signal, "abort").length, 0);
}

for (const conversation of [false, true]) {
  test(`${conversation ? "conversation query" : "query"} rejects an already aborted signal before transport I/O`, async () => {
    const peer = new QueryPeer(); const sdk = client(peer); const controller = new AbortController();
    controller.abort(new Error("caller-private abort reason"));
    const options = { signal: controller.signal, timeoutMs: 30 };
    try {
      const pending = conversation ? sdk.conversation().query("hello", options) : sdk.query("hello", options);
      await assert.rejects(bounded(pending), { name: "AbortError" });
      assert.equal(peer.connects, 0); assert.equal(peer.sent.length, 0); assertClean(peer, controller.signal);
    } finally { await sdk.close(); }
  });
}

test("query cancellation during queued readiness preserves its active owner", async () => {
  const entered = deferred(); const release = deferred();
  class HeldConnect extends QueryPeer {
    override async connect() { this.connects++; entered.resolve(); await release.promise; this.ready = true; }
  }
  const peer = new HeldConnect(); const sdk = client(peer); const controller = new AbortController();
  const owner = sdk.connect(2000); await entered.promise;
  const options = { signal: controller.signal, timeoutMs: 1000 };
  const pending = sdk.query("hello", options);
  controller.abort();
  try {
    await assert.rejects(bounded(pending), { name: "AbortError" });
    assert.equal(peer.disconnects, 0); assert.equal(peer.sent.length, 0);
    assertClean(peer, controller.signal);
    release.resolve(); await owner; assert.equal(peer.ready, true);
  } finally { release.resolve(); await owner.catch(() => undefined); await sdk.close(); await pending.catch(() => undefined); }
});

test("query initiator cancellation retains late connection cleanup and never publishes", async () => {
  const entered = deferred(); const release = deferred();
  class HeldConnect extends QueryPeer {
    override async connect() { this.connects++; entered.resolve(); await release.promise; this.ready = true; }
  }
  const peer = new HeldConnect(); const sdk = client(peer); const controller = new AbortController();
  const options = { signal: controller.signal, timeoutMs: 1000 };
  const pending = sdk.query("hello", options); await entered.promise; controller.abort();
  try {
    await assert.rejects(bounded(pending), { name: "AbortError" });
    assert.equal(peer.sent.length, 0); assertClean(peer, controller.signal);
    await assert.rejects(sdk.connect(20), ThalovantConnectionError);
    assert.equal(peer.connects, 1, "replacement cannot bypass late owned connection work");
    release.resolve(); await sdk.close();
    assert.equal(peer.ready, false); assert.equal(peer.sent.length, 0);
  } finally { release.resolve(); await sdk.close(); await pending.catch(() => undefined); }
});

test("query checks cancellation after authenticated readiness before publishing", async () => {
  const controller = new AbortController();
  class AbortAtReadiness extends QueryPeer {
    override async connect() { await super.connect(); controller.abort(); }
  }
  const peer = new AbortAtReadiness(); const sdk = client(peer);
  const options = { signal: controller.signal, timeoutMs: 30 };
  try {
    await assert.rejects(bounded(sdk.query("hello", options)), { name: "AbortError" });
    assert.equal(peer.sent.length, 0); assertClean(peer, controller.signal);
  } finally { await sdk.close(); }
});

test("query notices cancellation during subscription setup before publishing", async () => {
  const controller = new AbortController();
  class AbortAtSubscription extends QueryPeer {
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      super.addEventListener(type, callback, options);
      if (type === "cascade") controller.abort();
    }
  }
  const peer = new AbortAtSubscription(); const sdk = client(peer);
  const options = { signal: controller.signal, timeoutMs: 1000 };
  try {
    await assert.rejects(bounded(sdk.query("hello", options)), { name: "AbortError" });
    assert.equal(peer.sent.length, 0); assertClean(peer, controller.signal);
  } finally { await sdk.close(); }
});

test("query rechecks its original deadline before deferred publication", async () => {
  class DelayedPublication extends QueryPeer {
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      super.addEventListener(type, callback, options);
      if (type === "cascade") queueMicrotask(() => {
        // Hold this isolated test process long enough to expire the deadline
        // without allowing a timer callback to perform the check for us.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      });
    }
  }
  const peer = new DelayedPublication(); const sdk = client(peer); const controller = new AbortController();
  await sdk.connect();
  try {
    await assert.rejects(bounded(sdk.query("hello", { timeoutMs: 10 })), ThalovantTimeoutError);
    assert.equal(peer.sent.length, 0); assertClean(peer, controller.signal);
  } finally { await sdk.close(); }
});

for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
  test(`query rejects invalid timer ${timeoutMs} before transport I/O`, async () => {
    const peer = new QueryPeer(); const sdk = client(peer);
    try {
      await assert.rejects(sdk.query("hello", { timeoutMs }), ThalovantTimeoutError);
      assert.equal(peer.connects, 0); assert.equal(peer.sent.length, 0);
    } finally { await sdk.close(); }
  });
}

test("query cancellation after publication retires its subscriptions without closing the connection", async () => {
  const published = deferred(); const peer = new QueryPeer(); const sdk = client(peer); const controller = new AbortController();
  peer.script = async () => { published.resolve(); };
  const options = { signal: controller.signal, timeoutMs: 1000 };
  const pending = sdk.query("hello", options); await published.promise; controller.abort();
  try {
    await assert.rejects(bounded(pending), { name: "AbortError" });
    assert.equal(peer.sent.length, 1); assert.equal(peer.ready, true); assert.equal(peer.disconnects, 0);
    assertClean(peer, controller.signal);
    peer.reply(peer.sent[0], "speak", "late"); peer.reply(peer.sent[0], "hive.query.complete");
    await turn(); assert.equal(peer.sent.length, 1, "cancelled application requests are never replayed");
  } finally { await sdk.close(); await pending.catch(() => undefined); }
});

for (const lateFailure of [false, true]) {
  test(`query cancellation observes an admitted write through late ${lateFailure ? "failure" : "success"}`, async () => {
    const published = deferred(); const release = deferred(); const finished = deferred();
    const peer = new QueryPeer(); const sdk = client(peer); const controller = new AbortController();
    peer.script = async (transport, message) => {
      published.resolve(); await release.promise;
      transport.reply(message, "speak", "late"); transport.reply(message, "hive.query.complete");
      finished.resolve();
      if (lateFailure) throw new Error("synthetic late owned-write failure");
    };
    const options = { signal: controller.signal, timeoutMs: 1000 };
    const pending = sdk.query("hello", options); await published.promise; controller.abort();
    try {
      await assert.rejects(bounded(pending), { name: "AbortError" });
      assertClean(peer, controller.signal); assert.equal(peer.disconnects, 0); assert.equal(peer.ready, true);
      release.resolve(); await finished.promise; await turn();
      assert.equal(peer.sent.length, 1); assertClean(peer, controller.signal);
    } finally { release.resolve(); await sdk.close(); await pending.catch(() => undefined); }
  });
}

for (const terminal of ["hive.query.complete", "hive.policy.denied", "hive.query.timeout"]) {
  for (const abortFirst of [false, true]) {
    test(`query ${abortFirst ? "cancellation precedes" : "preserves"} ${terminal} and a later write error`, async () => {
      const peer = new QueryPeer(); const sdk = client(peer); const controller = new AbortController();
      // Intentionally synchronous: a terminal callback and throw can occur
      // during publication before the returned promise has been observed.
      peer.script = (transport, message) => {
        transport.reply(message, "speak", "partial");
        if (abortFirst) controller.abort();
        transport.reply(message, terminal, undefined, "cascade");
        if (!abortFirst) controller.abort();
        transport.reply(message, "speak", "too late");
        throw new Error("synthetic synchronous post-terminal write failure");
      };
      const options = { signal: controller.signal, timeoutMs: 1000 };
      try {
        const pending = sdk.query("hello", options);
        if (abortFirst) await assert.rejects(bounded(pending), { name: "AbortError" });
        else {
          const reply = await bounded(pending);
          assert.equal(reply.text, "partial"); assert.equal(reply.ok, terminal === "hive.query.complete");
          assert.deepEqual(reply.events.map(event => event.name), ["speak", terminal]);
        }
        assertClean(peer, controller.signal); assert.equal(peer.disconnects, 0);
      } finally { await sdk.close(); }
    });
  }
}

test("cancelling one concurrent query preserves another query and its session metadata", async () => {
  const peer = new QueryPeer(); const sdk = client(peer); const published = deferred(); const controller = new AbortController();
  peer.script = async transport => { if (transport.sent.length === 2) published.resolve(); };
  const options = { signal: controller.signal, timeoutMs: 1000, queryId: "cancelled" };
  const cancelled = sdk.query("first", options);
  const other = sdk.query("second", { timeoutMs: 1000, queryId: "retained", requestId: "request", sessionId: "requested" });
  await published.promise; controller.abort();
  try {
    await assert.rejects(bounded(cancelled), { name: "AbortError" });
    assert.equal(getEventListeners(peer, "query").length, 1);
    peer.reply(peer.sent[0], "speak", "foreign late reply");
    peer.reply(peer.sent[1], "speak", "retained reply", "cascade");
    peer.reply(peer.sent[1], "hive.query.complete", undefined, "cascade");
    const reply = await bounded(other);
    assert.equal(reply.text, "retained reply"); assert.equal(reply.sessionId, "runtime-session"); assert.equal(reply.requestId, "request");
    assert.equal(peer.disconnects, 0); assert.equal(peer.connects, 1); assertClean(peer, controller.signal);
  } finally { await sdk.close(); await cancelled.catch(() => undefined); await other.catch(() => undefined); }
});
