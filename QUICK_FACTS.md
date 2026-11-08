Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Browser sign-in surface and the loopback listener (0.11.0).

# Quick facts: @thalovant/sdk

| Fact | Value |
| :--- | :--- |
| Package | `@thalovant/sdk` (npm) |
| Version | 0.11.0 (`package.json`, `src/version.ts` `SDK_VERSION`) |
| Licence | MIT |
| Runtime | Node.js 20 or newer; browsers through the package's `browser` map (`platform/node.js`, `loopback.js` and `transport-mqtt.js` swapped for their browser twins) |
| Entry point | `dist/src/index.js` (ESM), types `dist/src/index.d.ts` |
| Source of the entry point | `src/index.ts` |
| Tests | `npm test` (builds with `tsc`, then `node --test dist/test/*.test.js`) |
| Package check | `npm pack --dry-run` |
| Parity contract | `contracts/sdk-parity.json`, checked by the `SDK parity` workflow; reference digests `57c7e71f6456` (current) and `49744ee385bf` (candidate) |
| Conformance record | `contracts/conformance-results.json`, written by `npm run record-conformance` |
| Release | merge to `main`; `.github/workflows/auto-release.yml` publishes the version in `package.json` when no tag has it |

## Sign-in surface (0.11.0)

| Method on `ThalovantControlPlane` | Routes | Resolves with | Rejects with |
| :--- | :--- | :--- | :--- |
| `browserLogin({ scopes?, deviceName?, openBrowser?, timeoutMs?, prompt?, signal?, openUrl? })` | `GET /v1/auth/native/config`, then `POST {token_endpoint}` (`/v1/auth/native/token`) | the token answer (`JsonRecord`) | `ThalovantDeviceLoginDeniedError`, `ThalovantDeviceLoginExpiredError`, `ThalovantApiError`, `TypeError` (cleartext API), `AbortError` |
| `interactiveLogin({ method?, scopes?, deviceName?, openBrowser?, timeoutMs?, signal?, openUrl? })` | browser sign-in, or device login (`POST /v1/auth/device/authorize`, `/v1/auth/device/token`) | the token answer | the chosen method's errors |
| `loginWithBrowser(...)` (device login, unchanged) | `POST /v1/auth/device/authorize`, `/v1/auth/device/token` | the token answer | unchanged |

| Fact | Value |
| :--- | :--- |
| Capability | `browser-login` (required), vectors `test/browser-login-vectors.json` (98 cases, sha256 `9058adf2ad30...`) |
| Method names | `LoginMethod = "auto" \| "browser" \| "device"`; default `auto` |
| Redirect | `http://127.0.0.1:<port>/callback`, port bound as 0 on `127.0.0.1` only (`loopbackRedirectUri`) |
| Client id | `SDK_CLIENT_ID = "thalovant-sdk"` (the configuration's `sdk_client_id` wins) |
| Timeouts | browser 300000 ms (`DEFAULT_BROWSER_LOGIN_TIMEOUT_MS`), device login 900000 ms |
| Device name | `thalovant-node-sdk on <hostname>`, at most 120 code points (`MAX_DEVICE_NAME_LENGTH`) |
| Browser rule | `canOpenBrowser(env?, platform?)`: never with `CI`, `SSH_CONNECTION`, `SSH_TTY`; macOS and Windows yes; elsewhere `DISPLAY` or `WAYLAND_DISPLAY` |
| Pure pieces | `src/native-auth.ts`: `browserAuthorizationUrl`, `loopbackRedirectUri`, `newState`, `newVerifier`, `challengeFor`, `NativeSignInConfig.fromResponse`, `canOpenBrowser`, `defaultDeviceName` |
| Listener | `src/loopback.ts` (`LoopbackListener`, `classifyRequest`, `responseBytes`; `node:net`, internal); `src/loopback.browser.ts` refuses in a browser bundle |
| Tests | `test/browser-login-vectors.test.ts` (the vectors), `test/browser-login.test.ts` (edges), `test/browser-smoke.test.ts` (the browser bundle) |

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
