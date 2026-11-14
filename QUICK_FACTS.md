Last Edit: Claude Sonnet 5.5 - 2026-11-11 - Motive: Intercom (0.12.0): wait scope after the PR 112 review; final API (urgent scope, speaker kind/can_play/policy_synced, typed errors, replayed).

# Quick facts: @thalovant/sdk

| Fact | Value |
| :--- | :--- |
| Package | `@thalovant/sdk` (npm) |
| Version | 0.13.0 (`package.json`, `src/version.ts` `SDK_VERSION`) |
| Licence | MIT |
| Runtime | Node.js 20 or newer; browsers through the package's `browser` map (`platform/node.js`, `loopback.js` and `transport-mqtt.js` swapped for their browser twins) |
| Entry point | `dist/src/index.js` (ESM), types `dist/src/index.d.ts` |
| Source of the entry point | `src/index.ts` |
| Tests | `npm test` (builds with `tsc`, then `node --test dist/test/*.test.js`) |
| Package check | `npm pack --dry-run` |
| Parity contract | `contracts/sdk-parity.json`, checked by the `SDK parity` workflow; reference digests `57c7e71f6456` (current) and `6dfb3bb31ac7` (candidate, Python #113 at 39e31d8) |
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
| Capability | `browser-login` (required), vectors `test/browser-login-vectors.json` (119 cases, sha256 `b0c73f808c4f...`) |
| Method names | `LoginMethod = "auto" \| "browser" \| "device"`; default `auto` |
| Redirect | `http://127.0.0.1:<port>/callback`, port bound as 0 on `127.0.0.1` only (`loopbackRedirectUri`) |
| Client id | `SDK_CLIENT_ID = "thalovant-sdk"` (the configuration's `sdk_client_id` wins) |
| Timeouts | browser 300000 ms (`DEFAULT_BROWSER_LOGIN_TIMEOUT_MS`), device login 900000 ms |
| Device name | `thalovant-node-sdk on <hostname>` when none is given, at most 120 code points (`MAX_DEVICE_NAME_LENGTH`); `""` sends none |
| Callback errors kept | RFC 6749's seven codes (`OAUTH_ERRORS` in `src/loopback.ts`); anything else is null |
| Listener limits | head 16 KiB (`MAX_REQUEST_HEAD`), head read 10 s, drain 2 s / 1 MiB after every answer; the accepted tab waits for the end |
| Request bound | configuration and exchange 10 s each; no request leaves the API's origin |
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

## Intercom (0.12.0; scopes `intercom:read`, `intercom:send`, `intercom:urgent`, `hubs:write`)

`announce({ wait: true })` polls `getAnnouncement` (`intercom:read`, which `intercom:send` implies); `priority: "urgent"` (every `repeat`) needs `intercom:urgent` as well as `intercom:send`. Announce-only text spoken aloud on a hub's speakers. Not a certified safety system; the API does not store the text (keyed hash and length only). Named `announce` / `*Intercom*`: the mesh already has an `intercom` frame.

| Call | Endpoint | Returns |
|---|---|---|
| `getIntercomSettings(hubId)` | `GET /v1/hubs/{id}/intercom/settings` | `IntercomSettings` |
| `setIntercomSettings(hubId, enabled)` | `PUT /v1/hubs/{id}/intercom/settings` | `IntercomSettings` |
| `listIntercomSpeakers(hubId)` | `GET /v1/hubs/{id}/intercom/speakers` | `IntercomSpeakerList` (speakers have `kind`, `can_play`; the list `policy_synced`, `unavailable_reason`) |
| `updateIntercomSpeaker(hubId, clientId, { receive?, room?, groups?, dnd? })` | `PATCH /v1/hubs/{id}/intercom/speakers/{client_id}` | `IntercomSpeaker` |
| `announce(hubId, { text, targets, priority?, repeat?, lang?, idempotencyKey?, wait?, waitTimeoutMs?, pollIntervalMs? })` | `POST /v1/hubs/{id}/intercom/announce` | `Announcement` (`replayed`; deliveries have `detail`) |
| `getAnnouncement(hubId, id)` | `GET /v1/hubs/{id}/intercom/announcements/{id}` | `Announcement` |
| `cancelAnnouncement(hubId, id)` | `POST /v1/hubs/{id}/intercom/announcements/{id}/cancel` (`intercom:send`; 409 `not_cancellable`) | `Announcement` (`status: "cancelled"`, optional `hub_confirmed`) |
| `listAnnouncements(hubId, { limit?, cursor? })` | `GET /v1/hubs/{id}/intercom/announcements` | `AnnouncementList` |

- Models: `src/intercom.ts`. Errors (`src/errors.ts`): `ThalovantIntercomDisabledError`, `ThalovantHubUnreachableError` (502; the text may or may not have been spoken; `announcementId` names the `failed` record: read it before sending again, and use a new key), `ThalovantNotCancellableError` (409), `ThalovantRateLimitedError`; the plan error is HTTP 402 or 403 `plan_limit` (`ThalovantPlanError`). Final-API errors (constants in `IntercomProblemCode`): `ThalovantUrgentScopeRequiredError`, `ThalovantUrgentBusyError` (`scope`), `ThalovantSkillNotInstalledError`, `ThalovantNotASpeakerError` (`kind`, `notSpeakers`), `ThalovantReservedNameError`, `ThalovantHubLockedError`, `ThalovantImpersonationNotAllowedError`, `ThalovantTooManyTargetsError` (`matched`), `ThalovantIntercomUnavailableError` (`reason`), `ThalovantIntercomPlatformDisabledError`, `ThalovantIntercomNotConfiguredError`, `ThalovantManagedClientError`; `ThalovantNotCancellableError.announcementStatus`. Text rule: NFC, 1-280 code points, no `<` `>`, control, bidi/format characters or lone surrogates; DND on needs a valid IANA timezone and `start !== end`; at most 50 names per target list.
- Idempotency: one fresh `crypto.randomUUID()` key per announcement; the same key replays the stored result (`Idempotency-Replayed: true`) and never re-sends (a replayed `failed` stays `failed`). Ids (hub, client, announcement) that are `.`, `..`, empty or hold `/ ? #`, a backslash or a control character are refused before any request (`intercomId`, `src/intercom.ts`). No request timeout is set by the SDK.
- Tests: `test/intercom.test.ts`.
