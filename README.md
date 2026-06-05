# Thalovant Node.js SDK

TypeScript SDK for direct Thalovant HiveMind HTTPS clients and agents.

```bash
npm install @thalovant/sdk
```

```ts
import { ThalovantClient } from "@thalovant/sdk";

const client = await ThalovantClient.fromIdentityFile("_identity.json");
const reply = await client.ask("Tell me a short clean joke.");
console.log(reply.text);
await client.close();
```

## Status

This package is an alpha SDK scaffold. It includes the shared Thalovant identity,
event, session, conversation, AES-GCM preshared-key, and HTTP transport shape.
The live transport currently targets HiveMind HTTP hubs using the preshared-key
handshake path used by Thalovant public hubs.

## Identity

```json
{
  "access_key": "client-access-key",
  "password": "client-password",
  "crypto_key": "optional-preshared-key",
  "site_id": "my-client-site",
  "default_master": "https://hub.example.com",
  "default_port": 443,
  "default_path": "/hivemind/public"
}
```

## Generic Client Context

```ts
import { buildClientContext } from "@thalovant/sdk";

const context = buildClientContext({}, {
  userId: "operator-42",
  userName: "Ada",
  authToken: "access-token",
  authProvider: "oidc",
  roles: ["operator"],
  platform: "mobile",
  source: "line-a-tablet-3",
  channel: "chat",
});

await client.ask("Show the next instruction.", { context });
```

## Actions, Codes, And Rich Output

```ts
const conversation = client.conversation({ sessionId: "work-session" });

await conversation.sendAction('/choose{"id":"42"}', { title: "Choose item" });
await conversation.sendCode("SN-001-XYZ", { kind: "qr", label: "serial" });

const reply = await conversation.ask("Show matching parts.");
for (const item of reply.displayItems({ maxTextChars: 600 })) {
  if (item.kind === "text") console.log(item.text);
}
```

## Development

```bash
npm install
npm test
```

## API Shape

- `ThalovantClient.fromIdentityFile(path)`
- `ThalovantClient.fromEnv()`
- `client.ask(text)`
- `client.sendUtterance(text)`
- `client.sendAction(payload)`
- `client.sendCode(value)`
- `client.emit(eventType, data, context)`
- `client.waitForEvent(eventName)`
- `client.on(eventName, handler)`
- `client.conversation()`
- `buildClientContext(base, options)`
- `displayItemsFromEventData(data)`
