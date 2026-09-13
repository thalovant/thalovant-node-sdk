import assert from "node:assert/strict";
import test from "node:test";
import {
  HubSession,
  HubSessionPolicy,
  OriginPreference,
  ThalovantSubscription,
  type HubSessionClient,
} from "../src/index.js";
function client() {
  const state = {
    phase: "ready",
    closed: 0,
    asks: [] as string[],
    handlers: 0,
  };
  const value = {
    connectionInfo: () => ({ phase: state.phase }),
    close: async () => {
      state.closed++;
    },
    ask: async (text: string) => {
      state.asks.push(text);
      return { text: "ok" };
    },
    emit: async () => {},
    on: () => {
      state.handlers++;
      return new ThalovantSubscription(() => {
        state.handlers--;
      });
    },
  } as unknown as HubSessionClient;
  return { state, value };
}
test("unattended ladder resets and foreground calls do not wait for it", async () => {
  let now = 100,
    attempts = 0;
  const live = client();
  const session = new HubSession(
    async () => {
      if (++attempts < 3) throw new Error("unavailable");
      return live.value;
    },
    { clock: () => now, warm: false },
  );
  await session.probe();
  assert.equal(session.retryAt, 110);
  assert.equal(session.retryWait, 20);
  now = 105;
  await session.probe();
  assert.equal(attempts, 1);
  now = 110;
  await session.probe();
  assert.equal(session.retryAt, 130);
  assert.equal((await session.ask("hi")).text, "ok");
  assert.equal(session.retryWait, 10);
  await session.close();
});
test("ambiguous Ask and Emit failures are not replayed; subscriptions survive the next rebuild", async () => {
  const dead = client(),
    fresh = client();
  let attempts = 0;
  dead.value.ask = async () => {
    throw new Error("response lost after acceptance");
  };
  const session = new HubSession(
    async () => (++attempts === 1 ? dead.value : fresh.value),
    { warm: false },
  );
  const subscription = session.on("event", () => {});
  await assert.rejects(session.ask("action"));
  assert.equal(attempts, 1);
  assert.equal(dead.state.closed, 1);
  assert.equal((await session.ask("status")).text, "ok");
  assert.equal(fresh.state.handlers, 1);
  subscription.close();
  assert.equal(fresh.state.handlers, 0);
  fresh.value.emit = async () => {
    throw new Error("lost response");
  };
  await assert.rejects(session.emit("action"));
  assert.equal(attempts, 2);
  await session.close();
});
test("close cannot interrupt an admitted call or permit another warm", async () => {
  const live = client();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    pending = new Promise<void>((r) => (release = r));
  live.value.ask = async () => {
    entered();
    await pending;
    assert.equal(live.state.closed, 0);
    return { text: "ok" } as never;
  };
  const session = new HubSession(async () => live.value, { warm: false });
  const call = session.ask("hi");
  await started;
  const close = session.close();
  await session.warm();
  release();
  await call;
  await close;
  assert.equal(live.state.closed, 1);
  await assert.rejects(session.ask("again"));
});
test("failed subscription replay closes the fresh client and backs off", async () => {
  const live = client();
  live.value.on = () => {
    throw new Error("rejected registration");
  };
  const session = new HubSession(async () => live.value, {
    warm: false,
    clock: () => 100,
  });
  session.on("event", () => {});
  await assert.rejects(session.ask("hi"));
  assert.equal(live.state.closed, 1);
  assert.equal(session.retryAt, 110);
  assert.equal(session.held, false);
  await session.close();
});
test("origin preference cools down without touching global DNS", async () => {
  let now = 0;
  const origin = new OriginPreference("127.0.0.2", 1.5, 300, () => now);
  const attempts: unknown[] = [];
  const build = async (options: { address?: string }) => {
    attempts.push(options.address);
    if (options.address) throw new Error("unreachable");
    return "public";
  };
  assert.equal(
    await origin.connect(build, { host: "hub.invalid", connectTimeout: 6 }),
    "public",
  );
  await origin.connect(build, { host: "hub.invalid", connectTimeout: 6 });
  assert.deepEqual(attempts, ["127.0.0.2", undefined, undefined]);
  now = 301;
  assert.equal(origin.coolingDown, false);
  assert.throws(() => new HubSessionPolicy(0));
});

test("cancelled preferred-origin attempts never fall back", async () => {
  const origin = new OriginPreference("127.0.0.2");
  let attempts = 0;
  await assert.rejects(
    origin.connect(
      async () => {
        attempts++;
        throw new DOMException("Cancelled", "AbortError");
      },
      { host: "hub.invalid", connectTimeout: 6 },
    ),
    { name: "AbortError" },
  );
  assert.equal(attempts, 1);
  assert.equal(origin.coolingDown, false);
});

test("cross-realm cancellation cannot start a public fallback", async () => {
  const { runInNewContext } = await import("node:vm");
  const cancelled = runInNewContext(
    "Object.assign(new Error('cancelled'), { name: 'AbortError' })",
  );
  assert.equal(cancelled instanceof Error, false);
  const origin = new OriginPreference("127.0.0.2");
  let attempts = 0;
  await assert.rejects(
    origin.connect(
      async () => {
        attempts++;
        throw cancelled;
      },
      { host: "hub.invalid", connectTimeout: 6 },
    ),
    (error) => error === cancelled,
  );
  assert.equal(attempts, 1);
  assert.equal(origin.coolingDown, false);
});
