/**
 * Intercom: `/v1/hubs/{hub_id}/intercom` through the control plane, against a
 * loopback fake API (a real HTTP server on 127.0.0.1).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  DELIVERY_DETAIL_CODES,
  INTERCOM_READ_SCOPE,
  INTERCOM_SEND_SCOPE,
  INTERCOM_URGENT_SCOPE,
  IntercomProblemCode,
  ThalovantApiError,
  ThalovantAuthError,
  ThalovantControlPlane,
  ThalovantHubLockedError,
  ThalovantHubUnreachableError,
  ThalovantImpersonationNotAllowedError,
  ThalovantIntercomDisabledError,
  ThalovantIntercomNotConfiguredError,
  ThalovantIntercomPlatformDisabledError,
  ThalovantIntercomUnavailableError,
  ThalovantManagedClientError,
  ThalovantNotASpeakerError,
  ThalovantNotCancellableError,
  ThalovantPlanError,
  ThalovantRateLimitedError,
  ThalovantReservedNameError,
  ThalovantSkillNotInstalledError,
  ThalovantTooManyTargetsError,
  ThalovantUrgentBusyError,
  ThalovantUrgentScopeRequiredError,
  announcementText,
  type AnnouncementStatus,
  type IntercomUnavailableReason,
} from "../src/index.js";
import { announceBody, idempotencyKey, intercomId, speakerUpdateBody } from "../src/intercom.js";

const HUB = "0f8a7c3e-2b1d-4c5e-9a6f-1d2c3b4a5e6f";
const ANN = "7a1d6c1e-6f0b-4f43-9d7e-3f4f0d9a7c11";
const BASE = `/v1/hubs/${HUB}/intercom`;

interface Seen { method: string; path: string; query: string; headers: IncomingMessage["headers"]; body: any }
type Reply = [number, unknown, Record<string, string>?];

function announcement(status = "completed", extra: Record<string, unknown> = {}) {
  return {
    id: ANN, status, priority: "normal", created_at: "2026-11-11T10:00:00Z",
    deliveries: [
      { client_id: "c1", slug: "kitchen", name: "Kitchen", status: "delivered", at: "2026-11-11T10:00:01Z" },
      { client_id: "c2", slug: "den", name: "Den", status: "brand_new_status", at: null },
    ],
    acked_by: null, ...extra,
  };
}

async function fakeApi() {
  const seen: Seen[] = [];
  const replies = new Map<string, Reply[]>();
  const delays = new Map<string, number>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const [path, query = ""] = (req.url ?? "").split("?");
      seen.push({ method: req.method ?? "", path, query, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const queue = replies.get(`${req.method} ${path}`) ?? [];
      const [status, body, headers] = (queue.length > 1 ? queue.shift() : queue[0]) ?? [404, { detail: "nope" }];
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
        res.end(JSON.stringify(body));
      }, delays.get(`${req.method} ${path}`) ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    seen,
    api: new ThalovantControlPlane(url, { accessToken: "tok" }),
    reply: (method: string, path: string, ...queue: Reply[]) => { replies.set(`${method} ${path}`, queue); },
    delay: (method: string, path: string, ms: number) => { delays.set(`${method} ${path}`, ms); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

test("announce sends the contract body and reads deliveries (open statuses kept)", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [200, announcement()]);
    const result = await fake.api.announce(HUB, { text: "  Dinner is ready  ", targets: { rooms: ["kitchen"] }, lang: "en-US" });
    assert.deepEqual(fake.seen[0].body, { text: "Dinner is ready", targets: { rooms: ["kitchen"] }, priority: "normal", lang: "en-US" });
    assert.equal(fake.seen[0].headers.authorization, "Bearer tok");
    assert.equal(fake.seen[0].headers["idempotency-key"], undefined);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.deliveries.map((d) => d.status), ["delivered", "brand_new_status"]);
    assert.equal(result.acked_by, null);
  } finally { await fake.close(); }
});

test("urgent announce sends repeat and an idempotency key; wait polls until completed", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("sending")], [200, announcement("completed", { acked_by: "Den" })]);
    const result = await fake.api.announce(HUB, {
      text: "Wake up", targets: { all: true }, priority: "urgent",
      repeat: { times: 2, interval_seconds: 5 }, idempotencyKey: "key-1", wait: true, pollIntervalMs: 5,
    });
    assert.deepEqual(fake.seen[0].body.repeat, { times: 2, interval_seconds: 5 });
    assert.equal(fake.seen[0].headers["idempotency-key"], "key-1");
    assert.equal(result.status, "completed");
    assert.equal(result.acked_by, "Den");
    assert.equal(fake.seen.filter((s) => s.method === "GET").length, 2);
  } finally { await fake.close(); }
});

test("wait timeout returns the latest answer, still sending", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("sending")]);
    const result = await fake.api.announce(HUB, {
      text: "x", targets: { groups: ["kids"] }, priority: "urgent", repeat: { times: 1, interval_seconds: 5 },
      wait: true, waitTimeoutMs: 40, pollIntervalMs: 5,
    });
    assert.equal(result.status, "sending");
  } finally { await fake.close(); }
});

test("get and list announcements", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement()]);
    fake.reply("GET", `${BASE}/announcements`, [200, { items: [announcement()], next_cursor: "c2" }]);
    assert.equal((await fake.api.getAnnouncement(HUB, ANN)).id, ANN);
    const page = await fake.api.listAnnouncements(HUB, { limit: 5, cursor: "c 1" });
    assert.equal(page.next_cursor, "c2");
    assert.equal(page.items.length, 1);
    assert.equal(new URLSearchParams(fake.seen.at(-1)!.query).get("cursor"), "c 1");
    assert.equal(new URLSearchParams(fake.seen.at(-1)!.query).get("limit"), "5");
    fake.reply("GET", `${BASE}/announcements`, [200, { items: [] }]);
    assert.equal((await fake.api.listAnnouncements(HUB)).next_cursor, null);
  } finally { await fake.close(); }
});

test("speakers; the patch sends only what is passed", async () => {
  const fake = await fakeApi();
  try {
    const speaker = {
      client_id: "c-1", slug: "kitchen", name: "Kitchen", online: true, last_seen_at: null,
      intercom: { receive: true, room: "kitchen", groups: ["downstairs"],
        dnd: { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: null } } },
    };
    fake.reply("GET", `${BASE}/speakers`, [200, { items: [speaker] }]);
    fake.reply("PATCH", `${BASE}/speakers/c-1`, [200, speaker]);
    const listed = await fake.api.listIntercomSpeakers(HUB);
    assert.equal(listed.items[0].online, true);
    assert.deepEqual(listed.items[0].intercom.dnd.quiet_hours, { start: "22:00", end: "07:00", timezone: null });
    await fake.api.updateIntercomSpeaker(HUB, "c-1", { room: null, receive: true });
    assert.equal(fake.seen.at(-1)!.path, `${BASE}/speakers/c-1`);
    assert.deepEqual(fake.seen.at(-1)!.body, { receive: true, room: null });
    await fake.api.updateIntercomSpeaker(HUB, "c-1", { dnd: { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: "Europe/Paris" } } });
    assert.equal(fake.seen.at(-1)!.body.dnd.quiet_hours.timezone, "Europe/Paris");
  } finally { await fake.close(); }
});

test("settings, and an id is one percent-encoded path segment", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/settings`, [200, { enabled: false, plan_allowed: false, unavailable_reason: "plan" }]);
    fake.reply("PUT", `${BASE}/settings`, [200, { enabled: true, plan_allowed: true, unavailable_reason: null }]);
    fake.reply("GET", "/v1/hubs/a%20b%25c/intercom/settings", [200, { enabled: false, plan_allowed: true }]);
    assert.equal((await fake.api.getIntercomSettings(HUB)).unavailable_reason, "plan");
    assert.equal((await fake.api.setIntercomSettings(HUB, true)).enabled, true);
    assert.deepEqual(fake.seen.at(-1)!.body, { enabled: true });
    assert.equal((await fake.api.getIntercomSettings("a b%c")).plan_allowed, true);
    assert.equal(fake.seen.at(-1)!.path, "/v1/hubs/a%20b%25c/intercom/settings");
  } finally { await fake.close(); }
});

const errorCases: Array<[number, Record<string, unknown>, Record<string, string>, new (...a: any[]) => ThalovantApiError]> = [
  [403, { code: "intercom_disabled", detail: "off" }, {}, ThalovantIntercomDisabledError],
  [422, { code: "intercom_disabled", detail: "kid hub" }, {}, ThalovantIntercomDisabledError],
  [502, { code: "hub_unreachable", detail: "no hub" }, {}, ThalovantHubUnreachableError],
  [429, { code: "rate_limited", detail: "slow" }, { "Retry-After": "30" }, ThalovantRateLimitedError],
  [403, { code: "plan_limit", detail: "plan" }, {}, ThalovantPlanError],
  [402, { detail: "API access requires a paid plan." }, {}, ThalovantPlanError],
  [403, { detail: "Insufficient scopes" }, {}, ThalovantAuthError],
  [422, { code: "validation", detail: "bad" }, {}, ThalovantApiError],
];
for (const [status, body, headers, kind] of errorCases) {
  test(`errors are typed: ${status} ${String(body.code ?? body.detail)}`, async () => {
    const fake = await fakeApi();
    try {
      fake.reply("POST", `${BASE}/announce`, [status, body, headers]);
      await assert.rejects(fake.api.announce(HUB, { text: "hello", targets: { all: true } }), (error: any) => {
        assert.equal(error.constructor, kind);
        assert.equal(error.statusCode, status);
        if ("code" in body) assert.equal(error.code, body.code);
        if (status === 429) assert.equal(error.retryAfterSeconds, 30);
        return true;
      });
    } finally { await fake.close(); }
  });
}

test("nothing is sent for invalid input", async () => {
  const fake = await fakeApi();
  try {
    const all = { all: true } as const;
    const bad: Array<[string, any]> = [
      ["", all], ["   ", all], ["x".repeat(281), all], ["a\u0007b", all], ["a\u2028b", all],
      ["hi", {}], ["hi", { all: true, rooms: ["a"] }], ["hi", { nobody: ["a"] }], ["hi", { speakers: [] }],
      ["hi", { speakers: Array.from({ length: 51 }, (_, i) => `s${i}`) }],
    ];
    for (const [text, targets] of bad) await assert.rejects(fake.api.announce(HUB, { text, targets }));
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: all, repeat: { times: 2, interval_seconds: 10 } }));
    for (const repeat of [{ times: 0, interval_seconds: 10 }, { times: 11, interval_seconds: 10 }, { times: 2, interval_seconds: 4 }, { times: 2, interval_seconds: 121 }]) {
      await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: all, priority: "urgent", repeat }));
    }
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: all, priority: "loud" as any }));
    await assert.rejects(fake.api.announce("  ", { text: "hi", targets: all }));
    await assert.rejects(fake.api.getAnnouncement(HUB, ""));
    await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", {}));
    await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", { dnd: { enabled: true, quiet_hours: { start: "25:00", end: "07:00", timezone: null } } }));
    await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", { groups: Array(9).fill("g") }));
    await assert.rejects(fake.api.setIntercomSettings(HUB, "yes" as any));
    assert.equal(fake.seen.length, 0);
  } finally { await fake.close(); }
});

const URGENT = { text: "x", targets: { all: true }, priority: "urgent", repeat: { times: 1, interval_seconds: 5 }, wait: true } as const;

test("a bad waitTimeoutMs or pollIntervalMs is refused before the POST", async () => {
  const fake = await fakeApi();
  try {
    for (const waitTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, "5" as any, true as any, null as any]) {
      await assert.rejects(fake.api.announce(HUB, { ...URGENT, waitTimeoutMs }), /waitTimeoutMs/);
    }
    for (const pollIntervalMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, "2" as any, true as any]) {
      await assert.rejects(fake.api.announce(HUB, { ...URGENT, pollIntervalMs }), /pollIntervalMs/);
    }
    assert.equal(fake.seen.length, 0); // nothing was announced
  } finally { await fake.close(); }
});

test("a zero waitTimeoutMs returns the sending answer without polling", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    const result = await fake.api.announce(HUB, { ...URGENT, waitTimeoutMs: 0 });
    assert.equal(result.status, "sending");
    assert.deepEqual(fake.seen.map((s) => s.method), ["POST"]);
  } finally { await fake.close(); }
});

test("the wait deadline bounds a stalled status read", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("completed")]);
    fake.delay("GET", `${BASE}/announcements/${ANN}`, 5000); // a read that never answers in time
    const started = performance.now();
    const result = await fake.api.announce(HUB, { ...URGENT, waitTimeoutMs: 300, pollIntervalMs: 10 });
    assert.equal(result.status, "sending"); // the latest answer: not an error, not a hang
    assert.equal(result.id, ANN);
    assert.ok(performance.now() - started < 3000);
  } finally { await fake.close(); }
});

test("no read starts once the deadline passed during the sleep", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("completed")]);
    const started = performance.now();
    const result = await fake.api.announce(HUB, { ...URGENT, waitTimeoutMs: 40, pollIntervalMs: 30_000 });
    assert.equal(result.status, "sending"); // the sleep was cut to the deadline, and no read followed
    assert.deepEqual(fake.seen.map((s) => s.method), ["POST"]);
    assert.ok(performance.now() - started < 3000);
  } finally { await fake.close(); }
});

test("an abort cancels the polling sleep at once", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);
    const started = performance.now();
    await assert.rejects(
      fake.api.announce(HUB, { ...URGENT, waitTimeoutMs: 120_000, pollIntervalMs: 60_000, signal: controller.signal }),
      (error: any) => error.name === "AbortError",
    );
    assert.ok(performance.now() - started < 3000); // not the 60 s sleep
    assert.deepEqual(fake.seen.map((s) => s.method), ["POST"]);
  } finally { await fake.close(); }
});

test("an abort during a status read rejects with AbortError, not the latest answer", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("completed")]);
    fake.delay("GET", `${BASE}/announcements/${ANN}`, 5000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(
      fake.api.announce(HUB, { ...URGENT, waitTimeoutMs: 120_000, pollIntervalMs: 10, signal: controller.signal }),
      (error: any) => error.name === "AbortError",
    );
  } finally { await fake.close(); }
});

test("a failed poll rejects after the POST was accepted (the key is how to retry)", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" })]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [403, { detail: "Insufficient scopes" }]);
    await assert.rejects(
      fake.api.announce(HUB, { ...URGENT, idempotencyKey: "k-1", pollIntervalMs: 5 }),
      (error: any) => error instanceof ThalovantAuthError && error.statusCode === 403,
    );
    assert.deepEqual(fake.seen.map((s) => s.method), ["POST", "GET"]);
    assert.equal(fake.seen[0].headers["idempotency-key"], "k-1");
  } finally { await fake.close(); }
});

test("scalar or wrong-typed targets are refused, never split into characters", async () => {
  const fake = await fakeApi();
  try {
    const bad: any[] = [
      { speakers: "ab" }, { rooms: "kitchen" }, { groups: "kids" }, { speakers: 5 }, { speakers: { a: 1 } },
      { speakers: ["a", 3] }, { speakers: new Set(["a"]) }, { all: "yes" }, { all: 1 },
      { all: "true", speakers: ["a"] },
    ];
    for (const targets of bad) {
      await assert.rejects(fake.api.announce(HUB, { text: "hi", targets }), /targets|names|non-empty|exactly one/);
    }
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { speakers: "ab" } as any }), TypeError);
    assert.equal(fake.seen.length, 0);
  } finally { await fake.close(); }
});

test("targets accept real arrays of names", () => {
  assert.deepEqual(announceBody({ text: "hi", targets: { speakers: ["ab"] } }).targets, { speakers: ["ab"] });
  assert.deepEqual(announceBody({ text: "hi", targets: { rooms: ["a", "b"] } }).targets, { rooms: ["a", "b"] });
  assert.deepEqual(announceBody({ text: "hi", targets: { all: true } }).targets, { all: true });
});

test("an invalid dnd.enabled is refused, never turned into false", async () => {
  const fake = await fakeApi();
  try {
    const bad: any[] = [
      { enabled: "true" }, { enabled: "false" }, { enabled: 1 }, { enabled: 0 }, { enabled: null }, {}, // missing: never stored as false
      { quiet_hours: { start: "22:00", end: "07:00", timezone: null } }, null, "yes",
    ];
    for (const dnd of bad) await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", { dnd }), TypeError);
    assert.equal(fake.seen.length, 0);
  } finally { await fake.close(); }
});

test("dnd with a real boolean is sent as given", () => {
  assert.deepEqual(speakerUpdateBody({ dnd: { enabled: false } }).dnd, { enabled: false });
  assert.deepEqual(
    speakerUpdateBody({ dnd: { enabled: true, quiet_hours: { start: "21:00", end: "06:30", timezone: "America/Toronto" } } }).dnd,
    { enabled: true, quiet_hours: { start: "21:00", end: "06:30", timezone: "America/Toronto" } },
  );
  // Switched off, a window and a null zone are fine (the API stores them as they are).
  assert.deepEqual(
    speakerUpdateBody({ dnd: { enabled: false, quiet_hours: { start: "21:00", end: "06:30", timezone: null } } }).dnd,
    { enabled: false, quiet_hours: { start: "21:00", end: "06:30", timezone: null } },
  );
});

test("body builders", () => {
  assert.deepEqual(announceBody({ text: "hi", targets: { speakers: ["a", "b"] } }).targets, { speakers: ["a", "b"] });
  assert.equal(speakerUpdateBody({ room: "x".repeat(64) }).room, "x".repeat(64));
  assert.throws(() => speakerUpdateBody({ room: "x".repeat(65) }));
  // 280 code points, not UTF-16 units.
  assert.doesNotThrow(() => announceBody({ text: "\u{1F600}".repeat(280), targets: { all: true } }));
});

test("malformed answers are API errors", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [200, { status: "completed" }]);
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { all: true } }), ThalovantApiError);
    fake.reply("GET", `${BASE}/announcements`, [200, { nope: 1 }]);
    await assert.rejects(fake.api.listAnnouncements(HUB), ThalovantApiError);
  } finally { await fake.close(); }
});


// --- Amendment 2: cancel, replay, ids, the 502 announcement id, doc rules ---------------------------------

const UNSAFE_IDS = [".", "..", "", "   ", "a/b", "/", "a?b", "a#b", "a\\b", "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b", "../x", "x/.."];

test("dot segments and unsafe ids are refused before any request (hub, client, announcement)", async () => {
  const fake = await fakeApi();
  try {
    for (const bad of UNSAFE_IDS) {
      const calls: Array<() => Promise<unknown>> = [
        () => fake.api.getIntercomSettings(bad),
        () => fake.api.setIntercomSettings(bad, true),
        () => fake.api.listIntercomSpeakers(bad),
        () => fake.api.updateIntercomSpeaker(bad, "c1", { receive: true }),
        () => fake.api.updateIntercomSpeaker(HUB, bad, { receive: true }),
        () => fake.api.announce(bad, { text: "hi", targets: { all: true } }),
        () => fake.api.getAnnouncement(bad, ANN),
        () => fake.api.getAnnouncement(HUB, bad),
        () => fake.api.cancelAnnouncement(bad, ANN),
        () => fake.api.cancelAnnouncement(HUB, bad),
        () => fake.api.listAnnouncements(bad),
      ];
      for (const call of calls) await assert.rejects(call(), (error) => error instanceof TypeError || error instanceof RangeError, JSON.stringify(bad));
    }
    assert.equal(fake.seen.length, 0);
  } finally { await fake.close(); }
});

test("ordinary ids pass the id check", () => {
  for (const good of [HUB, ANN, "client-1", "c_1", "a.b", "...", "a..b", ".hidden", "name with space", "x".repeat(200)]) {
    assert.equal(intercomId(good, "id"), good);
  }
  for (const bad of [null, 5, {}, ["a"], undefined]) assert.throws(() => intercomId(bad, "id"), TypeError);
});

test("cancel posts to the cancel route and reads hub_confirmed", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [200, announcement("cancelled", { priority: "urgent", hub_confirmed: true })]);
    const result = await fake.api.cancelAnnouncement(HUB, ANN);
    const request = fake.seen[0];
    assert.equal(request.method, "POST");
    assert.equal(request.path, `${BASE}/announcements/${ANN}/cancel`);
    assert.equal(request.body, null); // no body: the id in the path is all the API needs
    assert.equal(request.headers.authorization, "Bearer tok");
    assert.equal(result.status, "cancelled");
    assert.equal(result.priority, "urgent");
    assert.equal(result.hub_confirmed, true);
    const status: AnnouncementStatus = "cancelled"; // part of the status type
    assert.equal(status, result.status);
  } finally { await fake.close(); }
});

for (const [sent, expected] of [[false, false], [true, true], ["yes", undefined], [1, undefined], [null, undefined]] as const) {
  test(`hub_confirmed is a real boolean or absent: ${JSON.stringify(sent)}`, async () => {
    const fake = await fakeApi();
    try {
      fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [200, announcement("cancelled", { hub_confirmed: sent })]);
      const result = await fake.api.cancelAnnouncement(HUB, ANN);
      assert.equal(result.hub_confirmed, expected);
      assert.equal("hub_confirmed" in result, expected !== undefined);
    } finally { await fake.close(); }
  });
}

test("hub_confirmed is optional on every other answer", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement()]);
    const got = await fake.api.getAnnouncement(HUB, ANN);
    assert.equal(got.hub_confirmed, undefined);
  } finally { await fake.close(); }
});

test("a cancel the hub could not confirm is still a cancelled announcement", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [200, announcement("cancelled", { hub_confirmed: false })]);
    const result = await fake.api.cancelAnnouncement(HUB, ANN);
    assert.equal(result.status, "cancelled");
    assert.equal(result.hub_confirmed, false);
  } finally { await fake.close(); }
});

test("cancel of a finished announcement is a typed 409 not_cancellable", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [409, { code: "not_cancellable", detail: "It already completed." }]);
    await assert.rejects(fake.api.cancelAnnouncement(HUB, ANN), (error: any) => {
      assert.equal(error.constructor, ThalovantNotCancellableError);
      assert.ok(error instanceof ThalovantApiError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, "not_cancellable");
      return true;
    });
    fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [409, { code: "something_else", detail: "no" }]);
    await assert.rejects(fake.api.cancelAnnouncement(HUB, ANN), (error: any) => error.constructor === ThalovantApiError);
  } finally { await fake.close(); }
});

test("cancel without the scope is an auth error", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [403, { detail: "Insufficient scopes" }]);
    await assert.rejects(fake.api.cancelAnnouncement(HUB, ANN), ThalovantAuthError);
  } finally { await fake.close(); }
});

test("a 502 names the announcement the API recorded", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [502, { code: "hub_unreachable", detail: "no hub", announcement_id: ANN }]);
    await assert.rejects(fake.api.announce(HUB, { text: "hello", targets: { all: true }, idempotencyKey: "k-1" }), (error: any) => {
      assert.ok(error instanceof ThalovantHubUnreachableError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.announcementId, ANN);
      assert.equal(error.problem?.announcement_id, ANN);
      return true;
    });
    // FastAPI's envelope keeps the members inside `detail`.
    fake.reply("POST", `${BASE}/announce`, [502, { detail: { code: "hub_unreachable", detail: "no hub", announcement_id: ANN } }]);
    await assert.rejects(fake.api.announce(HUB, { text: "hello", targets: { all: true } }), (error: any) => error.announcementId === ANN);
    for (const body of [{ code: "hub_unreachable", detail: "x" }, { code: "hub_unreachable", detail: "x", announcement_id: 7 }, { code: "hub_unreachable", detail: "x", announcement_id: "" }]) {
      fake.reply("POST", `${BASE}/announce`, [502, body]);
      await assert.rejects(fake.api.announce(HUB, { text: "hello", targets: { all: true } }), (error: any) => error.announcementId === undefined);
    }
    assert.equal(new ThalovantHubUnreachableError("x").announcementId, undefined);
  } finally { await fake.close(); }
});

test("a replayed failed announcement is returned as failed and the key is sent each time", async () => {
  // The API replays the stored announcement for the same (hub, key) with Idempotency-Replayed: true and
  // never sends again: a replayed `failed` stays `failed`; the SDK neither rejects nor retries.
  const fake = await fakeApi();
  try {
    const key = "11111111-1111-4111-8111-111111111111";
    fake.reply("POST", `${BASE}/announce`, [200, announcement("failed"), { "Idempotency-Replayed": "true" }]);
    const first = await fake.api.announce(HUB, { text: "Dinner is ready", targets: { all: true }, idempotencyKey: key });
    const again = await fake.api.announce(HUB, { text: "Dinner is ready", targets: { all: true }, idempotencyKey: key });
    assert.equal(first.status, "failed");
    assert.equal(again.status, "failed");
    assert.deepEqual(fake.seen.map((r) => r.headers["idempotency-key"]), [key, key]);
    assert.equal(fake.seen.length, 2); // one POST per call: nothing is retried behind the caller's back
  } finally { await fake.close(); }
});

const ROOT = new URL("../../", import.meta.url);
const DOCS = ["README.md", "QUICK_FACTS.md", "FAQ.md"].map((name) => ({ name, text: readFileSync(new URL(name, ROOT), "utf8") }));

test("no README or doc example uses a constant idempotency key", () => {
  // A fixed key replays the stored announcement for 24 hours and sends nothing: examples generate a fresh one.
  const offenders: string[] = [];
  for (const { name, text } of DOCS) {
    text.split("\n").forEach((line, index) => {
      if (/idempotencyKey\s*:\s*["'`]/.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the intercom docs do not over-promise and describe the controls", () => {
  const readme = DOCS[0].text.toLowerCase();
  for (const { text } of DOCS) {
    const lowered = text.toLowerCase();
    for (const phrase of ["nothing listens", "never listens", "spoken once", "stops every announcement at once", "retry with the same", "no two-way audio, nothing"]) {
      assert.ok(!lowered.includes(phrase), phrase);
    }
  }
  for (const word of ["randomuuid", "idempotency-replayed", "cancelannouncement", "new key", "announcementid"]) assert.ok(readme.includes(word), word);
});

// ---------------------------------------------------------------------------
// The final API (platform security review): scope, speaker model, problem codes, one validation rule.
// ---------------------------------------------------------------------------

const SPEAKER_DND = { enabled: false, quiet_hours: { start: "22:00", end: "07:00", timezone: null } };

function speakerRow(extra: Record<string, unknown> = {}) {
  return {
    client_id: "d8d4", slug: "kitchen-speaker", name: "Kitchen Speaker", kind: "voice_satellite", can_play: true,
    online: false, last_seen_at: null,
    intercom: { receive: true, room: "kitchen", groups: [], dnd: SPEAKER_DND }, ...extra,
  };
}

test("the speaker list reads kind, can_play and policy_synced", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/speakers`, [200, {
      items: [speakerRow(), speakerRow({ client_id: "996f", slug: "home-link", name: "Home link", kind: "home_assistant", can_play: false,
        intercom: { receive: false, room: null, groups: [], dnd: SPEAKER_DND } })],
      unavailable_reason: null, policy_synced: false,
    }]);
    const listed = await fake.api.listIntercomSpeakers(HUB);
    assert.equal(listed.policy_synced, false);
    assert.equal(listed.unavailable_reason, null);
    const [kitchen, link] = listed.items;
    assert.deepEqual([kitchen.kind, kitchen.can_play, kitchen.policy_synced], ["voice_satellite", true, null]);
    assert.deepEqual([link.kind, link.can_play], ["home_assistant", false]);
  } finally { await fake.close(); }
});

test("a speaker without the new fields keeps the API's defaults, and garbage is not trusted", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/speakers`, [200, { items: [{ client_id: "c1" }] }]);
    const only = await fake.api.listIntercomSpeakers(HUB);
    assert.deepEqual([only.items[0].kind, only.items[0].can_play], ["voice_satellite", true]);
    assert.deepEqual([only.policy_synced, only.unavailable_reason], [null, null]);
    fake.reply("GET", `${BASE}/speakers`, [200, { items: [{ client_id: "c1", kind: 7, can_play: "no", policy_synced: "yes" }] }]);
    const odd = (await fake.api.listIntercomSpeakers(HUB)).items[0];
    assert.deepEqual([odd.kind, odd.can_play, odd.policy_synced], ["voice_satellite", true, null]);
  } finally { await fake.close(); }
});

test("the speaker patch answer carries its own policy_synced", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("PATCH", `${BASE}/speakers/d8d4`, [200, speakerRow({ policy_synced: false })]);
    assert.equal((await fake.api.updateIntercomSpeaker(HUB, "d8d4", { receive: true })).policy_synced, false);
    fake.reply("PATCH", `${BASE}/speakers/d8d4`, [200, speakerRow({ policy_synced: true })]);
    assert.equal((await fake.api.updateIntercomSpeaker(HUB, "d8d4", { room: "kitchen" })).policy_synced, true);
  } finally { await fake.close(); }
});

test("the platform reason is an unavailable reason", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/settings`, [200, { enabled: false, plan_allowed: true, unavailable_reason: "platform" }]);
    fake.reply("GET", `${BASE}/speakers`, [200, { items: [], unavailable_reason: "platform", policy_synced: true }]);
    assert.equal((await fake.api.getIntercomSettings(HUB)).unavailable_reason, "platform");
    assert.equal((await fake.api.listIntercomSpeakers(HUB)).unavailable_reason, "platform");
    const reason: IntercomUnavailableReason = "platform";
    assert.equal(reason, "platform");
  } finally { await fake.close(); }
});

test("a delivery keeps its detail code", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("failed", { deliveries: [
      { client_id: "c1", slug: "k", name: "K", status: "failed", detail: "hub_no_response", at: null },
      { client_id: "c2", slug: "d", name: "D", status: "delivered", detail: null, at: null },
      { client_id: "c3", slug: "e", name: "E", status: "failed", detail: "a_code_from_the_future", at: null },
    ] })]);
    const result = await fake.api.getAnnouncement(HUB, ANN);
    assert.deepEqual(result.deliveries.map((d) => d.detail), ["hub_no_response", null, "a_code_from_the_future"]);
    assert.ok(DELIVERY_DETAIL_CODES.has("hub_no_response") && !DELIVERY_DETAIL_CODES.has("a_code_from_the_future"));
  } finally { await fake.close(); }
});

test("the scope names are constants", () => {
  assert.deepEqual([INTERCOM_READ_SCOPE, INTERCOM_SEND_SCOPE, INTERCOM_URGENT_SCOPE], ["intercom:read", "intercom:send", "intercom:urgent"]);
});

// -- announce: replayed -------------------------------------------------------------------------

test("a replayed announcement says so and a first answer does not", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [200, announcement()]);
    assert.equal((await fake.api.announce(HUB, { text: "Dinner", targets: { all: true }, idempotencyKey: "k-1" })).replayed, false);
    fake.reply("POST", `${BASE}/announce`, [200, announcement(), { "Idempotency-Replayed": "true" }]);
    const again = await fake.api.announce(HUB, { text: "Dinner", targets: { all: true }, idempotencyKey: "k-1" });
    assert.equal(again.replayed, true);
    assert.equal(again.status, "completed");
  } finally { await fake.close(); }
});

test("the replayed header is read in any case and only when true", async () => {
  const fake = await fakeApi();
  try {
    for (const [name, value, expected] of [["idempotency-replayed", "TRUE", true], ["Idempotency-Replayed", "false", false], ["Idempotency-Replayed", "1", false]] as const) {
      fake.reply("POST", `${BASE}/announce`, [200, announcement(), { [name]: value }]);
      assert.equal((await fake.api.announce(HUB, { text: "Dinner", targets: { all: true } })).replayed, expected);
    }
  } finally { await fake.close(); }
});

test("a replayed sending announcement stays replayed after wait; reads and cancel never are", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [202, announcement("sending", { priority: "urgent" }), { "Idempotency-Replayed": "true" }]);
    fake.reply("GET", `${BASE}/announcements/${ANN}`, [200, announcement("completed", { priority: "urgent" }), { "Idempotency-Replayed": "true" }]);
    const result = await fake.api.announce(HUB, {
      text: "Wake up", targets: { all: true }, priority: "urgent", repeat: { times: 2, interval_seconds: 5 },
      idempotencyKey: "k-2", wait: true, pollIntervalMs: 5,
    });
    assert.deepEqual([result.status, result.replayed], ["completed", true]);
    assert.equal((await fake.api.getAnnouncement(HUB, ANN)).replayed, false);
  } finally { await fake.close(); }
});

test("an idempotency key is at most 128 printable ASCII characters", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [200, announcement()]);
    await fake.api.announce(HUB, { text: "hi", targets: { all: true }, idempotencyKey: "k".repeat(128) });
    assert.equal(String(fake.seen[0].headers["idempotency-key"]).length, 128);
    for (const bad of ["k".repeat(129), "caf\u00e9", "a\r\nb", "", "   ", 7 as unknown as string]) {
      await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { all: true }, idempotencyKey: bad }), (e: unknown) => e instanceof TypeError || e instanceof RangeError);
    }
    assert.equal(fake.seen.length, 1);
    assert.match(idempotencyKey("0f8a7c3e-2b1d-4c5e-9a6f-1d2c3b4a5e6f"), /^0f8a/);
  } finally { await fake.close(); }
});

// -- the one text rule ----------------------------------------------------------------------------

const REFUSED_TEXT = [
  "a<b", "a>b", "<prosody>x</prosody>", "line\nbreak", "tab\there", "nul\u0000 x", "bell\u0007 x", "c1 \u0085 next", "del\u007f x",
  "bidi \u202e override", "isolate \u2066 x", "zero width \u200b space", "bom \ufeff x", "word joiner \u2060 x",
  "tag \u{e0041} x", "private \ue000 x", "line \u2028 sep", "para \u2029 sep", "lone \ud800 surrogate", "lone \udc00 low",
];

test("a text the API would refuse is refused first and never echoed", async () => {
  const fake = await fakeApi();
  try {
    for (const text of REFUSED_TEXT) {
      await assert.rejects(fake.api.announce(HUB, { text, targets: { all: true } }), (error: unknown) => {
        assert.ok(error instanceof RangeError, JSON.stringify(text));
        assert.ok(!error.message.includes(text.trim()), "the error echoed the text");
        return true;
      });
    }
    assert.equal(fake.seen.length, 0);
  } finally { await fake.close(); }
});

test("a text the API accepts is sent", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [200, announcement()]);
    const accepted = [
      "Dinner is ready", "Caf\u00e9 cr\u00e8me", "\u00ab bonjour \u00bb", "family \u{1F468}\u200d\u{1F469}\u200d\u{1F467}",
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "no\u00a0break space inside", "a & b, c; d: e", "x".repeat(280),
    ];
    for (const text of accepted) {
      await fake.api.announce(HUB, { text, targets: { all: true } });
      assert.equal(fake.seen[fake.seen.length - 1].body.text, text);
    }
  } finally { await fake.close(); }
});

test("the text is NFC-normalised, trimmed the way the API trims, and counted after that", () => {
  assert.equal(announcementText("e\u0301".repeat(200)), "\u00e9".repeat(200)); // 400 code points, 200 once composed
  assert.equal(announcementText("  \u00a0 hi \u3000 "), "hi");
  assert.equal(announcementText("\u001f hi \u001c"), "hi"); // Python's strip() takes these, so the API's does
  assert.equal(announcementText("\u00e9".repeat(280)).length, 280);
  assert.throws(() => announcementText("\u00e9".repeat(281)), /at most 280/);
  assert.throws(() => announcementText(" \u00a0 "), /empty/);
  assert.throws(() => announcementText("\ufeffhi"), RangeError); // a BOM is a format character, not white space
  assert.throws(() => announcementText(7 as unknown as string), TypeError);
});

test("lang is a language tag", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [200, announcement()]);
    for (const good of ["en", "en-US", "fr-CA", "zho-Hant"]) await fake.api.announce(HUB, { text: "hi", targets: { all: true }, lang: good });
    const sent = fake.seen.length;
    for (const bad of ["", "e", "en_US", "english", "en-", "en-US-x-private-use-long", 5 as unknown as string]) {
      await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { all: true }, lang: bad }), (e: unknown) => e instanceof RangeError);
    }
    assert.equal(fake.seen.length, sent);
  } finally { await fake.close(); }
});

// -- targets ----------------------------------------------------------------------------------------

for (const kind of ["speakers", "rooms", "groups"] as const) {
  test(`a ${kind} target list holds at most 50 names of at most 64 characters`, async () => {
    const fake = await fakeApi();
    try {
      fake.reply("POST", `${BASE}/announce`, [200, announcement()]);
      await fake.api.announce(HUB, { text: "hi", targets: { [kind]: Array.from({ length: 50 }, (_, i) => `n${i}`) } as never });
      await fake.api.announce(HUB, { text: "hi", targets: { [kind]: ["n".repeat(64)] } as never });
      const sent = fake.seen.length;
      await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { [kind]: Array.from({ length: 51 }, (_, i) => `n${i}`) } as never }), /at most 50/);
      await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { [kind]: ["n".repeat(65)] } as never }), /at most 64/);
      assert.equal(fake.seen.length, sent);
    } finally { await fake.close(); }
  });
}

// -- do not disturb --------------------------------------------------------------------------------

const quiet = (timezone: string | null, start = "22:00", end = "07:00") => ({ enabled: true, quiet_hours: { start, end, timezone } });

test("an unusable do-not-disturb is refused before anything is sent", async () => {
  const fake = await fakeApi();
  try {
    const bad: unknown[] = [
      { enabled: true }, { enabled: true, quiet_hours: null },
      quiet(null), quiet("Mars/Phobos"), quiet("europe/paris"), quiet("EUROPE/PARIS"), quiet("utc"), quiet("Europe/Paris "), quiet(" Europe/Paris"),
      quiet(""), quiet("Europe/" + "x".repeat(60)), quiet("+01:00"), quiet("Europe Paris"),
      quiet("Europe/Paris", "22:00", "22:00"),
      { enabled: false, quiet_hours: { start: "22:00", end: "07:00", timezone: "Mars/Phobos" } },
      { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: "Europe/Paris", extra: 1 } },
      { enabled: true, quiet_hours: quiet("Europe/Paris").quiet_hours, notify: true },
      { enabled: true, quiet_hours: "22:00-07:00" },
      { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: 5 } },
    ];
    for (const dnd of bad) {
      await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", { dnd } as never), (e: unknown) => e instanceof RangeError || e instanceof TypeError, JSON.stringify(dnd));
    }
    assert.equal(fake.seen.length, 0);
  } finally { await fake.close(); }
});

test("a valid do-not-disturb is sent", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("PATCH", `${BASE}/speakers/c1`, [200, speakerRow()]);
    for (const zone of ["Europe/Paris", "America/Argentina/Buenos_Aires", "UTC", "US/Pacific", "Etc/GMT+5"]) {
      await fake.api.updateIntercomSpeaker(HUB, "c1", { dnd: quiet(zone) });
      assert.equal(fake.seen[fake.seen.length - 1].body.dnd.quiet_hours.timezone, zone);
    }
    await fake.api.updateIntercomSpeaker(HUB, "c1", { dnd: { enabled: false } });
    assert.deepEqual(fake.seen[fake.seen.length - 1].body.dnd, { enabled: false });
  } finally { await fake.close(); }
});

test("the speaker update takes only the documented fields", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("PATCH", `${BASE}/speakers/c1`, [200, speakerRow()]);
    for (const changes of [{ label: "x" }, { receive: true, client_id: "c1" }, { receive: true, kind: "embedded" }, { room: "a", can_play: true }]) {
      await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", changes as never), /Unknown speaker field/);
    }
    await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "c1", null as never), TypeError);
    assert.equal(fake.seen.length, 0);
    await fake.api.updateIntercomSpeaker(HUB, "c1", { receive: true, room: null, groups: ["g"], dnd: { enabled: false } });
    assert.deepEqual(fake.seen[0].body, { receive: true, room: null, groups: ["g"], dnd: { enabled: false } });
  } finally { await fake.close(); }
});

// -- the new problem codes -------------------------------------------------------------------------

const problem = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => ({ status, code, message, ...extra });

type ErrorClass = new (...args: never[]) => ThalovantApiError;
const CASES: Array<[number, string, ErrorClass, Record<string, unknown>, Record<string, unknown>]> = [
  [403, "urgent_scope_required", ThalovantUrgentScopeRequiredError, {}, {}],
  [429, "intercom_urgent_busy", ThalovantUrgentBusyError, { scope: "hub", retry_after_seconds: 30 }, { scope: "hub", retryAfterSeconds: 30 }],
  [409, "skill_not_installed", ThalovantSkillNotInstalledError, {}, {}],
  [422, "not_a_speaker", ThalovantNotASpeakerError, { kind: "home_assistant" }, { kind: "home_assistant", notSpeakers: [] }],
  [422, "not_a_speaker", ThalovantNotASpeakerError, { not_speakers: ["home-link", "other"] }, { kind: undefined, notSpeakers: ["home-link", "other"] }],
  [422, "reserved_name", ThalovantReservedNameError, {}, {}],
  [403, "hub_locked", ThalovantHubLockedError, {}, {}],
  [403, "impersonation_not_allowed", ThalovantImpersonationNotAllowedError, {}, {}],
  [422, "too_many_targets", ThalovantTooManyTargetsError, { matched: 51 }, { matched: 51 }],
  [422, "intercom_unavailable", ThalovantIntercomUnavailableError, { reason: "kid_hub" }, { reason: "kid_hub" }],
  [503, "intercom_disabled_platform", ThalovantIntercomPlatformDisabledError, {}, {}],
  [503, "intercom_not_configured", ThalovantIntercomNotConfiguredError, {}, {}],
  [403, "managed_client", ThalovantManagedClientError, { refused_client_refs: ["client-1"] }, { refusedClientRefs: ["client-1"] }],
  [409, "not_cancellable", ThalovantNotCancellableError, { announcement_status: "cancelled" }, { announcementStatus: "cancelled" }],
  [502, "hub_unreachable", ThalovantHubUnreachableError, { announcement_id: ANN }, { announcementId: ANN }],
];

for (const [status, code, kind, extra, attrs] of CASES) {
  test(`${code} (${status}) is its own typed error, at the top of the problem and inside a detail object`, async () => {
    const fake = await fakeApi();
    try {
      for (const body of [problem(status, code, "A sentence from the API.", extra), { detail: { code, message: "A sentence.", ...extra } }]) {
        fake.reply("POST", `${BASE}/announce`, [status, body]);
        await assert.rejects(fake.api.announce(HUB, { text: "Dinner", targets: { all: true } }), (error: any) => {
          assert.equal(error.constructor, kind);
          assert.equal(error.statusCode, status);
          assert.equal(error.code, code);
          for (const [name, expected] of Object.entries(attrs)) assert.deepEqual(error[name], expected, name);
          return true;
        });
      }
    } finally { await fake.close(); }
  });
}

test("the typed errors keep their places in the hierarchy", () => {
  assert.ok(Object.getPrototypeOf(ThalovantUrgentScopeRequiredError.prototype) === ThalovantAuthError.prototype); // sign in again with the scope
  assert.ok(Object.getPrototypeOf(ThalovantUrgentBusyError.prototype) === ThalovantRateLimitedError.prototype);  // still "a 429"
  assert.ok(Object.getPrototypeOf(ThalovantIntercomUnavailableError.prototype) === ThalovantIntercomDisabledError.prototype);
  assert.ok(Object.getPrototypeOf(ThalovantIntercomPlatformDisabledError.prototype) === ThalovantIntercomDisabledError.prototype);
  for (const kind of [ThalovantIntercomNotConfiguredError, ThalovantHubLockedError, ThalovantManagedClientError, ThalovantNotASpeakerError]) {
    assert.ok(new (kind as never as new (m: string) => Error)("x") instanceof ThalovantApiError);
  }
});

test("the urgent busy error carries the retry-after", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [429, problem(429, "intercom_urgent_busy", "busy", { scope: "platform", retry_after_seconds: 30 }), { "Retry-After": "30" }]);
    await assert.rejects(
      fake.api.announce(HUB, { text: "Wake", targets: { all: true }, priority: "urgent", repeat: { times: 5, interval_seconds: 30 } }),
      (error: any) => error instanceof ThalovantUrgentBusyError && error.retryAfterSeconds === 30 && error.scope === "platform",
    );
  } finally { await fake.close(); }
});

test("a not_a_speaker refusal on the patch", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("PATCH", `${BASE}/speakers/996f`, [422, problem(422, "not_a_speaker", "cannot play", { kind: "home_assistant" })]);
    await assert.rejects(fake.api.updateIntercomSpeaker(HUB, "996f", { receive: true }), (error: any) => error instanceof ThalovantNotASpeakerError && error.kind === "home_assistant");
  } finally { await fake.close(); }
});

test("a problem without its extra members has none of them", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [422, problem(422, "too_many_targets", "too many", { matched: "51" })]);
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { all: true } }), (error: any) => error instanceof ThalovantTooManyTargetsError && error.matched === undefined);
    assert.equal(new ThalovantIntercomUnavailableError("x").reason, undefined);
    assert.deepEqual([...new ThalovantNotASpeakerError("x").notSpeakers], []);
    assert.equal(new ThalovantNotCancellableError("x").announcementStatus, undefined);
    assert.equal(new ThalovantUrgentBusyError("x").scope, undefined);
    assert.deepEqual([...new ThalovantManagedClientError("x").refusedClientRefs], []);
  } finally { await fake.close(); }
});

test("the problem codes are constants and each has a typed error", () => {
  const codes = new Set(Object.values(IntercomProblemCode));
  assert.deepEqual(codes, new Set([...CASES.map(([, code]) => code), "intercom_disabled"]));
  assert.equal(IntercomProblemCode.URGENT_SCOPE_REQUIRED, "urgent_scope_required");
});

test("a plain 403 Insufficient scopes is still the auth error, and a code named like a prototype member is a plain error", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announce`, [403, { detail: "Insufficient scopes" }]);
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { all: true } }), (error: any) =>
      error instanceof ThalovantAuthError && !(error instanceof ThalovantUrgentScopeRequiredError));
    fake.reply("POST", `${BASE}/announce`, [400, { code: "constructor", detail: "x" }]);
    await assert.rejects(fake.api.announce(HUB, { text: "hi", targets: { all: true } }), (error: any) => error.constructor === ThalovantApiError);
  } finally { await fake.close(); }
});

test("the cancel 409 names the current status", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("POST", `${BASE}/announcements/${ANN}/cancel`, [409, problem(409, "not_cancellable", "Only an announcement that is still sending can be cancelled.", { announcement_status: "completed" })]);
    await assert.rejects(fake.api.cancelAnnouncement(HUB, ANN), (error: any) => error instanceof ThalovantNotCancellableError && error.announcementStatus === "completed");
  } finally { await fake.close(); }
});

test("the guides name the urgent scope and the new errors", () => {
  const readme = DOCS[0].text + DOCS[1].text + DOCS[2].text;
  for (const needle of ["intercom:urgent", "ThalovantUrgentScopeRequiredError", "policy_synced", "can_play", "replayed", "ThalovantNotASpeakerError", "not_cancellable"]) {
    assert.ok(readme.includes(needle), needle);
  }
});
