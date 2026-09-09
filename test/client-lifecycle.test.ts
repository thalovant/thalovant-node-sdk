import assert from "node:assert/strict";
import test from "node:test";
import { ThalovantClient } from "../src/client.js";
import { ThalovantConnectionError, ThalovantTimeoutError } from "../src/errors.js";
import { ThalovantIdentity } from "../src/identity.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class HeldTransport extends EventTarget {
  connects = 0;
  disconnects = 0;
  ready = false;
  connectGate = deferred();
  cleanupGate = deferred();
  async connect(): Promise<void> {
    this.connects += 1;
    if (this.connects === 1) await this.connectGate.promise;
    this.ready = true;
  }
  async disconnect(): Promise<void> {
    this.disconnects += 1;
    if (this.disconnects === 1) await this.cleanupGate.promise;
    this.ready = false;
  }
  healthcheck() { return { connected: this.ready, handshakeComplete: this.ready, transportAlive: this.ready }; }
  async emitBus(): Promise<void> {}
}
function client(transport: HeldTransport) {
  return new ThalovantClient(new ThalovantIdentity({ key: "fixture", password: "fixture", host: "https://fixture.invalid", site: "fixture" }), { transport });
}

test("connect deadline does not await hung cleanup and replacement owns a separate budget", async () => {
  const transport = new HeldTransport();
  const sdk = client(transport);
  try {
    const started = performance.now();
    await assert.rejects(sdk.connect(20), error => error instanceof ThalovantConnectionError && error.cause instanceof ThalovantTimeoutError);
    assert.ok(performance.now() - started < 250, "held cleanup must not extend the connect deadline");
    assert.equal(transport.disconnects, 1);
    await assert.rejects(sdk.connect(20), ThalovantConnectionError);
    assert.equal(transport.connects, 1, "replacement cannot dial while retired work remains");
    transport.connectGate.resolve();
    await sleep(5);
    await assert.rejects(sdk.connect(20), ThalovantConnectionError);
    assert.equal(transport.connects, 1, "late connect completion must not bypass held cleanup");
    transport.cleanupGate.resolve();
    await sdk.connect(200);
    assert.equal(transport.connects, 2);
    assert.equal(sdk.healthcheck().handshakeComplete, true);
  } finally {
    transport.connectGate.resolve();
    transport.cleanupGate.resolve();
    await sdk.close();
  }
});

test("caller budget includes setup and authenticated readiness", async () => {
  class Unready extends HeldTransport {
    override async connect() { this.connects += 1; await sleep(25); }
    override async disconnect() { this.disconnects += 1; }
  }
  const transport = new Unready();
  const sdk = client(transport);
  const started = performance.now();
  await assert.rejects(sdk.connect(50), ThalovantConnectionError);
  assert.ok(performance.now() - started < 150);
  assert.equal(transport.disconnects, 1);
  assert.equal(sdk.healthcheck().handshakeComplete, false);
  await sdk.close();
});

test("lagging readiness settles once and concurrent callers do not duplicate the dial", async () => {
  class Lagging extends HeldTransport {
    override async connect() { this.connects += 1; setTimeout(() => { this.ready = true; }, 20); }
    override async disconnect() { this.disconnects += 1; this.ready = false; }
  }
  const transport = new Lagging();
  const sdk = client(transport);
  await Promise.all([sdk.connect(200), sdk.connect(200)]);
  assert.equal(transport.connects, 1);
  await sdk.connect(100);
  assert.equal(transport.connects, 1);
  await sdk.close();
});

test("close cancels active and queued connects without allowing late readiness", async () => {
  const transport = new HeldTransport();
  const sdk = client(transport);
  const first = assert.rejects(sdk.connect(500), /closed/);
  const queued = assert.rejects(sdk.connect(500), /closed/);
  await sleep(5);
  const closing = sdk.close();
  await first;
  transport.connectGate.resolve();
  transport.cleanupGate.resolve();
  await Promise.all([queued, closing]);
  assert.equal(transport.connects, 1);
  assert.equal(sdk.healthcheck().connected, false);
  await sdk.connect(200);
  assert.equal(transport.connects, 2);
  await sdk.close();
});

test("late connect completion after cleanup is retired before replacement", async () => {
  class Late extends HeldTransport {
    readyBeforeReplacement?: boolean;
    override async connect() {
      if (this.connects > 0) this.readyBeforeReplacement = this.ready;
      await super.connect();
    }
  }
  const transport = new Late();
  const sdk = client(transport);
  transport.cleanupGate.resolve();
  try {
    await assert.rejects(sdk.connect(20), ThalovantConnectionError);
    transport.connectGate.resolve();
    await sdk.connect(200);
    assert.equal(transport.readyBeforeReplacement, false);
  } finally {
    transport.connectGate.resolve();
    await sdk.close();
  }
});


test("close deadline retains actual cleanup and cannot retire a replacement", async () => {
  const transport = new HeldTransport();
  const sdk = client(transport);
  try {
    await assert.rejects(sdk.connect(20), ThalovantConnectionError);
    const started = performance.now();
    await assert.rejects(sdk.close(20), /close did not complete/);
    assert.ok(performance.now() - started < 250);
    let retired = false;
    const actualClose = sdk.waitForClosed().then(() => { retired = true; });
    await assert.rejects(sdk.connect(20), ThalovantConnectionError);
    assert.equal(retired, false);
    assert.equal(transport.connects, 1);
    transport.connectGate.resolve();
    await sleep(5);
    assert.equal(retired, false);
    transport.cleanupGate.resolve();
    await actualClose;
    assert.equal(transport.ready, false);
    await sdk.connect(200);
    assert.equal(transport.connects, 2);
    assert.equal(transport.ready, true);
  } finally {
    transport.connectGate.resolve();
    transport.cleanupGate.resolve();
    await sdk.close();
  }
});

test("waitForClosed preserves a cleanup error after bounded close rejects", async () => {
  class FailedCleanup extends HeldTransport {
    override async disconnect() { throw new Error("synthetic cleanup failure"); }
  }
  const sdk = client(new FailedCleanup());
  await assert.rejects(sdk.close(100), /synthetic cleanup failure/);
  await assert.rejects(sdk.waitForClosed(), /synthetic cleanup failure/);
});
