/**
 * Intercom: `/v1/hubs/{hub_id}/intercom` through the control plane, against a
 * loopback fake API (a real HTTP server on 127.0.0.1).
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  ThalovantApiError,
  ThalovantAuthError,
  ThalovantControlPlane,
  ThalovantHubUnreachableError,
  ThalovantIntercomDisabledError,
  ThalovantPlanError,
  ThalovantRateLimitedError,
  announceBody,
  speakerUpdateBody,
} from "../src/index.js";

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
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      const [path, query = ""] = (req.url ?? "").split("?");
      seen.push({ method: req.method ?? "", path, query, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const queue = replies.get(`${req.method} ${path}`) ?? [];
      const [status, body, headers] = (queue.length > 1 ? queue.shift() : queue[0]) ?? [404, { detail: "nope" }];
      res.writeHead(status, { "content-type": "application/json", ...(headers ?? {}) });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    seen,
    api: new ThalovantControlPlane(url, { accessToken: "tok" }),
    reply: (method: string, path: string, ...queue: Reply[]) => { replies.set(`${method} ${path}`, queue); },
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

test("speakers; the patch sends only what is passed and escapes the id", async () => {
  const fake = await fakeApi();
  try {
    const speaker = {
      client_id: "c/1", slug: "kitchen", name: "Kitchen", online: true, last_seen_at: null,
      intercom: { receive: true, room: "kitchen", groups: ["downstairs"],
        dnd: { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: null } } },
    };
    fake.reply("GET", `${BASE}/speakers`, [200, { items: [speaker] }]);
    fake.reply("PATCH", `${BASE}/speakers/c%2F1`, [200, speaker]);
    const listed = await fake.api.listIntercomSpeakers(HUB);
    assert.equal(listed.items[0].online, true);
    assert.deepEqual(listed.items[0].intercom.dnd.quiet_hours, { start: "22:00", end: "07:00", timezone: null });
    await fake.api.updateIntercomSpeaker(HUB, "c/1", { room: null, receive: true });
    assert.equal(fake.seen.at(-1)!.path, `${BASE}/speakers/c%2F1`);
    assert.deepEqual(fake.seen.at(-1)!.body, { receive: true, room: null });
    await fake.api.updateIntercomSpeaker(HUB, "c/1", { dnd: { enabled: true, quiet_hours: { start: "22:00", end: "07:00", timezone: "Europe/Paris" } } });
    assert.equal(fake.seen.at(-1)!.body.dnd.quiet_hours.timezone, "Europe/Paris");
  } finally { await fake.close(); }
});

test("settings, and an id is escaped as one path segment", async () => {
  const fake = await fakeApi();
  try {
    fake.reply("GET", `${BASE}/settings`, [200, { enabled: false, plan_allowed: false, unavailable_reason: "plan" }]);
    fake.reply("PUT", `${BASE}/settings`, [200, { enabled: true, plan_allowed: true, unavailable_reason: null }]);
    fake.reply("GET", "/v1/hubs/a%2Fb%3Fc/intercom/settings", [200, { enabled: false, plan_allowed: true }]);
    assert.equal((await fake.api.getIntercomSettings(HUB)).unavailable_reason, "plan");
    assert.equal((await fake.api.setIntercomSettings(HUB, true)).enabled, true);
    assert.deepEqual(fake.seen.at(-1)!.body, { enabled: true });
    assert.equal((await fake.api.getIntercomSettings("a/b?c")).plan_allowed, true);
    assert.equal(fake.seen.at(-1)!.path, "/v1/hubs/a%2Fb%3Fc/intercom/settings");
  } finally { await fake.close(); }
});

const errorCases: Array<[number, Record<string, unknown>, Record<string, string>, new (...a: any[]) => ThalovantApiError]> = [
  [403, { code: "intercom_disabled", detail: "off" }, {}, ThalovantIntercomDisabledError],
  [422, { code: "intercom_disabled", detail: "kid hub" }, {}, ThalovantIntercomDisabledError],
  [502, { code: "hub_unreachable", detail: "no hub" }, {}, ThalovantHubUnreachableError],
  [429, { code: "rate_limited", detail: "slow" }, { "Retry-After": "30" }, ThalovantRateLimitedError],
  [403, { code: "plan_limit", detail: "plan" }, {}, ThalovantPlanError],
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
