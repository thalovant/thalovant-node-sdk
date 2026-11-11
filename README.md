<!-- Last Edit: Claude Sonnet 5.5 - 2026-11-11 - Motive: Intercom (0.12.0): announce, speakers and settings on the control plane. -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/thalovant/.github/main/profile/assets/thalovant-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/thalovant/.github/main/profile/assets/thalovant-logo-light.png">
    <img src="https://raw.githubusercontent.com/thalovant/.github/main/profile/assets/thalovant-logo-light.png" alt="Thalovant" width="320">
  </picture>
</p>

# Thalovant Node.js SDK

[![npm](https://img.shields.io/npm/v/@thalovant/sdk)](https://www.npmjs.com/package/@thalovant/sdk) [![CI](https://github.com/thalovant/thalovant-node-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/thalovant/thalovant-node-sdk/actions/workflows/ci.yml) [![Licence](https://img.shields.io/github/license/thalovant/thalovant-node-sdk)](LICENSE) [![Docs](https://img.shields.io/badge/docs-docs.thalovant.com-5c6bc0)](https://docs.thalovant.com/developers/sdks/node/)

TypeScript SDK for connecting Node.js apps, services, and agents to Thalovant
hubs.

The control API is used to discover hubs and provision a client identity. After
that, the SDK talks directly to the hub data plane over HTTPS, WSS, or MQTTS.

Full documentation: <https://docs.thalovant.com/developers/sdks/node/>

## Requirements

- Node.js 20 or newer.
- A Thalovant account with API access for authenticated control-plane actions.
- A hub id or slug.
- A client identity for that hub. You can create one through the API or use one
  downloaded from the dashboard.

## Install

```bash
npm install @thalovant/sdk
```

## Quick start

```ts
import { ThalovantClient, ThalovantControlPlane } from "@thalovant/sdk";

const api = new ThalovantControlPlane();

// Public hub discovery does not require auth.
const publicHubs = await api.listPublicHubs({ limit: 12 });
for (const hub of publicHubs.data as Array<{ id: string; slug: string; title: string }>) {
  console.log(hub.id, hub.slug, hub.title);
}

// Auth is required when creating a client identity. This opens the browser on
// this machine, or prints a code to approve from any browser where there is none.
await api.interactiveLogin();

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

Keep `result.identity` secret: it holds the client credentials the hub uses. The
raw hub and client records carry bootstrap credentials too. `result.asObject()`
redacts the identity, hub and client credentials, and `result.asObject({
includeSecrets: true })` returns the real ones, so use it only to persist the
identity and never log it. The `selectedEndpoint` it reports is the URL as the
API returned it, so do not log an endpoint that embeds credentials.

## Sign in

```ts
import { ThalovantControlPlane } from "@thalovant/sdk";

const api = new ThalovantControlPlane();
await api.interactiveLogin(); // the browser here, or a device code where there is none
// { method: "browser" } or { method: "device" } forces one.
```

`interactiveLogin()` opens your browser at the Thalovant consent page and
listens on `127.0.0.1` for the answer (OAuth with PKCE on a loopback redirect,
RFC 8252). It always prints the address too, in case the browser does not
open. The browser that approves hands its code to this computer's `127.0.0.1`, so a browser sign-in link, or the code it brings back, sent to someone on another computer delivers nothing to the sender. That is all it promises: a forwarded callback port (`ssh -L`, a port-forwarding tool) or another user of this computer can still complete one. A device code (below) is different: whoever approves it, from any computer, signs this program in, which is why the browser comes first wherever there is one.

On a machine that cannot show a browser, it prints a code to enter at
`thalovant.com/activate` from any browser instead: over SSH, in CI, or on Linux
with neither `DISPLAY` nor `WAYLAND_DISPLAY`. It does the same against an API
that does not offer browser sign-in yet. Once the browser has been opened, its
outcome stands: a denied or expired browser sign-in never becomes a device
login. `browserLogin()` and `loginWithBrowser()` (the device login) are the two
methods on their own. Browser sign-in needs Node: a web page cannot listen on a
port, so in a browser bundle `interactiveLogin()` uses the device login and
`browserLogin()` refuses.

| Option | Default | Meaning |
| :--- | :--- | :--- |
| `scopes` | the API's: `hubs:read`, `clients:write` | What the token may do. Any non-admin scope may be asked for. |
| `deviceName` | `thalovant-node-sdk on <hostname>` | What the consent page and the token show (at most 120 characters). Only a missing name gets the default: `""` sends none, and keeps the hostname off the consent page (a device login then sends no `client_name`). |
| `openBrowser` | `true` | `false` only prints the address. |
| `timeoutMs` | 300000 (browser), 900000 (device login) | How long to wait for an answer, in milliseconds; a negative or `NaN` one is refused (`RangeError`). |
| `signal` | none | An `AbortSignal` that cancels the sign-in and closes the port. |
| `openUrl` | the platform's opener (`open`, `xdg-open`, or `rundll32 url.dll,FileProtocolHandler` on Windows) | A function `(url: string) => unknown` that opens the page in its place. Anything but a function is refused (`TypeError`). |
| `prompt` (`browserLogin()` only) | prints the address | A function `(url: string) => void` that shows the URL in place of the print. It does not stop the browser from opening when `openBrowser` is `true`; with `openBrowser: false` nothing opens, and the sign-in waits until somebody opens the URL or `timeoutMs` runs out. |

The result is a scoped API token that lasts 365 days and is listed in the
dashboard. It counts against your plan, and `api.revokeApiToken()` revokes it.
`interactiveLogin()` and `browserLogin()` resolve with the token answer, as
`loginWithBrowser()` does, and keep `accessToken` and `tokenId` the same way.

A denied sign-in rejects with `ThalovantDeviceLoginDeniedError`. A browser
sign-in nobody answers within `timeoutMs` rejects with
`ThalovantDeviceLoginExpiredError`, and a code the API will not exchange with a
`ThalovantApiError` whose `detail` is `invalid_grant`. An API URL that is
neither https nor loopback is refused before anything is asked or opened
(`TypeError`). Accounts with a password can still use
`api.login(email, password)`.

## Chat apps

A hub owner can connect a chat network to a hub, and the hub answers there.
Telegram and Discord are offered; Matrix, Mattermost and Twitch are in beta.
Reads need a token with `hubs:read`, writes `hubs:write`, and creating a
bridge needs a paid plan.

Read the allowance first: a Free plan allows none, and `can_create` says
whether one more bridge would pass the plan checks now.

```ts
import { SecretValue, ThalovantApiError, ThalovantControlPlane } from "@thalovant/sdk";

const api = new ThalovantControlPlane(undefined, { accessToken: process.env.THALOVANT_API_TOKEN });

const { networks, allowance } = await api.getBridgeNetworks({ hubId });
if (!allowance.can_create) {
  console.log(`${allowance.used} of ${allowance.limit} chat apps used on the ${allowance.plan} plan.`);
}
const connectors = await api.listChatAppConnectors(); // settings form, secrets, chat id pattern
```

**Telegram** (and Discord): one `token`. Mattermost takes its bot `token`
too, plus the server's address as a setting (`settings: { url:
"https://chat.example.com" }`). The bridge starts in `setup`; choosing its
chats starts it.

```ts
const bridge = await api.createBridge({
  hubId,
  connector: "telegram",
  token: new SecretValue(process.env.TELEGRAM_BOT_TOKEN ?? ""),
});
// Add the bot to a group with bridge.invite_links.add_to_group, then:
const chats = await api.listBridgeChats(bridge.id);
const started = await api.updateBridge(bridge.id, {
  allowed: chats.data.filter((chat) => chat.selectable),
});
await api.sendBridgeTestMessage(bridge.id, started.allowed[0].id);
```

**Matrix**: secrets and settings. Chats are typed, not discovered
(`manual_entry: true`): room ids look like `!abc:example.org`.

```ts
const matrix = await api.createBridge({
  hubId,
  connector: "matrix",
  secrets: { access_token: new SecretValue(process.env.MATRIX_ACCESS_TOKEN ?? "") },
  settings: { homeserver: "https://matrix.example.org", user_id: "@hub:example.org" },
});
await api.updateBridge(matrix.id, { allowed: ["!abc:example.org"] });
```

**Twitch**: two secrets and two settings. Channels are logins; `#Name` is
stored as `name` (the connector's `targets.strip_prefix` and `lowercase`).

```ts
const twitch = await api.createBridge({
  hubId,
  connector: "twitch",
  secrets: {
    refresh_token: new SecretValue(process.env.TWITCH_REFRESH_TOKEN ?? ""),
    client_secret: new SecretValue(process.env.TWITCH_CLIENT_SECRET ?? ""),
  },
  settings: { bot_login: "myhubbot", client_id: process.env.TWITCH_CLIENT_ID ?? "" },
});
await api.updateBridge(twitch.id, { allowed: ["myhubchannel"] });
```

A `SecretValue` prints `[redacted]` everywhere (`String()`, template strings,
`JSON.stringify`, `console.log`); the SDK reads it with `reveal()` only to build
the request. Plain strings are accepted too.

**Pause and resume** with `updateBridge(id, { paused: true })` and
`{ paused: false }`. Pass `{ etag: bridge.etag }` as the third argument to
refuse the change (HTTP 412) if the bridge changed since you read it.

**Status.** `bridge.status.reason` is stable and safe to show:

| `reason` | Meaning |
| :--- | :--- |
| `Setup` | No chats chosen yet. |
| `Starting` | Rolling out, or not reported yet. |
| `Connected` | Running. |
| `Paused` | Paused by the owner, or held by the platform (see `hold`). |
| `Unavailable` | Rolled out but not running, or a platform-side error. |
| `TokenMissing` | The stored token has not reached the bridge yet. |
| `TokenRejected` | The network refused the credentials: `replaceBridgeToken()` or `replaceBridgeSecrets()`. |

A value not listed here may appear later; it is kept as sent. `bridge.hold` is
`null` for the owner's own pause, and `{ reason, since }` when the platform
paused it: `plan_limit` (the plan allows fewer running bridges; resume it once
it has room) or `account_suspended` (it resumes when the account is
reactivated).

**Refusals** are a `ThalovantApiError` with the API's `code`, and `fields`
naming the settings or secrets concerned, never their values:

```ts
try {
  await api.createBridge({ hubId, connector: "matrix", secrets, settings });
} catch (error) {
  if (error instanceof ThalovantApiError && error.code === "bridge_settings_invalid") {
    console.log("Check these settings:", error.fields.join(", "));
  } else {
    throw error;
  }
}
```

A 402 (Free plan) and a 403 `plan_limit` (`problem.resource` is
`chat_bridge`) are a `ThalovantPlanError`; a 401, a 423 and a 403
`Insufficient scopes` are a `ThalovantAuthError`. Every other refusal is a
`ThalovantApiError` to branch on by `code`:

| Status | `code` | When |
| :--- | :--- | :--- |
| 409 | `bridge_bot_in_use` | The bot already serves a bridge: one bot, one bridge. |
| 409 | `bridge_helper_unavailable` | A test message for a connector without that helper. |
| 409 | `bridge_token_missing` | The stored token is gone; `replaceBridgeToken()` restores it. |
| 409 | `bridge_token_other_bot` | `replaceBridgeToken()` with another bot's token: create a new bridge. |
| 409 | `bridge_running` | Listing a running Telegram bridge's chats: pause it first. |
| 409 | `bridge_telegram_updates_busy` | Telegram answered that something else reads the bot's updates. |
| 412 | | `updateBridge()` with a stale `etag` (`detail` is `ETag mismatch`). |
| 422 | `bridge_token_malformed`, `bridge_token_invalid`, `bridge_token_not_a_bot` | The token's shape, or the network refused it. |
| 422 | `bridge_network_refused` | The network refused the request (an unknown chat, a bot removed from it). |
| 422 | `bridge_allowed_required`, `bridge_chat_id_invalid`, `bridge_chat_not_allowed` | An empty `allowed`; a malformed chat id; a test to a chat not allowed. |
| 422 | `bridge_settings_invalid`, `bridge_secrets_invalid` | Settings or secrets the connector does not take; `fields` names them. |
| 422 | `bridge_url_invalid`, `bridge_url_port_not_allowed`, `bridge_url_not_public`, `bridge_url_unresolvable` | An address setting that is not public HTTPS on port 443; `fields` names it. |
| 422 | `bridge_too_many_targets` | More chats than the connector's `targets.max`. |
| 422 | `bridge_mention_required` | `requireMention: false` on a network that only answers mentions (Discord). |
| 429 | `bridge_rate_limited`, `bridge_network_rate_limited` | Too many requests, ours or the network's; wait `retryAfterSeconds`. |
| 502 | `bridge_network_unavailable`, `bridge_secret_store_failed` | The network, or the platform's secret storage, failed. |
| 503 | `bridge_network_not_offered`, `bridge_secret_store_unavailable` | No bridge is offered for that network here; secret storage is unavailable. |
| 504 | `bridge_network_timeout` | The network did not answer in time. |

## Intercom

Say a short text aloud on a hub's speakers. Off by default at every level, announce-only,
and **not a certified safety system**: it does not replace smoke or CO alarms, medical
alert devices or emergency services. The platform never stores the text. (The names are
`announce` and `*Intercom*`: the HiveMind mesh already has an `intercom` frame.)
Scopes: `intercom:read`, `intercom:send`, and `hubs:write` for settings and speakers.

```ts
await api.setIntercomSettings(hubId, true);                                   // hubs:write
await api.updateIntercomSpeaker(hubId, "kitchen", { receive: true, room: "kitchen" });
const said = await api.announce(hubId, { text: "Dinner is ready", targets: { rooms: ["kitchen"] } });
console.log(said.status, said.deliveries.map((d) => `${d.name}: ${d.status}`));

const urgent = await api.announce(hubId, {
  text: "Please answer", targets: { all: true }, priority: "urgent",
  repeat: { times: 3, interval_seconds: 20 }, wait: true,          // polls while `sending`
});
console.log(urgent.status, urgent.acked_by);
```

Refusals are `ThalovantIntercomDisabledError` (switch off, kid or public hub),
`ThalovantHubUnreachableError` (nothing was spoken), `ThalovantRateLimitedError`
(`retryAfterSeconds`) and `ThalovantPlanError`.

## Documentation

Everything else lives in the documentation: <https://docs.thalovant.com/developers/sdks/node/>

The Node SDK page covers install, first request, sign-in (password, MFA,
browser, API token), protocols, browser use, saved identities, provisioning
hubs, skills, events, context, sessions, reply claims and common issues.

| Topic | Link |
| :--- | :--- |
| Node SDK | <https://docs.thalovant.com/developers/sdks/node/> |
| Thalovant product | <https://docs.thalovant.com> |

### Not yet in the online docs

These topics were only in the previous long README and are covered by the docs
page only in passing, or not at all. They remain readable in
[the README as of this change](https://github.com/thalovant/thalovant-node-sdk/blob/1aeb471609de46dafdcd00529b566401262d4b1e/README.md):
linking Home Assistant, durable memory and workspace analytics, reading an API
error, the API shape, and language data refresh.

## Development

```bash
npm install
npm test
```

## Security

See [SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).
