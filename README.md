# Thalovant Node.js SDK

TypeScript SDK for direct Thalovant hub data-plane clients and agents.

Full documentation: <https://docs.thalovant.com/developers/sdks/node/>

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
event, session, conversation, AES-GCM preshared-key, protocol endpoint helpers,
and HTTP transport shape. The live transport targets the preshared-key HTTPS
HTTP-protocol path used by Thalovant public hubs.

## Identity

```json
{
  "access_key": "client-access-key",
  "password": "client-password",
  "crypto_key": "optional-preshared-key",
  "site_id": "my-client-site",
  "default_master": "https://hub.example.com",
  "default_port": 443,
  "default_path": "/public",
  "data_plane_endpoints": {
    "https": "https://hub.example.com/public",
    "wss": "wss://hub.example.com/public",
    "mqtt": "mqtts://mqtt.example.com:8883"
  },
  "protocols": {
    "wss": {"enabled": true},
    "http": {"enabled": true},
    "mqtt": {"enabled": false}
  },
  "mqtt": {
    "endpoint": "mqtts://mqtt.example.com:8883",
    "username": "client-access-key",
    "password": "mqtt-broker-password",
    "topic_prefix": "hivemind/hub-id/client-access-key"
  }
}
```

```ts
import { ThalovantIdentity } from "@thalovant/sdk";

const identity = await ThalovantIdentity.fromFile("_identity.json");

console.log(identity.enabledProtocols());
console.log(identity.endpointFor("https"));
console.log(identity.endpointFor("wss"));
console.log(identity.endpointFor("mqtt"));
console.log(identity.mqtt?.endpoint);
```

You can also create a hub client through the Thalovant API:

```ts
import { ThalovantClient, ThalovantControlPlane } from "@thalovant/sdk";

const api = new ThalovantControlPlane("https://dash.thalovant.com/api");
await api.login("you@example.com", "password");

const result = await api.createClientIdentity("hub-id", { name: "kiosk-1" });
const client = new ThalovantClient(result.identity);
```

The SDK generates `apiKey`, `password`, and `cryptoKey` locally and sends them
to the API once. The API can store them in Vault and return only secret
references. When MQTT is enabled for the hub, the API returns the client-scoped
broker credentials on `result.identity.mqtt`. Do not log
`result.asObject({ includeSecrets: true })`.

## Generic Client Context

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
- `ThalovantControlPlane`
- `controlPlane.createClientIdentity(hubId, options)`
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
