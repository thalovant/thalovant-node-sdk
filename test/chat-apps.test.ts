/**
 * Chat apps: `/v1/bridges` through the control plane.
 *
 * Every route is driven through a scripted `fetch`, so what is asserted is
 * what goes on the wire (method, path, query, body, `If-Match`) and what a
 * caller reads back. Tokens and secrets travel in `SecretValue` and must never
 * reach a printed form: the value, an error, or the options a caller passed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  SecretValue,
  ThalovantApiError,
  ThalovantAuthError,
  ThalovantControlPlane,
  ThalovantPlanError,
  type Bridge,
  type BridgeChat,
} from "../src/index.js";

const BRIDGE_ID = "6d1f3c0e-6a8e-4c39-a6a4-0b5f3e2d1c9a";
const HUB_ID = "0c2b7e5a-3f41-4d0e-9a8b-1c2d3e4f5a6b";
const OWNER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
/** A fake token: the tests assert it never reaches a printed form. */
const FAKE_TOKEN = "123456789:FAKE-telegram-token-for-tests-only";
const FAKE_SECRET = "fake-matrix-access-token-0123456789";

const TELEGRAM_BRIDGE = {
  id: BRIDGE_ID,
  hub_id: HUB_ID,
  owner_id: OWNER_ID,
  network: "telegram",
  connector: { id: "telegram", name: "Telegram", version: "2026.11.1" },
  settings: {},
  secrets_set: ["token"],
  state: "active",
  resource_name: `bridge-${BRIDGE_ID}`,
  bot: {
    user_id: "7000000001",
    username: "my_hub_bot",
    display_name: "My Hub",
    application_id: null,
    avatar_url: `/v1/bridges/${BRIDGE_ID}/avatar`,
  },
  invite_links: {
    add_to_group: "https://t.me/my_hub_bot?startgroup=thalovant",
    direct_chat: "https://t.me/my_hub_bot",
  },
  allowed: [{ id: "-1001234567890", title: "Family", kind: "supergroup", guild_id: null, guild_name: null }],
  require_mention: true,
  session_scope: "person",
  paused: false,
  hold: null,
  status: {
    phase: "Ready",
    ready: true,
    reason: "Connected",
    message: null,
    operator_reason: null,
    generation: 3,
    observed_generation: 3,
    applied: true,
    source: "operator",
  },
  etag: "W/\"bridge-7\"",
  token_updated_at: "2026-11-02T10:00:00Z",
  activated_at: "2026-11-02T10:05:00Z",
  created_at: "2026-11-02T10:00:00Z",
  updated_at: "2026-11-02T10:05:00Z",
  operation: null,
};

const OPERATION = {
  id: "op-9",
  kind: "bridge.sync",
  aggregate_type: "bridge",
  aggregate_id: BRIDGE_ID,
  status: "requested",
  details: {},
  git_commit_sha: null,
  error_code: null,
  error_message: null,
  created_at: "2026-11-02T10:05:00Z",
  updated_at: "2026-11-02T10:05:00Z",
  committed_at: null,
  applied_at: null,
  ready_at: null,
  terminal_at: null,
  links: { self: "/v1/operations/op-9" },
};

const TWITCH_CONNECTOR = {
  id: "twitch",
  name: "Twitch",
  mark: "twitch",
  status: "beta",
  description: { en: "Answer in Twitch chat.", fr: "Répondre dans le chat Twitch." },
  setup_steps: { en: "1. Register an application.", fr: null },
  config_schema: {
    type: "object",
    properties: {
      bot_login: { type: "string", title: "Bot login", "x-title-fr": "Identifiant du bot", pattern: "^[a-z0-9_]{4,25}$" },
      client_id: { type: "string", title: "Client ID", "x-title-fr": "ID client" },
    },
    required: ["bot_login", "client_id"],
  },
  secrets: [
    { key: "refresh_token", label: { en: "Refresh token", fr: "Jeton d'actualisation" }, description: null, required: true },
    { key: "client_secret", label: { en: "Client secret", fr: null }, description: { en: "From the console.", fr: null }, required: true },
  ],
  targets: { label: { en: "Channel logins", fr: null }, pattern: "^[a-z0-9_]{4,25}$", max: 50, lowercase: true, strip_prefix: "#" },
  options: { require_mention_fixed: false, session_scopes: ["person", "chat"] },
  helpers: [],
  offered: true,
  version: { version: "2026.11.0", released_at: "2026-11-01T09:00:00Z" },
};

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

type Answer = Response | (() => Response);

/** A control plane whose fetch answers from a script, recording every request. */
function scripted(routes: Record<string, Answer>): { api: ThalovantControlPlane; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? "GET";
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const recorded: Recorded = {
      method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      headers,
    };
    if (init?.body !== undefined) recorded.body = JSON.parse(String(init.body));
    requests.push(recorded);
    const answer = routes[`${method} ${parsed.pathname}`];
    if (!answer) throw new Error(`unexpected request ${method} ${parsed.pathname}`);
    return typeof answer === "function" ? answer() : answer.clone();
  }) as typeof fetch;
  return {
    api: new ThalovantControlPlane("https://api.example.com", { accessToken: "api-token", fetch: fetchImpl }),
    requests,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function problem(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "about:blank", title: "HTTPException", status, ...body }), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

async function rejection(promise: Promise<unknown>): Promise<ThalovantApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ThalovantApiError, String(error));
    return error;
  }
  assert.fail("expected the call to be refused");
}

/** Every form of a value a caller could print or log. */
function printed(value: unknown): string[] {
  const forms = [String(value), inspect(value, { depth: 10, showHidden: true }), JSON.stringify(value) ?? ""];
  if (value instanceof Error) forms.push(value.message, value.stack ?? "", JSON.stringify((value as ThalovantApiError).problem ?? null));
  return forms;
}

function assertAbsent(value: unknown, ...secrets: string[]): void {
  for (const form of printed(value)) {
    for (const secret of secrets) {
      assert.ok(!form.includes(secret), `a secret reached ${JSON.stringify(form)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test("listChatAppConnectors reads GET /v1/bridges/connectors into connectors", async () => {
  const { api, requests } = scripted({ "GET /v1/bridges/connectors": json(200, { data: [TWITCH_CONNECTOR] }) });
  const connectors = await api.listChatAppConnectors();
  assert.deepEqual(requests.map((r) => [r.method, r.path, r.body]), [["GET", "/v1/bridges/connectors", undefined]]);
  assert.equal(requests[0].headers.authorization, "Bearer api-token");
  assert.equal(connectors.length, 1);
  const twitch = connectors[0];
  assert.equal(twitch.id, "twitch");
  assert.equal(twitch.status, "beta");
  assert.deepEqual(twitch.description, { en: "Answer in Twitch chat.", fr: "Répondre dans le chat Twitch." });
  assert.deepEqual(twitch.setup_steps, { en: "1. Register an application.", fr: null });
  assert.deepEqual(twitch.config_schema, TWITCH_CONNECTOR.config_schema);
  assert.deepEqual(twitch.secrets.map((s) => [s.key, s.required, s.description?.en ?? null]), [
    ["refresh_token", true, null],
    ["client_secret", true, "From the console."],
  ]);
  assert.deepEqual(twitch.targets, {
    label: { en: "Channel logins", fr: null },
    pattern: "^[a-z0-9_]{4,25}$",
    max: 50,
    lowercase: true,
    strip_prefix: "#",
  });
  assert.deepEqual(twitch.options, { require_mention_fixed: false, session_scopes: ["person", "chat"] });
  assert.deepEqual(twitch.helpers, []);
  assert.equal(twitch.offered, true);
  assert.deepEqual(twitch.version, { version: "2026.11.0", released_at: "2026-11-01T09:00:00Z" });
});

test("a connector's optional members take their defaults and unknown values survive", async () => {
  const minimal = {
    id: "smoke-signal",
    name: "Smoke signal",
    status: "experimental",
    description: { en: "Puffs." },
    setup_steps: { en: "Light a fire." },
    secrets: [{ key: "token", label: { en: "Token" } }],
    targets: { label: { en: "Hills" }, pattern: "^[a-z]+$", max: 3 },
    helpers: ["validate", "telepathy"],
  };
  const { api } = scripted({ "GET /v1/bridges/connectors": json(200, { data: [minimal] }) });
  const [connector] = await api.listChatAppConnectors();
  assert.equal(connector.status, "experimental");
  assert.equal(connector.mark, "");
  assert.deepEqual(connector.description, { en: "Puffs.", fr: null });
  assert.deepEqual(connector.config_schema, {});
  assert.deepEqual(connector.secrets, [{ key: "token", label: { en: "Token", fr: null }, description: null, required: true }]);
  assert.deepEqual(connector.targets, { label: { en: "Hills", fr: null }, pattern: "^[a-z]+$", max: 3, lowercase: false, strip_prefix: null });
  assert.deepEqual(connector.options, { require_mention_fixed: false, session_scopes: ["person", "chat"] });
  assert.deepEqual(connector.helpers, ["validate", "telepathy"]);
  assert.equal(connector.offered, false);
  assert.equal(connector.version, null);
});

test("getBridgeNetworks reads the offers and the allowance, with hub_id only when given", async () => {
  const answer = {
    networks: [
      { network: "telegram", offered: true, name: "Telegram", mark: "telegram", status: "offered" },
      { network: "matrix", offered: false, name: "Matrix", mark: "matrix", status: "beta" },
      { network: "carrier-pigeon", offered: false, status: "someday" },
    ],
    allowance: { owner_id: OWNER_ID, plan: "Home", paid_plan: true, limit: 2, used: 1, remaining: 1, can_create: true },
  };
  const { api, requests } = scripted({ "GET /v1/bridges/networks": json(200, answer) });
  const networks = await api.getBridgeNetworks();
  await api.getBridgeNetworks({ hubId: HUB_ID });
  assert.deepEqual(requests.map((r) => r.query), [{}, { hub_id: HUB_ID }]);
  assert.deepEqual(networks.networks, [
    { network: "telegram", offered: true, name: "Telegram", mark: "telegram", status: "offered" },
    { network: "matrix", offered: false, name: "Matrix", mark: "matrix", status: "beta" },
    { network: "carrier-pigeon", offered: false, name: null, mark: null, status: "someday" },
  ]);
  assert.deepEqual(networks.allowance, answer.allowance);
});

test("a Free plan's allowance reads as nothing to create", async () => {
  const { api } = scripted({
    "GET /v1/bridges/networks": json(200, {
      networks: [{ network: "telegram", offered: true }],
      allowance: { owner_id: OWNER_ID, plan: "Free", paid_plan: false, limit: 0, used: 0, remaining: 0, can_create: false },
    }),
  });
  const { allowance } = await api.getBridgeNetworks();
  assert.equal(allowance.can_create, false);
  assert.equal(allowance.paid_plan, false);
  assert.equal(allowance.remaining, 0);
});

test("listBridges sends hub_id, owner_id and limit only when given, and reads the envelope", async () => {
  const { api, requests } = scripted({ "GET /v1/bridges": json(200, { data: [TELEGRAM_BRIDGE] }) });
  const all = await api.listBridges();
  await api.listBridges({ hubId: HUB_ID });
  await api.listBridges({ ownerId: OWNER_ID, limit: 500 });
  assert.deepEqual(requests.map((r) => [r.method, r.path, r.query]), [
    ["GET", "/v1/bridges", {}],
    ["GET", "/v1/bridges", { hub_id: HUB_ID }],
    ["GET", "/v1/bridges", { owner_id: OWNER_ID, limit: "500" }],
  ]);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, BRIDGE_ID);
});

test("listBridges refuses a limit outside 1 to 500 before sending", async () => {
  const { api, requests } = scripted({});
  for (const limit of [0, 501, 1.5, Number.NaN]) {
    await assert.rejects(api.listBridges({ limit }), RangeError);
  }
  assert.equal(requests.length, 0);
});

test("createBridge with a token sends hub_id, connector and the token, never network", async () => {
  const { api, requests } = scripted({ "POST /v1/bridges": json(201, { ...TELEGRAM_BRIDGE, state: "setup", allowed: [] }) });
  const bridge = await api.createBridge({ hubId: HUB_ID, connector: "telegram", token: new SecretValue(FAKE_TOKEN) });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/v1/bridges");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.deepEqual(requests[0].body, { hub_id: HUB_ID, connector: "telegram", token: FAKE_TOKEN });
  assert.equal(bridge.state, "setup");
});

test("createBridge takes a plain string token too", async () => {
  const { api, requests } = scripted({ "POST /v1/bridges": json(201, TELEGRAM_BRIDGE) });
  await api.createBridge({ hubId: HUB_ID, connector: "telegram", token: FAKE_TOKEN });
  assert.deepEqual(requests[0].body, { hub_id: HUB_ID, connector: "telegram", token: FAKE_TOKEN });
});

test("createBridge with secrets and settings sends both (Matrix, Twitch)", async () => {
  const { api, requests } = scripted({ "POST /v1/bridges": json(201, { ...TELEGRAM_BRIDGE, network: "matrix" }) });
  await api.createBridge({
    hubId: HUB_ID,
    connector: "matrix",
    secrets: { access_token: new SecretValue(FAKE_SECRET) },
    settings: { homeserver: "https://matrix.example.org", user_id: "@hub:example.org" },
  });
  await api.createBridge({
    hubId: HUB_ID,
    connector: "twitch",
    secrets: { refresh_token: new SecretValue("fake-refresh-token-0001"), client_secret: "fake-client-secret-0002" },
    settings: { bot_login: "myhubbot", client_id: "abc123" },
  });
  assert.deepEqual(requests[0].body, {
    hub_id: HUB_ID,
    connector: "matrix",
    secrets: { access_token: FAKE_SECRET },
    settings: { homeserver: "https://matrix.example.org", user_id: "@hub:example.org" },
  });
  assert.deepEqual(requests[1].body, {
    hub_id: HUB_ID,
    connector: "twitch",
    secrets: { refresh_token: "fake-refresh-token-0001", client_secret: "fake-client-secret-0002" },
    settings: { bot_login: "myhubbot", client_id: "abc123" },
  });
});

test("createBridge refuses token and secrets together, and neither, without sending or printing them", async () => {
  const { api, requests } = scripted({});
  const both = await rejection(
    api.createBridge({ hubId: HUB_ID, connector: "telegram", token: FAKE_TOKEN, secrets: { access_token: FAKE_SECRET } }),
  );
  assert.equal(both.statusCode, undefined);
  assert.match(both.message, /token or secrets, not both/);
  assertAbsent(both, FAKE_TOKEN, FAKE_SECRET);
  const neither = await rejection(api.createBridge({ hubId: HUB_ID, connector: "telegram" }));
  assert.match(neither.message, /token or secrets/);
  await rejection(api.createBridge({ hubId: HUB_ID, connector: "telegram", secrets: {} }));
  await rejection(api.createBridge({ hubId: "", connector: "telegram", token: FAKE_TOKEN }));
  await rejection(api.createBridge({ hubId: HUB_ID, connector: "", token: FAKE_TOKEN }));
  // A secret of the wrong type is refused by name, never by value.
  const wrong = await rejection(
    api.createBridge({ hubId: HUB_ID, connector: "matrix", secrets: { access_token: 12345678901234 as unknown as string } }),
  );
  assert.match(wrong.message, /secret "access_token" must be a string or a SecretValue/);
  assert.ok(!wrong.message.includes("12345678901234"));
  assert.equal(requests.length, 0);
});

test("getBridge and deleteBridge escape the id", async () => {
  const odd = "a/b c?d";
  const { api, requests } = scripted({
    "GET /v1/bridges/a%2Fb%20c%3Fd": json(200, TELEGRAM_BRIDGE),
    "DELETE /v1/bridges/a%2Fb%20c%3Fd": new Response(null, { status: 204 }),
  });
  const bridge = await api.getBridge(odd);
  assert.equal(await api.deleteBridge(odd), undefined);
  assert.deepEqual(requests.map((r) => [r.method, r.path, r.body]), [
    ["GET", "/v1/bridges/a%2Fb%20c%3Fd", undefined],
    ["DELETE", "/v1/bridges/a%2Fb%20c%3Fd", undefined],
  ]);
  assert.equal(bridge.id, BRIDGE_ID);
});

test("updateBridge sends only what was set, with If-Match only when an etag is given", async () => {
  const { api, requests } = scripted({ [`PATCH /v1/bridges/${BRIDGE_ID}`]: json(200, { ...TELEGRAM_BRIDGE, operation: OPERATION }) });
  const paused = await api.updateBridge(BRIDGE_ID, { paused: true });
  await api.updateBridge(BRIDGE_ID, { paused: false }, { etag: TELEGRAM_BRIDGE.etag });
  await api.updateBridge(BRIDGE_ID, { requireMention: false, sessionScope: "chat", settings: { homeserver: "https://m.example.org" } });
  await api.updateBridge(BRIDGE_ID, {}, { etag: "" });
  assert.deepEqual(requests.map((r) => r.body), [
    { paused: true },
    { paused: false },
    { require_mention: false, session_scope: "chat", settings: { homeserver: "https://m.example.org" } },
    {},
  ]);
  assert.deepEqual(requests.map((r) => r.headers["If-Match"]), [undefined, TELEGRAM_BRIDGE.etag, undefined, undefined]);
  assert.ok(requests.every((r) => r.method === "PATCH" && r.path === `/v1/bridges/${BRIDGE_ID}`));
  assert.equal(paused.operation?.id, "op-9");
  assert.equal(paused.operation?.kind, "bridge.sync");
});

test("updateBridge takes ids, allowed entries and chat rows, sending only the chat members", async () => {
  const { api, requests } = scripted({ [`PATCH /v1/bridges/${BRIDGE_ID}`]: json(200, TELEGRAM_BRIDGE) });
  const row: BridgeChat = {
    id: "123456789012345678",
    title: "general",
    kind: "text",
    guild_id: "998877665544332211",
    guild_name: "My server",
    guild_icon_url: "https://cdn.example.com/icon.png",
    allowed: false,
    encrypted: false,
    selectable: true,
  };
  const current: Bridge["allowed"][number] = { id: "-1001234567890", title: "Family", kind: "supergroup", guild_id: null, guild_name: null };
  await api.updateBridge(BRIDGE_ID, { allowed: ["!abc:example.org", current, row] });
  assert.deepEqual(requests[0].body, {
    allowed: [
      { id: "!abc:example.org" },
      { id: "-1001234567890", title: "Family", kind: "supergroup" },
      { id: "123456789012345678", title: "general", kind: "text", guild_id: "998877665544332211", guild_name: "My server" },
    ],
  });
});

test("replaceBridgeToken and replaceBridgeSecrets PUT the values, and refuse an empty set", async () => {
  const { api, requests } = scripted({
    [`PUT /v1/bridges/${BRIDGE_ID}/token`]: json(200, TELEGRAM_BRIDGE),
    [`PUT /v1/bridges/${BRIDGE_ID}/secrets`]: json(200, { ...TELEGRAM_BRIDGE, network: "twitch", secrets_set: ["refresh_token", "client_secret"] }),
  });
  await api.replaceBridgeToken(BRIDGE_ID, new SecretValue(FAKE_TOKEN));
  await api.replaceBridgeToken(BRIDGE_ID, FAKE_TOKEN);
  const twitch = await api.replaceBridgeSecrets(BRIDGE_ID, { refresh_token: new SecretValue(FAKE_SECRET) });
  assert.deepEqual(requests.map((r) => [r.method, r.path, r.body]), [
    ["PUT", `/v1/bridges/${BRIDGE_ID}/token`, { token: FAKE_TOKEN }],
    ["PUT", `/v1/bridges/${BRIDGE_ID}/token`, { token: FAKE_TOKEN }],
    ["PUT", `/v1/bridges/${BRIDGE_ID}/secrets`, { secrets: { refresh_token: FAKE_SECRET } }],
  ]);
  assert.deepEqual(twitch.secrets_set, ["refresh_token", "client_secret"]);
  await rejection(api.replaceBridgeSecrets(BRIDGE_ID, {}));
  assert.equal(requests.length, 3);
});

test("listBridgeChats reads the chats, the note and manual entry", async () => {
  const { api, requests } = scripted({
    [`GET /v1/bridges/${BRIDGE_ID}/chats`]: json(200, {
      network: "discord",
      data: [
        { id: "123", title: "general", kind: "text", guild_id: "9", guild_name: "Srv", guild_icon_url: null, allowed: true },
        { id: "456", title: "secret", kind: "forum", encrypted: true, selectable: false },
      ],
      note: "Only servers the bot was added to are listed.",
    }),
  });
  const chats = await api.listBridgeChats(BRIDGE_ID);
  assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", `/v1/bridges/${BRIDGE_ID}/chats`]]);
  assert.deepEqual(chats, {
    network: "discord",
    data: [
      { id: "123", title: "general", kind: "text", guild_id: "9", guild_name: "Srv", guild_icon_url: null, allowed: true, encrypted: false, selectable: true },
      { id: "456", title: "secret", kind: "forum", guild_id: null, guild_name: null, guild_icon_url: null, allowed: false, encrypted: true, selectable: false },
    ],
    note: "Only servers the bot was added to are listed.",
    manual_entry: false,
  });
});

test("a connector without discovery answers manual entry", async () => {
  const { api } = scripted({
    [`GET /v1/bridges/${BRIDGE_ID}/chats`]: json(200, { network: "matrix", data: [], note: null, manual_entry: true }),
  });
  const chats = await api.listBridgeChats(BRIDGE_ID);
  assert.equal(chats.manual_entry, true);
  assert.deepEqual(chats.data, []);
});

test("sendBridgeTestMessage posts chat_id and reads the language", async () => {
  const { api, requests } = scripted({
    [`POST /v1/bridges/${BRIDGE_ID}/test`]: json(200, { sent: true, chat_id: "-1001234567890", language: "fr" }),
  });
  const result = await api.sendBridgeTestMessage(BRIDGE_ID, "-1001234567890");
  assert.deepEqual(requests.map((r) => [r.method, r.path, r.body]), [
    ["POST", `/v1/bridges/${BRIDGE_ID}/test`, { chat_id: "-1001234567890" }],
  ]);
  assert.deepEqual(result, { sent: true, chat_id: "-1001234567890", language: "fr" });
  const { api: older } = scripted({ [`POST /v1/bridges/${BRIDGE_ID}/test`]: json(200, { sent: true, chat_id: "1" }) });
  assert.equal((await older.sendBridgeTestMessage(BRIDGE_ID, "1")).language, "en");
});

test("getBridgeAvatar returns the image bytes and content type", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const { api, requests } = scripted({
    [`GET /v1/bridges/${BRIDGE_ID}/avatar`]: () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
  });
  const avatar = await api.getBridgeAvatar(BRIDGE_ID);
  assert.ok(avatar.content instanceof Uint8Array);
  assert.deepEqual([...avatar.content], [...png]);
  assert.equal(avatar.content_type, "image/png");
  assert.equal(requests[0].headers.accept, "image/*");
  assert.equal(requests[0].headers.authorization, "Bearer api-token");
});

test("a bot without a picture is the API's 404", async () => {
  const { api } = scripted({
    [`GET /v1/bridges/${BRIDGE_ID}/avatar`]: () => problem(404, { detail: "This bot has no picture" }),
  });
  const error = await rejection(api.getBridgeAvatar(BRIDGE_ID));
  assert.equal(error.statusCode, 404);
  assert.equal(error.detail, "This bot has no picture");
  assert.deepEqual(error.fields, []);
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a bridge reads every member the API sends", async () => {
  const { api } = scripted({ [`GET /v1/bridges/${BRIDGE_ID}`]: json(200, TELEGRAM_BRIDGE) });
  const bridge = await api.getBridge(BRIDGE_ID);
  assert.deepEqual(bridge, TELEGRAM_BRIDGE);
});

test("unknown states, scopes, phases, reasons, sources and holds survive", async () => {
  const future = {
    ...TELEGRAM_BRIDGE,
    state: "migrating",
    session_scope: "thread",
    hold: { reason: "maintenance", since: "2026-11-03T00:00:00Z" },
    status: { ...TELEGRAM_BRIDGE.status, phase: "Draining", reason: "NetworkMaintenance", source: "probe", ready: false },
  };
  const { api } = scripted({ [`GET /v1/bridges/${BRIDGE_ID}`]: json(200, future) });
  const bridge = await api.getBridge(BRIDGE_ID);
  assert.equal(bridge.state, "migrating");
  assert.equal(bridge.session_scope, "thread");
  assert.deepEqual(bridge.hold, { reason: "maintenance", since: "2026-11-03T00:00:00Z" });
  assert.equal(bridge.status.phase, "Draining");
  assert.equal(bridge.status.reason, "NetworkMaintenance");
  assert.equal(bridge.status.source, "probe");
});

test("a bridge's optional members take their defaults when absent", async () => {
  const minimal = {
    id: BRIDGE_ID,
    hub_id: HUB_ID,
    owner_id: OWNER_ID,
    network: "matrix",
    state: "setup",
    resource_name: `bridge-${BRIDGE_ID}`,
    bot: { user_id: `bridge:${BRIDGE_ID}`, avatar_url: `/v1/bridges/${BRIDGE_ID}/avatar` },
    allowed: [],
    require_mention: true,
    session_scope: "person",
    paused: false,
    status: { phase: "Setup", reason: "Setup", source: "lifecycle" },
    etag: "e1",
    token_updated_at: "2026-11-02T10:00:00Z",
    created_at: "2026-11-02T10:00:00Z",
    updated_at: "2026-11-02T10:00:00Z",
  };
  const { api } = scripted({ [`GET /v1/bridges/${BRIDGE_ID}`]: json(200, minimal) });
  const bridge = await api.getBridge(BRIDGE_ID);
  assert.equal(bridge.connector, null);
  assert.deepEqual(bridge.settings, {});
  assert.deepEqual(bridge.secrets_set, []);
  assert.equal(bridge.invite_links, null);
  assert.equal(bridge.hold, null);
  assert.equal(bridge.activated_at, null);
  assert.equal(bridge.operation, null);
  assert.deepEqual(bridge.bot, {
    user_id: `bridge:${BRIDGE_ID}`,
    username: null,
    display_name: null,
    application_id: null,
    avatar_url: `/v1/bridges/${BRIDGE_ID}/avatar`,
  });
  assert.deepEqual(bridge.status, {
    phase: "Setup",
    ready: false,
    reason: "Setup",
    message: null,
    operator_reason: null,
    generation: null,
    observed_generation: null,
    applied: null,
    source: "lifecycle",
  });
});

test("a status without its source reads as unavailable", async () => {
  const { source: _omitted, ...status } = TELEGRAM_BRIDGE.status;
  const { api } = scripted({ [`GET /v1/bridges/${BRIDGE_ID}`]: json(200, { ...TELEGRAM_BRIDGE, status }) });
  const bridge = await api.getBridge(BRIDGE_ID);
  assert.equal(bridge.status.source, "unavailable");
  assert.equal(bridge.status.reason, "Connected");
});

test("a held bridge reads its hold", async () => {
  const held = {
    ...TELEGRAM_BRIDGE,
    paused: true,
    hold: { reason: "plan_limit", since: "2026-11-03T08:00:00Z" },
    status: { ...TELEGRAM_BRIDGE.status, phase: "Paused", reason: "Paused", ready: false },
  };
  const { api } = scripted({ [`GET /v1/bridges/${BRIDGE_ID}`]: json(200, held) });
  const bridge = await api.getBridge(BRIDGE_ID);
  assert.equal(bridge.paused, true);
  assert.deepEqual(bridge.hold, { reason: "plan_limit", since: "2026-11-03T08:00:00Z" });
  assert.equal(bridge.status.reason, "Paused");
});

test("an answer without what the SDK acts on is an unexpected answer", async () => {
  for (const missing of ["id", "etag", "state"] as const) {
    const broken: Record<string, unknown> = { ...TELEGRAM_BRIDGE };
    delete broken[missing];
    const { api } = scripted({ [`GET /v1/bridges/${BRIDGE_ID}`]: json(200, broken) });
    const error = await rejection(api.getBridge(BRIDGE_ID));
    assert.equal(error.statusCode, undefined);
    assert.match(error.message, new RegExp(`without ${missing}`));
  }
  const { api } = scripted({ "GET /v1/bridges": json(200, { bridges: [] }), "GET /v1/bridges/connectors": json(200, {}) });
  await rejection(api.listBridges());
  await rejection(api.listChatAppConnectors());
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test("a settings refusal carries its code and the names in fields", async () => {
  const { api } = scripted({
    "POST /v1/bridges": () =>
      problem(422, {
        detail: "These settings are not valid: homeserver.",
        code: "bridge_settings_invalid",
        fields: ["homeserver", 7, null, "user_id"],
      }),
  });
  const error = await rejection(
    api.createBridge({ hubId: HUB_ID, connector: "matrix", secrets: { access_token: FAKE_SECRET }, settings: { homeserver: "http://10.0.0.1" } }),
  );
  assert.equal(error.statusCode, 422);
  assert.equal(error.code, "bridge_settings_invalid");
  assert.deepEqual(error.fields, ["homeserver", "user_id"]);
  assert.ok(Object.isFrozen(error.fields));
});

test("fields inside an object detail are read as code is", async () => {
  const { api } = scripted({
    [`PUT /v1/bridges/${BRIDGE_ID}/secrets`]: () =>
      problem(422, { detail: { detail: "Unknown secret: client_secret.", code: "bridge_secrets_invalid", fields: ["client_secret"] } }),
  });
  const error = await rejection(api.replaceBridgeSecrets(BRIDGE_ID, { client_secret: FAKE_SECRET }));
  assert.equal(error.code, "bridge_secrets_invalid");
  assert.equal(error.detail, "Unknown secret: client_secret.");
  assert.deepEqual(error.fields, ["client_secret"]);
});

test("refusals keep their classes: plan, auth, rate limit and a stale etag", async () => {
  const cases: Array<[Response, (error: ThalovantApiError) => void]> = [
    [
      problem(402, { detail: "Chat apps need a paid plan." }),
      (error) => {
        assert.ok(error instanceof ThalovantPlanError);
        assert.deepEqual(error.fields, []);
      },
    ],
    [
      problem(403, { detail: "Plan limit reached", code: "plan_limit", resource: "chat_bridge", limit: 2, used: 2 }),
      (error) => {
        assert.ok(error instanceof ThalovantPlanError);
        assert.equal(error.problem?.resource, "chat_bridge");
      },
    ],
    [problem(401, { detail: "Not authenticated" }), (error) => assert.ok(error instanceof ThalovantAuthError)],
    [problem(403, { detail: "Insufficient scopes" }), (error) => assert.ok(error instanceof ThalovantAuthError)],
    [
      problem(429, { detail: "Too many test messages.", code: "bridge_rate_limited" }, { "Retry-After": "30" }),
      (error) => {
        assert.equal(error.code, "bridge_rate_limited");
        assert.equal(error.retryAfterSeconds, 30);
      },
    ],
    [
      problem(412, { detail: "ETag mismatch" }),
      (error) => {
        assert.equal(error.statusCode, 412);
        assert.equal(error.detail, "ETag mismatch");
      },
    ],
    [
      problem(409, { detail: "This bot already serves a bridge.", code: "bridge_bot_in_use" }),
      (error) => {
        assert.ok(!(error instanceof ThalovantPlanError) && !(error instanceof ThalovantAuthError));
        assert.equal(error.code, "bridge_bot_in_use");
      },
    ],
  ];
  for (const [answer, check] of cases) {
    const { api } = scripted({ [`PATCH /v1/bridges/${BRIDGE_ID}`]: () => answer.clone() });
    check(await rejection(api.updateBridge(BRIDGE_ID, { paused: false }, { etag: "stale" })));
  }
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("SecretValue prints [redacted] in every form and reveals only on request", () => {
  const secret = new SecretValue(FAKE_TOKEN);
  assert.equal(secret.reveal(), FAKE_TOKEN);
  assert.equal(String(secret), "[redacted]");
  assert.equal(`${secret}`, "[redacted]");
  assert.equal("token: " + secret, "token: [redacted]");
  assert.equal(JSON.stringify(secret), '"[redacted]"');
  assert.equal(JSON.stringify({ token: secret }), '{"token":"[redacted]"}');
  assert.equal(inspect(secret), "[redacted]");
  assert.deepEqual(Object.keys(secret), []);
  assertAbsent(secret, FAKE_TOKEN);
  assertAbsent({ hubId: HUB_ID, connector: "telegram", token: secret, secrets: { access_token: new SecretValue(FAKE_SECRET) } }, FAKE_TOKEN, FAKE_SECRET);
  assert.ok(Object.isFrozen(secret));
  assert.equal(SecretValue.from(secret), secret);
  assert.equal(SecretValue.from(FAKE_TOKEN).reveal(), FAKE_TOKEN);
  assert.throws(() => new SecretValue(42 as unknown as string), TypeError);
});

test("a token the API echoes back never reaches the error", async () => {
  // The API never echoes one (validation errors under /v1/bridges repeat no
  // input); this proves the SDK holds even if a proxy in between did.
  const echo = () =>
    problem(422, {
      detail: `The token ${FAKE_TOKEN} was refused by the network.`,
      code: "bridge_token_invalid",
      errors: [{ loc: ["body", "token"], msg: "bad", input: FAKE_TOKEN }],
    });
  const { api } = scripted({
    "POST /v1/bridges": echo,
    [`PUT /v1/bridges/${BRIDGE_ID}/token`]: echo,
    [`PUT /v1/bridges/${BRIDGE_ID}/secrets`]: echo,
  });
  const errors = [
    await rejection(api.createBridge({ hubId: HUB_ID, connector: "telegram", token: new SecretValue(FAKE_TOKEN) })),
    await rejection(api.createBridge({ hubId: HUB_ID, connector: "telegram", token: FAKE_TOKEN })),
    await rejection(api.replaceBridgeToken(BRIDGE_ID, new SecretValue(FAKE_TOKEN))),
    await rejection(api.replaceBridgeSecrets(BRIDGE_ID, { token: new SecretValue(FAKE_TOKEN) })),
  ];
  for (const error of errors) {
    assert.equal(error.code, "bridge_token_invalid");
    assertAbsent(error, FAKE_TOKEN);
    assert.ok(!(error.detail ?? "").includes(FAKE_TOKEN));
  }
});

test("a network failure while sending a token says nothing of the request", async () => {
  const api = new ThalovantControlPlane("https://api.example.com", {
    accessToken: "api-token",
    fetch: (async () => {
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED body=${FAKE_TOKEN}`) });
    }) as typeof fetch,
  });
  const error = await rejection(api.createBridge({ hubId: HUB_ID, connector: "telegram", token: new SecretValue(FAKE_TOKEN) }));
  assert.equal(error.cause, undefined);
  assertAbsent(error, FAKE_TOKEN);
});
