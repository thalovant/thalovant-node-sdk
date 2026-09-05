# Thalovant Node.js SDK

TypeScript SDK for connecting Node.js apps, services, and agents to Thalovant
hubs.

The control API is used to discover hubs and provision a client identity. After
that, the SDK talks directly to the hub data plane over HTTPS, WSS, or MQTTS.

Full docs: <https://docs.thalovant.com/developers/sdks/node/>

## What You Need

- A Thalovant account with API access for authenticated control-plane actions.
- A hub id or slug.
- A client identity for that hub. You can create one through the API or use one
  downloaded from the dashboard.

## Install

```bash
npm install @thalovant/sdk
```

Node.js 20 or newer is required.

## Quick Start

```ts
import { ThalovantClient, ThalovantControlPlane } from "@thalovant/sdk";

const api = new ThalovantControlPlane();

// Public hub discovery does not require auth.
const publicHubs = await api.listPublicHubs({ limit: 12 });
for (const hub of publicHubs.data as Array<{ id: string; slug: string; title: string }>) {
  console.log(hub.id, hub.slug, hub.title);
}

// Auth is required when creating a client identity.
await api.login("you@example.com", "password");

const result = await api.createClientIdentity("hub-id", {
  name: "node-demo-client",
  preferredProtocols: ["wss", "https", "mqtt"],
});

const client = new ThalovantClient(result.identity, { protocol: "wss" });
try {
  const connection = await client.connectWithInfo();
  console.log(connection);

  const reply = await client.query("Tell me a short clean joke.");
  console.log(reply.text);
} finally {
  await client.close();
}
```

`new ThalovantControlPlane()` uses `https://api.thalovant.com` by default. Pass
a different URL only for local development or a self-hosted control plane.

Keep `result.identity` secret. It contains the client credentials used by the
hub. The default `result.asObject()` is safe to log: it omits the credential
fields (the identity credentials, the client record's `initial_identify`
bundle, and the echoed spec keys), drops secret-named entries from free-form
`metadata` (nested values included), and strips any `user:pass@` userinfo from
endpoint URLs. `result.asObject({ includeSecrets: true })` contains the real
credentials — use it only to persist the identity, and never log it.

For quick debugging, `console.log` of a `ThalovantIdentity`,
`MqttBrokerCredentials`, or `ThalovantControlPlane` prints a redacted form in
Node (via the `util.inspect` hook), and `String(value)` / template literals
print the same redacted form in Node and browsers. Browser devtools, however,
enumerate an object's own properties directly, so `console.log(identity)` in a
browser can still show the raw credential fields — in browser code, log
`identity.asObject()` (or the `String(...)` form) rather than the object
itself.

## Sign In Without A Password

Accounts without a password (for example Google sign-in) authenticate through
the browser device flow. `loginWithBrowser()` prints a short code and a
verification URL, makes a best-effort attempt to open your default browser,
and waits until you approve the request there:

```ts
const api = new ThalovantControlPlane();

// Prints: To sign in, visit https://dash.thalovant.com/activate and enter the code XXXX-XXXX
const token = await api.loginWithBrowser({ clientName: "my-laptop" });

// api.accessToken is now set, exactly like after api.login(...).
const page = await api.listHubs({ limit: 50 });
```

Options:

- `scopes`: token scopes to request (server default when omitted). The server
  normalizes scopes, so the echoed `scopes` array may be larger than requested
  (for example `hubs:read` expands to include `hubs:preview` and
  `hubs:inspect`).
- `clientName`: label shown in the dashboard token list.
- `openBrowser`: set `false` to only print the URL and code (default `true`;
  opening is best-effort and never fails the sign-in).
- `prompt`: callback receiving the authorization payload to present the code
  and URL yourself instead of the default console message.
- `timeoutMs`: how long to wait for approval (default `900000`, 15 minutes).

The request rejects with a clear error when the sign-in is denied in the
browser, the code expires, or the timeout elapses. The returned
`access_token` is a durable scoped API token; store it securely to reuse it
later as `accessToken` (see the next section).

## Token Auth For CI And Automation

Headless environments (CI jobs, AI agents, cron tasks) should skip login
entirely: mint a scoped API token in the dashboard once, then pass it to the
constructor:

```ts
const api = new ThalovantControlPlane("https://api.thalovant.com", {
  accessToken: process.env.THALOVANT_API_TOKEN,
});

// Ready immediately; no login call needed.
const page = await api.listHubs({ limit: 50 });
```

```bash
# CI configuration
export THALOVANT_API_TOKEN="tvpat_..."  # store in your CI secret manager
```

Tokens minted through the dashboard or returned by `loginWithBrowser()` are
durable and scoped; grant only the scopes the job needs and rotate them from
the dashboard.

## Log In With MFA

Accounts with multi-factor authentication enabled must include a TOTP code or a
recovery code with the login. Without one the API responds with HTTP 401 and
code `mfa_required`.

```ts
await api.login("you@example.com", "password", { otpCode: "123456" });

// Or use a one-time recovery code instead:
await api.login("you@example.com", "password", { recoveryCode: "abcd-efgh-ijkl" });
```

## List Your Hubs

Authenticated accounts can list owned or visible hubs:

```ts
const api = new ThalovantControlPlane();
await api.login("you@example.com", "password");

const page = await api.listHubs({ limit: 50 });
for (const hub of page.data as Array<{ id: string; slug: string; title: string }>) {
  console.log(hub.id, hub.slug, hub.title);
}
```

## Provision Hubs

Hubs, runtime groups, and skills can be created and managed from code. These
routes need a **paid plan** and a token with the **`hubs:write`** scope
("Create and update your hubs" on the dashboard's API Tokens page). A free-plan
token fails with HTTP 402 `API access requires a paid plan.`, and a token
without the scope fails with HTTP 403 `Insufficient scopes`. Both surface as
`ThalovantApiError`.

```ts
const api = new ThalovantControlPlane(undefined, {
  accessToken: process.env.THALOVANT_API_TOKEN,
});

// 1. Discover what is installable before provisioning anything.
const catalog = await api.listMarketplaceSkills();
for (const skill of catalog.data as Array<Record<string, unknown>>) {
  console.log(skill.skill_id, skill.title, skill.access_tier);
}

// 2. Create a runtime group to run the skills.
const group = await api.createRuntimeGroup({ name: "kiosks", description: "Lobby kiosks" });

// 3. Create a hub attached to it.
const hub = await api.createHub({
  name: "joke-garden",
  runtimeGroupId: group.id as string,
  spec: { protocols: { wss: { enabled: true } } },
});

// 4. Install a skill from the marketplace catalog.
await api.installRuntimeGroupSkill(group.id as string, "skill-weather");

// 5. Release: roll the runtime and the hub onto a release channel.
await api.releaseRuntimeGroup(group.id as string, { channel: "stable" });
await api.releaseHub(hub.id as string, { channel: "stable" });
```

Creating a hub is idempotent. `createHub` sends a generated `Idempotency-Key`
header, so a retried call after a timeout returns the hub that was already
created instead of making a second one. Pass your own `idempotencyKey` to
control the key.

Updating and deleting a hub use optimistic locking. Pass the `etag` from the
hub resource you read; the SDK sends it as `If-Match`, and the API rejects a
stale **or missing** value with HTTP 412 without changing anything — which is
why `etag` is required rather than optional:

```ts
const current = await api.getHub(hub.id as string);
const disabled = await api.updateHub(current.id as string, { active: false }, {
  etag: current.etag as string,
});
await api.deleteHub(disabled.id as string, { etag: disabled.etag as string });
```

Deleting a hub also deletes its clients and ACLs. Runtime groups have no
`If-Match` requirement, but the API refuses to delete the workspace default
group or a group that still has hubs attached (HTTP 409).

Runtime configuration is merged, not replaced:

```ts
await api.updateRuntimeGroupConfig(group.id as string, { lang: "en-us" });
const config = await api.getRuntimeGroupConfig(group.id as string);
console.log(config.config);
```

Rating a public hub needs the `hubs:write` scope but **no** paid plan:

```ts
await api.setHubRating("public-hub-id", 5);
await api.clearHubRating("public-hub-id");
```

Reading what a hub is actually running needs the `hubs:inspect` scope instead.
This is the one read that answers HTTP 409 when no connected client can report
inventory:

```ts
const capabilities = await api.getHubRuntimeCapabilities(hub.id as string);
console.log((capabilities.counts as Record<string, number>).total_intents);
```

## Discover Skills

The marketplace catalog is readable with the **`hubs:read`** scope and, unlike
the provisioning routes above, is **not paid-gated** — a free-plan token can
browse the whole catalog before upgrading, and only the install needs a paid
plan.

```ts
const catalog = await api.listMarketplaceSkills();
for (const skill of catalog.data as Array<Record<string, unknown>>) {
  console.log(skill.skill_id, skill.category, skill.access_tier);
}
```

Each entry carries what an install needs (`skill_id`, `source_type`,
`source_ref`, `config_schema`, `secret_schema`) next to presentation fields
(`title`, `summary`, `tags`, `verified`). Admin tokens can additionally pass
`ownerId` to read another tenant's catalog and `includeInactive: true` to see
retired entries; both are silently ignored for non-admin callers rather than
rejected. `forceRefresh: true` re-syncs the global catalog from source first,
which is slower and is available to every caller.

Two group-scoped reads need the **`hubs:inspect`** scope and are likewise not
paid-gated. The first resolves the catalog against one runtime group, so each
entry reports whether it is already desired, whether it was observed running,
and whether the tenant plan allows installing it:

```ts
const view = await api.listRuntimeGroupMarketplace(group.id as string);
for (const entry of view.data as Array<Record<string, unknown>>) {
  if (entry.installable && !entry.active) console.log("available:", entry.skill_id);
}
```

The second answers what the group is actually running right now, rather than
what could be installed:

```ts
const inventory = await api.listRuntimeGroupInventory(group.id as string, { refresh: true });
console.log(inventory.source, (inventory.data as unknown[]).length);
```

Both answer from a cached inventory snapshot by default; pass
`refreshInventory: true` or `refresh: true` to force a live read from the
runtime operator. Neither fails when nothing is reporting yet: they return an
empty `data` list with the observation's provenance in `source`
(`runtime-group-cache-empty` for an unrefreshed group view,
`ovos-runtime-operator-pending` for an inventory refresh the operator has not
answered). `getHubRuntimeCapabilities` is the one that answers HTTP 409 instead.

## Workspace Analytics

Authenticated accounts can read the same overview used by the dashboard:

```ts
const overview = await api.getAnalyticsOverview({
  range: "7d",
  hubId: "hub-id",
});
console.log(overview.totals);
```

## Durable Memory

Private Daily Desk and workspace assistants can manage explicit opt-in memory:

```ts
const memory = await api.createMemoryItem({
  scope: "workspace",
  kind: "preference",
  content: "Prefer America/Toronto for scheduling.",
  tags: ["timezone"],
});
console.log(memory.id);

const items = await api.listMemoryItems({
  scope: "workspace",
  query: "timezone",
});
console.log(items.data);
```

## Use An Existing Identity

For local development, store one or more identities in the protected SDK config:

```bash
mkdir -p ~/.config/thalovant
chmod 700 ~/.config/thalovant
$EDITOR ~/.config/thalovant/config.yaml
chmod 600 ~/.config/thalovant/config.yaml
```

```yaml
profile: prod
profiles:
  prod:
    identity:
      access_key: ...
      password: ...
      site_id: demo-agent
      default_master: https://jokes.thalovant.io
      data_plane_endpoints:
        wss: wss://jokes.thalovant.io/public
        https: https://jokes.thalovant.io/public
        mqtt: mqtts://mqtt.thalovant.com:8883
      mqtt:
        endpoint: mqtts://mqtt.thalovant.com:8883
        username: ...
        password: ...
        topic_prefix: hubs/hub-id/clients/client-id
        tls: true
```

```ts
import { ThalovantClient } from "@thalovant/sdk";

const client = await ThalovantClient.fromConfig({ profile: "prod" });
try {
  const reply = await client.ask("What can this hub do?");
  console.log(reply.text);
} finally {
  await client.close();
}
```

SDKs reject config files that are readable or writable by other users on Linux
and macOS. Keep this file out of git.

Raw identity files are supported too:

```ts
const client = await ThalovantClient.fromIdentityFile("_identity.json");
```

Environment variables are supported too:

```ts
const client = ThalovantClient.fromEnv();
```

## Protocols

Hubs may expose one or more public data-plane protocols:

- `wss`: secure realtime WebSocket, the default public path and SDK preference.
- `https`: request/response HTTP protocol exposed as HTTPS.
- `mqtt`: broker-mediated MQTT over TLS. Requires per-client broker credentials.

Inspect what an identity supports:

```ts
const identity = result.identity;

console.log(identity.enabledProtocols());
console.log(identity.endpointFor("wss"));
console.log(identity.endpointFor("https"));
console.log(identity.endpointFor("mqtt"));
console.log(identity.mqtt?.endpoint);
```

Connect with a specific protocol:

```ts
for (const protocol of ["wss", "https", "mqtt"] as const) {
  if (!identity.supportsProtocol(protocol)) continue;
  if (protocol === "mqtt" && !identity.mqtt) continue;

  const client = new ThalovantClient(identity, { protocol });
  try {
    const reply = await client.ask(`Reply over ${protocol}.`);
    console.log(protocol, reply.text);
  } finally {
    await client.close();
  }
}
```

MQTT identities include a broker endpoint, username, password, TLS flag, and
topic prefix. The broker credentials are scoped to that client and should be
treated like a password. Public identities should use `mqtts://`; the SDK also
honors an explicit `tls: true` flag from the identity.

## Using In The Browser

The SDK also runs in browsers. The control plane (`login`, `listPublicHubs`,
`createClientIdentity`, memory, analytics) uses the global `fetch`, and
`ThalovantClient` works over the `wss` and `https` protocols using the global
`WebSocket` and Web Crypto (`crypto.subtle`) for HiveMind payload encryption.

package.json ships a `browser` map alongside the `exports` entry, so bundlers
(esbuild, webpack, Vite, Rollup with `@rollup/plugin-node-resolve`) pick
browser-safe modules automatically and never pull `ws`, `mqtt`, or `node:`
builtins into web bundles. Bundle it like any other dependency:

```bash
esbuild app.js --bundle --platform=browser --outfile=dist/app.js
```

```ts
// app.js — runs in the browser after bundling
import { ThalovantClient, ThalovantControlPlane } from "@thalovant/sdk";

const api = new ThalovantControlPlane();
await api.login(email, password);
const result = await api.createClientIdentity(hubId, { name: "web-kiosk" });

const client = new ThalovantClient(result.identity, { protocol: "wss" });
const reply = await client.ask("Hello from the browser.");
console.log(reply.text);
await client.close();
```

Browser caveats:

- The `mqtt` protocol stays Node-only. Constructing the MQTT transport in a
  browser throws `ThalovantUnsupportedProtocolError` with a clear message; use
  `wss` or `https` instead.
- Identity files and YAML configs stay Node-only: `ThalovantIdentity.fromFile()`,
  `fromConfig()`, and `defaultConfigPath()` throw in browsers. Construct
  `ThalovantIdentity` from an in-memory object (for example, the result of
  `createClientIdentity`).
- The synchronous crypto helpers (`encryptAsJson`, `decryptFromJson`,
  `encryptAsBinary`, `decryptBinary`) throw in browsers; use the `*Async`
  variants, which the transports already use on both platforms.
- Browsers ignore the SDK `user-agent` header on control-plane requests, and a
  client identity is a secret: only embed identities scoped to public or
  kiosk-style hubs in web apps.

## Conversations

Use a conversation when related turns should share one session.

```ts
const client = await ThalovantClient.fromIdentityFile("_identity.json");
try {
  const conversation = client.conversation({ lang: "en-us" });

  console.log((await conversation.ask("Remember that my favorite color is blue.")).text);
  console.log((await conversation.ask("What color did I mention?")).text);
} finally {
  await client.close();
}
```

## Realtime Query And Connection Timing

Use `query(...)` for the direct HiveMind query path when the hub supports it.
It keeps replies scoped to the originating query id and avoids broad bus fanout.
Use `ask(...)` when you need the older utterance/event flow.

```ts
const client = await ThalovantClient.fromIdentityFile("_identity.json", {
  protocol: "wss",
});

try {
  const connection = await client.connectWithInfo(10_000);
  console.log(connection.socketOpenMs, connection.handshakeMs, connection.connectMs);

  const reply = await client.query("What time is it in Toronto?", {
    timeoutMs: 30_000,
  });
  console.log(reply.text);

  console.log(client.healthcheck().connection);
} finally {
  await client.close();
}
```

For high concurrency, keep WSS clients connected and reuse the session for
multiple queries. Creating a new WSS connection for every prompt measures
ingress and HiveMind admission as much as skill latency.

## Events

You can wait for hub events by name.

```ts
import { EVENT_SPEAK, ThalovantClient } from "@thalovant/sdk";

const client = await ThalovantClient.fromIdentityFile("_identity.json");
try {
  const event = await client.waitForEvent(EVENT_SPEAK, { timeoutMs: 30_000 });
  console.log(event.text);
} finally {
  await client.close();
}
```

Use timeouts in scripts so they do not wait forever.

## Client Context

Context lets skills know which app, device, user, or channel made the request.

```ts
import { buildClientContext } from "@thalovant/sdk";

const context = buildClientContext({}, {
  userId: "user-42",
  userName: "Ada",
  authProvider: "oidc",
  roles: ["member"],
  platform: "kiosk",
  source: "checkout-kiosk",
  channel: "chat",
});

const reply = await client.ask("Show the next instruction.", { context });
console.log(reply.text);
```

## Actions And Exact Inputs

Use actions for button payloads and codes for exact typed or scanned values.

```ts
const conversation = client.conversation({ sessionId: "work-session" });

await conversation.sendAction('/choose{"id":"42"}', { title: "Choose item" });
await conversation.sendCode("SN-001-XYZ", { kind: "qr", label: "serial" });
```

## Rich Responses

Replies can include text, choices, tables, images, or attachments.

```ts
const reply = await client.ask("Show matching parts.");

for (const item of reply.displayItems({ maxTextChars: 600 })) {
  if (item.kind === "text") console.log(item.text);
  if (item.kind === "choices") console.log(item.data);
}
```

## What Can I Ask?

A connected client can ask its hub what it can be asked, over its own session,
with no control-plane token.

```ts
const client = await ThalovantClient.fromIdentityFile("_identity.json");
try {
  const inventory = await client.intents(["en-us", "fr-fr"]);
  for (const skill of inventory.skills) {
    for (const intent of skill.intents) {
      console.log(intent.id, intent.examples("fr-fr"));
    }
  }
} finally {
  await client.close();
}
```

Each intent carries the sentences a person says to reach it, per language, as
the skill wrote them (`{location}` marks a slot): `intent.phrases` keyed by
language, `intent.phrasesFor(lang)`, and `intent.examples(lang, limit)`, which
prefers whole sentences over ones with a slot. `inventory.asObject()` is
JSON-ready. The hub's connection must be allowed to publish `ovos.intent.list`;
`ovos.intent.describe` is needed only when the sentences are wanted, which is
the default (`describe: true`), so `intents(langs, { describe: false })` lists
with `ovos.intent.list` alone. A hub that refuses either rejects with
`ThalovantPolicyDeniedError` naming the type, or with the default
`fallback: true` lists intent names only and marks the result
`source: "engine-manifests"` with `denied: ["ovos.intent.list"]`. A hub that
answers the listing with `ok: false` rejects with `ThalovantRuntimeError`
carrying the hub's `error`: a refused listing is not an empty hub.

`client.listIntents(lang)` and `client.describeIntent(skillId, intentName, lang)`
expose the two underlying queries when you need the manifest rows or a
registration as the skill made it.

## Common Issues

- `Missing Thalovant API access token`: call `api.login(...)` or
  `api.loginWithBrowser(...)` before private control-plane actions, or pass
  `accessToken` to `ThalovantControlPlane`.
- `API access requires a paid plan`: upgrade the workspace before using the SDK
  control-plane API to provision private resources.
- `Unsupported protocol`: the hub does not expose that protocol, or the
  identity was created before that protocol was enabled.
- MQTT fails immediately: create or download a fresh client identity after MQTT
  is enabled. MQTT needs the per-client `identity.mqtt` credentials.
- A request times out: pass a larger `timeoutMs` to `ask(...)` or
  `waitForEvent(...)`.
- `ThalovantPolicyDeniedError`: the hub refused a message type this connection
  may not publish. `deniedType` names it and `allowed` lists what the
  connection may send; allow the type in the dashboard's connection settings.
  `intents(...)` falls back to intent names when only the engine manifests are
  allowed.
- `HTTP 429` with `"code": "token_rate_limited"`: the API token exceeded its
  plan's per-minute request rate (60 requests per minute on the free plan).
  The response carries a `Retry-After` header and a matching
  `retry_after_seconds`; wait that long and resend.
- `HTTP 429` with `"code": "token_quota_exceeded"`: the API token exhausted its
  plan's daily or monthly call quota. The body names which in `quota` (`daily`
  or `monthly`) alongside `limit` and `used`, and `Retry-After` points at the
  next UTC day or month boundary.

Both 429s apply to token-authenticated control-plane calls and surface as
`ThalovantApiError`, whose message embeds the status and the response body.
The SDK does not retry automatically: `Retry-After` is authoritative, so honor
it before resending. Per-plan limits are listed in the dashboard and at
<https://docs.thalovant.com/developers/sdks/node/>.

## API Shape

- `new ThalovantControlPlane()`
- `new ThalovantControlPlane(apiUrl, options)` for local or self-hosted control planes
- `controlPlane.login(email, password, options)` with optional `scope`, `otpCode`, and `recoveryCode`
- `controlPlane.loginWithBrowser(options)` with optional `scopes`, `clientName`, `openBrowser`, `prompt`, and `timeoutMs`
- `controlPlane.listPublicHubs(options)`
- `controlPlane.getPublicHub(hubRef)`
- `controlPlane.listHubs(options)`
- `controlPlane.getHub(hubId)`
- `controlPlane.createHub(payload, options)` with optional `idempotencyKey`
- `controlPlane.updateHub(hubId, payload, { etag })` — `etag` required, sent as `If-Match`
- `controlPlane.deleteHub(hubId, { etag })` — `etag` required, sent as `If-Match`
- `controlPlane.releaseHub(hubId, options)` with optional `channel`, `mode`, `version`, `images`, and `reason`
- `controlPlane.setHubRating(hubId, rating)`
- `controlPlane.clearHubRating(hubId)`
- `controlPlane.getHubRuntimeCapabilities(hubId)`
- `controlPlane.listRuntimeGroups(options)`
- `controlPlane.getRuntimeGroup(runtimeGroupId)`
- `controlPlane.createRuntimeGroup(payload)`
- `controlPlane.updateRuntimeGroup(runtimeGroupId, payload)`
- `controlPlane.getRuntimeGroupConfig(runtimeGroupId)`
- `controlPlane.updateRuntimeGroupConfig(runtimeGroupId, config, options)` with optional `personas`
- `controlPlane.releaseRuntimeGroup(runtimeGroupId, options)`
- `controlPlane.deleteRuntimeGroup(runtimeGroupId)`
- `controlPlane.installRuntimeGroupSkill(runtimeGroupId, skillId, options)` with optional `marketplaceSkillId`, `sourceType`, `sourceRef`, `versionPin`, and `active`
- `controlPlane.uninstallRuntimeGroupSkill(runtimeGroupId, skillId)`
- `controlPlane.listMarketplaceSkills(options)` with optional `ownerId`, `includeInactive`, and `forceRefresh`
- `controlPlane.listRuntimeGroupMarketplace(runtimeGroupId, options)` with optional `refreshInventory`
- `controlPlane.listRuntimeGroupInventory(runtimeGroupId, options)` with optional `refresh`
- `controlPlane.getOperation(operationId)`
- `controlPlane.getAnalyticsOverview(options)`
- `controlPlane.listMemoryItems(options)`
- `controlPlane.getMemorySummary(options)`
- `controlPlane.createMemoryItem(payload)`
- `controlPlane.getMemoryItem(memoryId)`
- `controlPlane.updateMemoryItem(memoryId, payload)`
- `controlPlane.deleteMemoryItem(memoryId)`
- `controlPlane.createClientIdentity(hubId, options)`
- `ThalovantIdentity.fromConfig(options)`
- `ThalovantClient.fromConfig(options)`
- `ThalovantClient.fromIdentityFile(path)`
- `ThalovantClient.fromEnv()`
- `new ThalovantClient(identity, { protocol })`
- `client.ask(text, options)`
- `client.query(text, options)`
- `client.connectWithInfo(timeoutMs)`
- `client.connectionInfo()`
- `client.sendUtterance(text, options)`
- `client.sendAction(payload, options)`
- `client.sendCode(value, options)`
- `client.emit(eventType, data, context)`
- `client.waitForEvent(eventName, options)`
- `client.on(eventName, handler, options)`
- `client.conversation(options)`
- `client.intents(languages, options)` with optional `timeoutMs`, `describe`, and `fallback`
- `client.listIntents(lang, options)` with optional `timeoutMs` and `includeDefinitions`
- `client.describeIntent(skillId, intentName, lang, options)` with optional `timeoutMs`

## Development

```bash
npm install
npm test
```
