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
  "default_port": 443
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
- `client.emit(eventType, data, context)`
- `client.waitForEvent(eventName)`
- `client.on(eventName, handler)`
- `client.conversation()`
