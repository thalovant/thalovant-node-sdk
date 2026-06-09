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
  const reply = await client.ask("Tell me a short clean joke.");
  console.log(reply.text);
} finally {
  await client.close();
}
```

`new ThalovantControlPlane()` uses `https://api.thalovant.com` by default. Pass
a different URL only for local development or a self-hosted control plane.

Keep `result.identity` secret. It contains the client credentials used by the
hub. Do not log `result.asObject({ includeSecrets: true })`.

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

## Use An Existing Identity

If you already downloaded an identity from the dashboard or stored one from a
previous provisioning step:

```ts
import { ThalovantClient } from "@thalovant/sdk";

const client = await ThalovantClient.fromIdentityFile("_identity.json");
try {
  const reply = await client.ask("What can this hub do?");
  console.log(reply.text);
} finally {
  await client.close();
}
```

Environment variables are supported too:

```ts
const client = ThalovantClient.fromEnv();
```

## Protocols

Hubs may expose one or more public data-plane protocols:

- `wss`: secure realtime WebSocket, the default public path.
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
treated like a password.

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

## Common Issues

- `Missing Thalovant API access token`: call `api.login(...)` before private
  control-plane actions, or pass `accessToken` to `ThalovantControlPlane`.
- `API access requires a paid plan`: upgrade the workspace before using the SDK
  control-plane API to provision private resources.
- `Unsupported protocol`: the hub does not expose that protocol, or the
  identity was created before that protocol was enabled.
- MQTT fails immediately: create or download a fresh client identity after MQTT
  is enabled. MQTT needs the per-client `identity.mqtt` credentials.
- A request times out: pass a larger `timeoutMs` to `ask(...)` or
  `waitForEvent(...)`.

## API Shape

- `new ThalovantControlPlane()`
- `new ThalovantControlPlane(apiUrl, options)` for local or self-hosted control planes
- `controlPlane.login(email, password, options)`
- `controlPlane.listPublicHubs(options)`
- `controlPlane.getPublicHub(hubRef)`
- `controlPlane.listHubs(options)`
- `controlPlane.getHub(hubId)`
- `controlPlane.createClientIdentity(hubId, options)`
- `ThalovantClient.fromIdentityFile(path)`
- `ThalovantClient.fromEnv()`
- `new ThalovantClient(identity, { protocol })`
- `client.ask(text, options)`
- `client.sendUtterance(text, options)`
- `client.sendAction(payload, options)`
- `client.sendCode(value, options)`
- `client.emit(eventType, data, context)`
- `client.waitForEvent(eventName, options)`
- `client.on(eventName, handler, options)`
- `client.conversation(options)`

## Development

```bash
npm install
npm test
```
