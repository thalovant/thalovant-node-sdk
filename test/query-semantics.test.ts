import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { ThalovantClient } from "../src/client.js";
import { ThalovantRuntimeError, ThalovantTimeoutError } from "../src/errors.js";
import { ThalovantIdentity } from "../src/identity.js";
import type { EventContext } from "../src/events.js";
import type { HiveMessage } from "../src/transport.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class QueryTransport extends EventTarget {
  channel: "query" | "cascade" = "query";
  ready = false;
  sent = 0;
  script: (transport: QueryTransport, message: HiveMessage) => Promise<void> = async () => {};
  async connect() { this.ready = true; }
  async disconnect() { this.ready = false; }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus() {}
  async sendHiveMessage(message: HiveMessage) { this.sent += 1; await this.script(this, message); }
  reply(type: string, text?: string, context: EventContext = {}, queryId = "fixture") {
    this.dispatchEvent(new CustomEvent(this.channel, { detail: { msg_type: this.channel, metadata: { query_id: queryId }, payload: { msg_type: "bus", payload: { type, data: text ? { utterance: text } : {}, context } } } }));
  }
}
function client(transport: QueryTransport) {
  return new ThalovantClient(new ThalovantIdentity({ key: "fixture", password: "fixture", host: "https://fixture.invalid", site: "fixture" }), { transport });
}

test("query consumes routed cascade replies and removes both listeners", async () => {
  const transport = new QueryTransport();
  transport.channel = "cascade";
  transport.script = async peer => { peer.reply("speak", "cascade reply"); peer.reply("hive.query.complete"); };
  const sdk = client(transport);
  try {
    const reply = await sdk.query("query", { queryId: "fixture", timeoutMs: 200, replySettleMs: 0 });
    assert.equal(reply.text, "cascade reply");
    assert.equal(reply.ok, true);
    for (const kind of ["query", "cascade"]) assert.equal(getEventListeners(transport, kind).length, 0);
  } finally { await sdk.close(); }
});

test("query deadline includes held connect and does not send after its expiry", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class HeldConnect extends QueryTransport {
    override async connect() { await gate; this.ready = true; }
  }
  const transport = new HeldConnect();
  const sdk = client(transport);
  const started = performance.now();
  try {
    await assert.rejects(sdk.query("query", { timeoutMs: 25 }), ThalovantTimeoutError);
    assert.ok(performance.now() - started < 250);
    assert.equal(transport.sent, 0);
  } finally {
    release();
    await sdk.close();
  }
  assert.equal(transport.sent, 0);
  assert.equal(transport.ready, false);
});

for (const soft of ["complete_intent_failure", "ovos.intent.unmatched"]) {
  test(`query waits after ${soft}; later speech recovers before completion`, async () => {
    const transport = new QueryTransport();
    transport.script = async peer => {
      peer.reply(soft);
      await sleep(10);
      peer.reply("speak", "fallback reply");
      peer.reply("hive.query.complete");
      peer.reply("speak", "after completion");
    };
    const sdk = client(transport);
    try {
      const reply = await sdk.query("query", { queryId: "fixture", timeoutMs: 200, replySettleMs: 0 });
      assert.equal(reply.text, "fallback reply");
      assert.equal(reply.ok, true);
      assert.equal(reply.failureEvent, undefined);
      assert.deepEqual(reply.events.map(event => event.name), [soft, "speak", "hive.query.complete"]);
      transport.script = async peer => { peer.reply(soft); peer.reply("hive.query.complete"); };
      await assert.rejects(sdk.query("unrecovered", { queryId: "fixture", timeoutMs: 100, replySettleMs: 0 }), ThalovantRuntimeError);
      transport.script = async peer => { peer.reply(soft); };
      await assert.rejects(sdk.query("incomplete", { queryId: "fixture", timeoutMs: 20, replySettleMs: 0 }), ThalovantTimeoutError);
    } finally { await sdk.close(); }
  });
}

for (const hard of ["hive.policy.denied", "hive.query.timeout"]) {
  for (const partial of [false, true]) {
    test(`query freezes ${hard} and ${partial ? "preserves failed partial reply" : "rejects without a reply"}`, async () => {
      const transport = new QueryTransport();
      transport.script = async peer => {
        if (partial) peer.reply("speak", "partial reply");
        peer.reply(hard);
        peer.reply("speak", "too late");
        peer.reply("hive.query.complete");
      };
      const sdk = client(transport);
      try {
        const pending = sdk.query("query", { queryId: "fixture", timeoutMs: 200, replySettleMs: 1000 });
        if (!partial) await assert.rejects(pending, ThalovantRuntimeError);
        else {
          const reply = await pending;
          assert.equal(reply.text, "partial reply");
          assert.equal(reply.ok, false);
          assert.equal(reply.failureEvent?.name, hard);
          assert.deepEqual(reply.events.map(event => event.name), ["speak", hard]);
        }
        assert.equal(getEventListeners(transport, "query").length, 0);
      } finally { await sdk.close(); }
    });
  }
}

test("query caps settling inside its deadline and ignores all post-completion events", async () => {
  const transport = new QueryTransport();
  transport.script = async peer => {
    peer.reply("speak", "complete reply");
    peer.reply("hive.query.complete");
    peer.reply("speak", "late synchronous reply");
    await sleep(10);
    peer.reply("speak", "late asynchronous reply");
  };
  const sdk = client(transport);
  const started = performance.now();
  try {
    const reply = await sdk.query("query", { queryId: "fixture", timeoutMs: 40, replySettleMs: 1000 });
    assert.ok(performance.now() - started < 250);
    assert.equal(reply.text, "complete reply");
    assert.deepEqual(reply.events.map(event => event.name), ["speak", "hive.query.complete"]);
  } finally { await sdk.close(); }
});

for (const terminal of ["hive.query.complete", "hive.policy.denied"]) {
  test(`query preserves ${terminal} when the write rejects after that terminal frame`, async () => {
    class LateWriteFailure extends QueryTransport {
      override sendHiveMessage(): Promise<void> {
        this.reply("speak", "accepted reply");
        this.reply(terminal);
        return Promise.reject(new Error("synthetic post-terminal write failure"));
      }
    }
    const sdk = client(new LateWriteFailure());
    try {
      const reply = await sdk.query("query", { queryId: "fixture", timeoutMs: 200, replySettleMs: 0 });
      assert.equal(reply.text, "accepted reply");
      assert.equal(reply.ok, terminal === "hive.query.complete");
      assert.deepEqual(reply.events.map(event => event.name), ["speak", terminal]);
    } finally { await sdk.close(); }
  });
}


test("query reports the first accepted runtime session with requested fallback", async () => {
  for (const assigned of [undefined, "assigned-by-hub"]) {
    for (const hard of [false, true]) {
      const peer = new QueryTransport(); const sdk = client(peer);
      peer.script = async p => {
        p.reply("speak", "foreign", { session: { session_id: "foreign-session" } }, "other-query");
        p.reply("speak", "first", { session: { session_id: "  " } });
        p.reply("speak", "second", assigned ? { session: { session_id: assigned } } : {});
        p.reply(hard ? "hive.policy.denied" : "hive.query.complete");
        p.reply("speak", "late", { session: { session_id: "too-late" } });
      };
      try {
        const reply = await sdk.query("hello", { queryId: "fixture", sessionId: "requested", requestId: "request", timeoutMs: 200, replySettleMs: 0 });
        assert.equal(reply.sessionId, assigned ?? "requested");
        assert.equal(reply.requestId, "request");
        assert.equal(reply.text, "first second");
        assert.equal(reply.ok, !hard);
        for (const channel of ["query", "cascade"]) assert.equal(getEventListeners(peer, channel).length, 0);
      } finally { await sdk.close(); }
    }
  }
});

test("query completion returns immediately instead of sleeping through an unused settle window", async () => {
  const peer = new QueryTransport(); const sdk = client(peer);
  peer.script = async p => { p.reply("speak", "finished"); p.reply("hive.query.complete"); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      sdk.query("hello", { queryId: "fixture", timeoutMs: 2500, replySettleMs: 2000 }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("completed query waited for an unused settle window")), 500); }),
    ]);
    assert.equal(reply.text, "finished");
    for (const channel of ["query", "cascade"]) assert.equal(getEventListeners(peer, channel).length, 0);
  } finally { clearTimeout(timer); await sdk.close(); }
});
