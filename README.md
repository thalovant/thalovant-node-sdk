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

Keep `result.identity` secret: it holds the client credentials the hub uses. The
raw hub and client records carry bootstrap credentials too. `result.asObject()`
redacts them and is safe to log; `result.asObject({ includeSecrets: true })`
returns the real credentials, so use it only to persist the identity and never
log it.

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

These topics were only in the previous long README and are not covered by the
docs page yet. They remain readable in
[the README as of this change](https://github.com/thalovant/thalovant-node-sdk/blob/1aeb471609de46dafdcd00529b566401262d4b1e/README.md):
linking Home Assistant, durable memory and workspace analytics, transport
security details, realtime query timing, rich responses, reading an API error,
the API shape, and language data refresh.

## Development

```bash
npm install
npm test
```

## Security

See [SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).
