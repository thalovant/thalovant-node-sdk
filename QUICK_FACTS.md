Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Created with the chat apps surface (0.10.0).

# Quick facts: @thalovant/sdk

| Fact | Value |
| :--- | :--- |
| Package | `@thalovant/sdk` (npm) |
| Version | 0.10.0 (`package.json`, `src/version.ts` `SDK_VERSION`) |
| Licence | MIT |
| Runtime | Node.js 20 or newer; browsers through the package's `browser` map |
| Entry point | `dist/src/index.js` (ESM), types `dist/src/index.d.ts` |
| Source of the entry point | `src/index.ts` |
| Tests | `npm test` (builds with `tsc`, then `node --test dist/test/*.test.js`) |
| Package check | `npm pack --dry-run` |
| Parity contract | `contracts/sdk-parity.json`, checked by the `SDK parity` workflow |
| Release | merge to `main`; `.github/workflows/auto-release.yml` publishes the version in `package.json` when no tag has it |

## Chat apps surface (0.10.0)

| Method on `ThalovantControlPlane` | Route | Returns |
| :--- | :--- | :--- |
| `listChatAppConnectors()` | `GET /v1/bridges/connectors` | `ChatAppConnector[]` |
| `getBridgeNetworks({ hubId? })` | `GET /v1/bridges/networks` | `BridgeNetworks` |
| `listBridges({ hubId?, ownerId?, limit? })` | `GET /v1/bridges` | `Bridge[]` |
| `createBridge({ hubId, connector, token? \| secrets?, settings? })` | `POST /v1/bridges` | `Bridge` |
| `getBridge(bridgeId)` | `GET /v1/bridges/{id}` | `Bridge` |
| `updateBridge(bridgeId, changes, { etag? })` | `PATCH /v1/bridges/{id}` | `Bridge` |
| `replaceBridgeToken(bridgeId, token)` | `PUT /v1/bridges/{id}/token` | `Bridge` |
| `replaceBridgeSecrets(bridgeId, secrets)` | `PUT /v1/bridges/{id}/secrets` | `Bridge` |
| `listBridgeChats(bridgeId)` | `GET /v1/bridges/{id}/chats` | `BridgeChatList` |
| `sendBridgeTestMessage(bridgeId, chatId)` | `POST /v1/bridges/{id}/test` | `BridgeTestResult` |
| `getBridgeAvatar(bridgeId)` | `GET /v1/bridges/{id}/avatar` | `BridgeAvatar` (`content: Uint8Array`, `content_type`) |
| `deleteBridge(bridgeId)` | `DELETE /v1/bridges/{id}` | `void` |

- Models and open enumerations: `src/chat-apps.ts` (`Bridge`, `BridgeStatus`, `BridgeHold`, `ChatAppConnector`, `BridgeStatusReason` ...).
- Secrets: `SecretValue` (`src/chat-apps.ts`), printed as `[redacted]`, read with `reveal()`.
- Errors: `ThalovantApiError.fields` (`src/errors.ts`), the setting or secret names a refusal is about.
- Tests: `test/chat-apps.test.ts`.
