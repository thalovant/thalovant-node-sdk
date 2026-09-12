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

`createHub` sends an `Idempotency-Key` header. To safely retry after a timeout
or uncertain outcome, retain an explicit `idempotencyKey` before the first call
and reuse it with the same payload. When you omit the option, each call generates
a fresh key, so a later retry can create a second hub.

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

Configuration updates deep-merge with a revision precondition. The SDK reads
fresh configuration after HTTP 412 conflicts, with at most three total write attempts.
A server without revision support fails before a write. Merging needs both
`hubs:read` and paid `hubs:write`; set `merge: false` for explicit replacement:

```ts
await api.updateRuntimeGroupConfig(group.id as string, {
  lang: "en-us",
});
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

## Skills On One Hub

The hub-skill calls manage the attachments of the hub’s shared runtime group.
The group can start with no skills. These calls address
**the runtime group selected by a hub id** (the authenticated hub routes do not take slugs) and every
change applies live on that hub, typically within about fifteen seconds and
without restarting it.

```ts
const listing = await api.listHubSkills(hub.id as string);
console.log(listing.source, listing.observed_at);
for (const skill of listing.data) {
  console.log(skill.skill, skill.installed_version, skill.state, skill.update_available);
}

// Accepted at once: HTTP 202 with an operation_id, state "installing".
const accepted = await api.installHubSkill(hub.id as string, "skill-weather");
console.log(accepted.operation_id, accepted.state, accepted.previous_version);

// Or poll the operation until it converges (default timeoutMs 120000).
const done = await api.installHubSkill(hub.id as string, "skill-weather", { version: "1.2.0", wait: true });
console.log(done.state); // "installed"

await api.updateHubSkill(hub.id as string, "skill-weather", { version: "latest", wait: true });
await api.removeHubSkill(hub.id as string, "skill-weather", { wait: true }); // state "removed"
```

`listHubSkills` resolves with a typed `HubSkillList`: the envelope says where
the reading came from (`hub_id`, `runtime_group_id`, `observed_at`, `source`,
the runtime's phase and message) and `data` holds one `HubSkill` row per
skill (`skill`, `title`, `version`, `installed_version`, `observed_version`,
`latest_version`, `update_available`, `active`, `state`, the runtime's last
error, and more). A row's `state` is `pending`, `installed`, `failed`,
`removing`, `drifted`, `quarantined`, or `unmanaged`; a change in progress
shows as `pending`.

The writes resolve with a typed `HubSkillOperation` (`operation_id`,
`hub_id`, `runtime_group_id`, `skill`, `version`, `previous_version`,
`state`). Installing a skill the hub already carries at another version
performs an update. With `wait: true` a `failed` or `timed_out` operation
rejects with `ThalovantApiError` carrying the accepted operation ID and error message, and
running past the polling budget `timeoutMs` rejects with `ThalovantTimeoutError`;
no new status read starts once that budget expires. A failed status read is not
retried: the error message retains the accepted operation ID so you can resume
with `getOperation`, and its `cause` retains the original sanitized API error.
The polling deadline does not cancel an HTTP request already in flight. The API
answers HTTP 409 `skill_version_already_installed` for the same version,
HTTP 404 `hub_without_runtime_group` when the hub has no runtime group yet
(a plain 404 for an unknown hub or a skill that is not installed), and HTTP
422 for an unresolvable `"latest"` or an invalid version; the problem `code`
is appended to the error message, for example
`HTTP 409: Skill version already installed. (skill_version_already_installed)`.
Listing needs `hubs:inspect` (`hubs:read` implies it); the writes need
`hubs:write` and a paid plan. Hub-restricted tokens are honoured.

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

### Transport Security

`wss`, `https`, and `mqtt` connections perform the HiveMind **v3 Noise handshake**
(`Noise_XXpsk2_25519_ChaChaPoly_SHA256`, or `KKpsk0` once the hub's static key
is pinned). It is the only key exchange a HiveMind-core 5.x hub accepts: there
is no pre-shared `crypto_key` any more, no cleartext path, and a connection that
cannot complete the handshake is closed with WebSocket `1008`.

Nothing extra has to be provisioned. The Noise pre-shared key is derived from
the identity `password` with argon2id, salted with the hub's node id, so an
identity that can authenticate can already handshake. All of it runs on the
audited `@noble` packages, so a browser bundle does the same work with no Node
builtins.

Two pieces of state persist. In Node they are files beside the SDK config file
(`~/.config/thalovant` unless `XDG_CONFIG_HOME` or `%APPDATA%` says otherwise),
both `0600`; in a browser they live under a `localStorage` namespace:

- `noise_key` — this client's static X25519 key. It has to persist: a hub pins
  it on first contact, so regenerating it makes the client look like a
  different peer and the hub refuses it.
- `noise_pins.json` — the hub static keys this client has pinned.

Point both somewhere else with the `noiseStateDir` client option. The same
option is accepted by `fromIdentityFile`, `fromConfig`, and `fromEnv`; keep that
private directory across reconnects and process restarts.

The first connection to a hub trusts the key it presents and records it. A
later connection presenting a different key is **refused**, because the SDK
cannot tell a reinstalled hub from another machine answering at the same
address. If the hub really was replaced, clear the pin deliberately:

```ts
import { forgetNoisePin } from "@thalovant/sdk";

await forgetNoisePin(undefined, nodeId);
```

The derivation costs 64 MiB and a few hundred milliseconds. A transport caches
the result per hub, so reconnects pay it once.

<!-- The browser caveat is worth stating plainly rather than leaving a reader
     to hit it as a 1008 close. -->
In a browser, a viewer whose site data is cleared or who opens a private window
loses the static key, and a hub that pinned the old one will refuse the
reconnect until an operator clears its pin. That is a browser storage limit,
not something the SDK can work around.

HTTPS preserves the hub's replica-affinity cookie and carries Noise ciphertext
through the binary send and poll endpoints. MQTT sends an admission HELLO, then
uses raw Noise ciphertext on the existing per-client topics. Broker reconnects
perform a fresh Noise handshake before accepting application sends.

Failed authentication never clears a server pin automatically. Retain
`noiseStateDir` across reconnects and process restarts. `healthcheck()` reports
`handshakeComplete: false` after connection loss or invalid ciphertext; a socket
or HTTP 200 response alone does not make the client ready.

```ts
const client = new ThalovantClient(identity, {
  protocol: "https", // or "wss"; "mqtt" is available in Node
  noiseStateDir: "/path/to/private/persistent/sdk-state",
});
await client.connect();
```

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
honors an explicit `tls: true` flag by upgrading `mqtt://` to `mqtts://` and
`ws://` to `wss://`. The effective URL must use `mqtts:`, `ssl:`, or `wss:`;
unsupported and plaintext schemes are refused before broker credentials reach
the connector.

`connect(timeoutMs)` returns only after authenticated readiness. One caller
budget covers waiting for an earlier attempt, transport setup and readiness.
Timeout rejects promptly even if cleanup is slow; the client retains ownership
until both the retired connect and cleanup finish, so a replacement cannot
reuse or be closed by that session. `close(timeoutMs)` cancels active/queued
connects and waits within its own budget (default 6000ms). If it times out,
`waitForClosed()` observes the actual retained cleanup, including failure. Both
methods reject if HTTP cleanup is refused or its acknowledgment is invalid.
An acknowledgment containing `ok: false` is invalid even if its status says
`Disconnected`. The exact one-field replies `{ "error": "Already Disconnected" }`
and `{ "error": "Client is not connected" }` confirm idempotent cleanup; adding
other fields to either reply leaves cleanup unconfirmed.
Keep the client and retry `close()`; hand the identity to a different client
only after cleanup succeeds. Connection diagnostics retain the cleanup failure.

The MQTT transport shares its remaining budget across broker connection,
subscription, admission, Noise authentication, and online presence. A stalled
step fails the attempt and closes its broker connection. HTTP connection failure
cleanup also uses the original connect deadline; when cleanup times out, the
transport retains ownership and replica affinity so a later close or reconnect
can retry it. The original connection error remains the caller's failure even
when that cleanup also fails. HTTP errors omit authorization URLs and raw
response details.

Node serializes Noise state transactions across processes sharing a directory.
A lock wait is bounded to five seconds. Corrupt or unreadable keys and pins fail
without changing their bytes. After a crashed writer, confirm it has stopped
before removing `.noise-state.lock`; do not delete keys or pins to clear a lock.

## Using In The Browser

The SDK also runs in browsers. The control plane (`login`, `listPublicHubs`,
`createClientIdentity`, memory, analytics) uses the global `fetch`, and
`ThalovantClient` works over the `wss` and `https` protocols using the global
`WebSocket` and the same authenticated v3 Noise handshake and payload ciphers
as Node. PSK derivation uses WebAssembly.

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
- The legacy `encryptAsJson`, `decryptFromJson`, `encryptAsBinary`,
  `decryptBinary`, and their async variants were removed by the v3 Noise
  migration. Use the client and transport APIs for authenticated messages.
- The browser state queue coordinates one page only. Give independent tabs
  distinct runtime identities and Noise storage namespaces; it does not provide
  a cross-tab lock.
- Browsers ignore the SDK `user-agent` header on control-plane requests, and a
  client identity is a secret: only embed identities scoped to public or
  kiosk-style hubs in web apps.

Use a fresh request ID for each logical Ask and a fresh query ID for each
logical Query. One client rejects overlapping collectors with the same ID
before dispatch. Ask request IDs and scoped Query IDs are separate namespaces.
Cancellation or completion releases the reservation after listeners retire.
This guard does not make an ID safe to reuse: after a timeout or cancellation,
a late reply can still arrive. Use a new ID for every later logical operation;
correlation IDs are not idempotency tokens.

Intent descriptions may return a partial result after a timeout only when at
least one actual definition was received. Empty or unknown-intent replies alone
do not hide missing responses; a fully answered set of empty replies succeeds.

## Conversations

Use a conversation when related turns should share one session.

Ask and Query replies report the first nonempty session ID from accepted runtime
events, falling back to the requested session when the hub omits it. The reply
request ID remains the caller's correlation ID. Query stops at completion or a
hard failure and returns immediately; its retained `replySettleMs` option has no
effect after completion. Ask retains its bounded speech collection window.

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

`ask`, `query` and `waitForEvent` use a twelve-second default total `timeoutMs` budget,
including authenticated connection readiness. Ask and Query include sending and
reply collection in that budget. `emptyReplyWaitMs` (five seconds by default) allows
speech after a soft intent miss; `replySettleMs` (250 ms) collects adjacent
fragments after the first speech. Both windows are capped by the remaining total
budget. A policy denial or explicit query timeout is terminal: earlier speech
remains a failed partial reply, and later speech cannot change the result.

Pass an `AbortSignal` as `options.signal` to `ask`, `query` or `waitForEvent`, including
conversation Ask and Query calls. Cancellation rejects with `AbortError`, even
after partial speech, and removes the
collector's timers and listeners. It does not close an already authenticated
shared connection. `connect(timeoutMs, signal)` also supports cancellation: an
aborted queued caller leaves the active connection owner intact, while an
aborted initiating caller retains ownership of its connection cleanup. Once a
transport write has started, cancelling collection cannot retract that request;
the transport still owns and observes the write, and the SDK never replays it.
An accepted Query completion or hard failure remains terminal if cancellation or
a write error arrives afterwards. Query ignores all later events.

```ts
const controller = new AbortController();
const pending = client.conversation().query("What time is it?", {
  timeoutMs: 12_000,
  signal: controller.signal,
});
// Call controller.abort() when the user cancels this request.
const reply = await pending;
```

Event waits subscribe before connecting so an authenticated early event is
retained. `on(name, handler, options)` remains a callback subscription; close it
when finished. It does not create a queued asynchronous event stream.


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
the default (`describe: true`); `intents(langs, { describe: false })` skips
those descriptions. A hub that refuses a query rejects with
`ThalovantPolicyDeniedError` naming the type. When the hub refuses or does not
answer `ovos.intent.list` and `fallback` is on (the default), the SDK falls back to
the engines' manifests, listing intent names only and marking the result
`source: "engine-manifests"` with `denied: ["ovos.intent.list"]`. A refused
`ovos.intent.describe` rejects either way, and a hub that answers the listing
with `ok: false` rejects with `ThalovantRuntimeError` carrying the hub's
`error`: a refused listing is not an empty hub. With `fallback: false`, a silent
listing still times out; silence from the engine queries also remains an error.
The `denied` field records a refused or unanswered listing query.

The optional `ovos.skills.fallback.list` probe adds at most 1500ms, or the smaller
query timeout. `inventory.fallbacks` contains `HubFallback` rows sorted by
priority and skill ID. `fallbacksKnown` distinguishes a confirmed empty list
from unavailable, denied or unanswered discovery. `inventory.mayAnswer(lang)`
is true for enabled intent phrases, any fallback skill, or unknown fallback
support; it is a conservative hint, not a guarantee. JSON serialization uses
`fallbacks` and `fallbacks_known`. A bare language string is accepted as one tag.

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
  `intents(...)` falls back to intent names when `ovos.intent.list` is the
  refused or unanswered type and `fallback` is on; a refused `ovos.intent.describe` rejects.
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
- `controlPlane.listHubSkills(hubId)`
- `controlPlane.listHubSkillHistory(hubId, options)` with optional integer `limit` (1–200, default 50)
- `controlPlane.installHubSkill(hubId, skill, options)` with optional `version`, `wait`, and `timeoutMs`
- `controlPlane.updateHubSkill(hubId, skill, { version, wait, timeoutMs })` — `version` required
- `controlPlane.removeHubSkill(hubId, skill, options)` with optional `wait` and `timeoutMs`
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

Control-plane requests reject redirects. Credential-bearing requests require HTTPS;
explicit `http://localhost`, `http://127.0.0.1` and `http://[::1]` endpoints remain
available for local development. API URLs must not contain embedded credentials.

Routed `query()` uses one deadline across connect, send, response and optional
settling. Intent misses may recover through later speech before completion.
Completion, policy denial and query-timeout events end collection; later events
are ignored. A hard failure after speech returns that partial reply with
`ok: false`; a hard failure before any speech raises a runtime error.


### Shared-runtime skill management

Hub-addressed skill methods select the runtime group attached to the hub UUID.
Every hub sharing that group sees the same skill changes and history. The API
requires a restricted token to cover all served hubs. Reads need `hubs:inspect`
(`hubs:read` implies it); writes need `hubs:write`, an eligible paid plan and ownership.

The history response contains newest-first `event` and `operation` entries,
including nullable actor/version fields. Its limit is 1–200 (50 where omitted).
An accepted mutation is not proof the skill is ready. Optional waiting polls the
operation, with a 120-second default timeout and two-second interval. Polling
never repeats an accepted mutation and starts no new read after its deadline;
an already-running HTTP request retains its normal request timeout.

Read history with `api.listHubSkillHistory(hubId, { limit: 50 })`; it returns the API JSON envelope.

## Request helpers and safe configuration updates

Request hints carry a recognized language, ordered intent pipeline, and caller
location without changing the caller's context. Empty hints are omitted. The
location helper requires a city and omits invalid or zero/zero coordinates.
The hub validates language hints against its configured languages.

Replies expose their reported language, ordered speech/audio events, and a
count of dropped media. Embedded skill clips are limited to 4 MiB each and
16 MiB per reply, checked before retention and decoding. Audio does not extend
the reply settlement window. Decoding accepts hexadecimal bytes with ASCII
whitespace between bytes; it never fetches a skill-supplied URL or file path.
The application owns playback (the `play`/`Play` function in this example).

```ts
const location = buildLocation({ city: "Montréal", country: "CA", latitude: 45.5, longitude: -73.5 });
const reply = await client.ask("Quel temps fait-il ?", { sttLang: "fr-ca", location });
for (const event of reply.mediaEvents ?? []) if (event.isAudio) play(event.audioBytes());
const sentences = intent.examples("en-us", 2, { speakable: true, slots: { location: "Montréal" } });
await api.updateRuntimeGroupConfig(groupId, { tts: { module: "piper" } });
// Explicit full replacement:
await api.updateRuntimeGroupConfig(groupId, fullConfig, { merge: false });
```

Guarded merging requires the `hubs:read` and `hubs:write` scopes and a paid plan.
Safe merging requires an API whose configuration GET returns a valid `revision`
and whose configuration PUT checks `expected_revision`. The SDK rereads and
reapplies the original delta only after HTTP 412, with at most three attempts.
Arrays and scalar values replace; objects merge recursively. Personas replace
only when explicitly supplied. Connection failures, redirects, other statuses,
and ambiguous write results are never retried. No unsafe PATCH fallback is used.
Unconditional replacements must still be coordinated with other writers.

Use the explicit replacement operation shown above when a complete replacement
is intended, including when working with an older API. Existing code relying on
replacement must opt into it when upgrading. Raw intent patterns remain the
default; speakable examples remove optional parts, choose alternatives, and
substitute caller-supplied slots while retaining complete-phrase priority.

The audio limits use encoded-length upper bounds before decoding, so formatting
whitespace consumes budget too. Like Python's `bytes.fromhex`, ASCII whitespace
alone decodes to zero bytes. Bounded malformed clips remain available as event
metadata and fail when decoded; they are never fetched or played automatically.
Distinct audio events may intentionally repeat identical sound content. Only
repeated delivery of the same event object is suppressed where object identity
is available, without counting it as a dropped clip. Rendered example ranking
uses the original pattern's slot presence even when sample values are supplied.

Guarded merges reject integers outside JavaScript’s safe range before writing,
so reading and merging cannot silently round an untouched configuration value.
Represent large identifiers as strings or use an SDK with lossless integers.

Guarded configuration merges in 0.5.1 also reject non-finite values before
serialization and validate supplied personas for unsafe integers. Stored
numeric exponents that overflow JavaScript numbers are rejected before writing.

### Locale-aware intent listings

Version 0.6.0 adds sentence rendering and includes a generated snapshot of
[`thalovant-languages` 0.1.1](https://github.com/thalovant/thalovant-languages/tree/v0.1.1).
The language rules work in browsers and Node without network or filesystem access.

```ts
import { asSentence, ListingRules, speakable } from "@thalovant/sdk";

asSentence("quelle heure est-il", "fr-CA"); // "Quelle heure est-il?"
speakable("volume [to] {level} percent", {}, "en"); // "volume fifty percent"
intent.examples("fr-CA", 2, { sentence: true });
```

`sentence: true` also renders patterns. Explicit `slots` override locale examples.
Unknown languages keep slot names and capitalized, unpunctuated lines. A phrase
that already has punctuation or ends on a known prefix remains unchanged.
Omitting the language preserves the first registration's locale. Exact language
tags take priority; regional fallback stays within the same language and script,
with registration order breaking ties. Python uses OVOS's CLDR distance matcher,
so ties among multiple regional variants can select a different registration.

Examples rank complete phrases ahead of prefixes and slot patterns, then prefer
fuller wording up to eight words. Rendered duplicates and empty phrases do not
consume the limit. A non-positive limit returns all results; raw unlimited
phrases retain registration order.

For an application-defined data tree, construct `new ListingRules(data)` using
`{ sentence_ends, languages }` and the canonical listing keys. The SDK snapshots
the input. Pass it as the `listing` option to `examples`, or as the last argument
to `speakable` and `asSentence`. `new ListingRules(null)` selects bare rendering
without locale data. Custom regex rules use JavaScript Unicode syntax and may
start with Python-style global `(?i)`, `(?m)`, or `(?s)` flags. Invalid regex rules
fail during construction. Regenerate bundled data with
`node scripts/sync-listing-data.mjs /path/to/thalovant-languages` at the pinned commit.
