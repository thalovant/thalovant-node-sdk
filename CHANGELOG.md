# Changelog

## 0.2.39

- `listIntents()` rejects with `ThalovantRuntimeError` when the hub answers `ovos.intent.list` with `ok: false`, instead of reading the missing `intents` key as an empty list. A refused listing is not an empty hub, and reporting it as no intents showed a person a device that can do nothing; the rejection carries the hub's `error` text. The engines' manifests stay the fallback for a policy refusal only, not for a listing the hub answered and failed. `describeIntent()` keeps returning an empty list for `ok: false`, which is a real answer: the hub does not know that registration. Reported by the Kotlin port's review.
- `ThalovantPolicyDeniedError.allowed` keeps only string entries. A number or a null in the hub's `allowed` list is not a message type, and stringifying one put `"3"` or `"null"` in front of an operator reading which types to allow. Reported by the Kotlin port's review.
- README: `intents(...)` needs `ovos.intent.describe` only when definitions are requested, which is the default; listing alone (`describe: false`) needs `ovos.intent.list` alone.

## 0.2.38

- Add the intent inventory: `client.intents(languages)` reads the hub runtime's intent manifest (OVOS-INTENT-4 §10) over the client's own session and resolves to a `HubIntentInventory` — every intent each skill registered, per language, with the sentences a person says to reach it as the skill's locale files wrote them, `{slot}` placeholders included. No control-plane credential is involved. `client.listIntents(lang)` and `client.describeIntent(skillId, intentName, lang)` expose the two underlying queries (`ovos.intent.list` / `ovos.intent.describe`) as `IntentRegistration` rows and `IntentDefinition`s.
- Queries are correlated by `context.request_id` like every other request, and a reply delivered more than once is taken once. Describes are sent together and matched by request id, or by the definition's own `skill_id`/`intent_name`/`lang` for a hub that does not echo the id; a describe the hub never answers leaves that intent without sentences instead of failing the inventory. Language tags compare case-insensitively with `_` and `-` folded (`sameLanguage`), and `intents()` asks each language once, trimmed, in its first spelling.
- Add `ThalovantPolicyDeniedError` (a `ThalovantRuntimeError`), rejected at once from the hub's `hive.policy.denied` with `deniedType`, `code`, `reason` and the `allowed` list, instead of waiting for a timeout. `intents(languages, { fallback: true })`, the default, falls back to the engines' own manifests (`intent.service.adapt.manifest.get` / `intent.service.padatious.manifest.get`) when `ovos.intent.list` is refused; the result then carries names only, `source: "engine-manifests"` and `denied: ["ovos.intent.list"]`.
- A runtime that attaches each row's `definition` to `ovos.intent.list` when asked with `include_definitions` is used as such; one that does not is described row by row. An intent registered under both engines has two rows per language: the first row seen names its engine and the keyword row never erases the template row's sentences. On the fallback, the first engine to name an intent decides its engine (adapt is asked first). `hasPhrases` is true only when at least one intent carries at least one sentence.
- Describes go out in batches of at most 32 (`DESCRIBE_BATCH`), each batch its own subscription window, instead of putting every request in flight at once. A hub with 69 intents in two languages is 138 requests and, with every reply delivered twice, 276 inbound events, which overflows a bounded reply queue, bursts the hub, and makes a silent hub hold every request open; the per-batch deadline now fails after one batch instead. Windows are contiguous slices of the work, so a window that received nothing contributes nothing and the call fails only when no window produced a definition — a skill that stops answering loses its sentences instead of turning the whole inventory into a timeout, while a hub silent from the start still fails at the first window. Reported by the Rust port's review.
- New exports: `HubIntentInventory`, `HubSkillIntents`, `HubIntent`, `IntentRegistration`, `IntentDefinition`, `HubIntentSource`, `SOURCE_MANIFEST`, `SOURCE_ENGINES`, `sameLanguage`, and the event names `EVENT_INTENT_LIST`, `EVENT_INTENT_LIST_RESPONSE`, `EVENT_INTENT_DESCRIBE`, `EVENT_INTENT_DESCRIBE_RESPONSE`, `EVENT_ADAPT_MANIFEST_GET`, `EVENT_ADAPT_MANIFEST`, `EVENT_PADATIOUS_MANIFEST_GET` and `EVENT_PADATIOUS_MANIFEST`. No existing signature changed and the browser bundle is unaffected.

## 0.2.31

- `MqttBrokerCredentials` debug output now redacts `topic_prefix`. Since the 0.2.30 topic migration the prefix is `hivemind/<hub-id>/<access-key>` and embeds the access key that username redaction already hides, so in Node `console.log`/`util.inspect` and `toString()` (and template-literal/`String()` coercion) print `topic_prefix: [redacted]` instead of the raw value. The `includeSecrets` view (`asObject(true)`) and the `topicPrefix` field the transport reads are unchanged, so no wire behavior changes.
- `mqttTopicsForIdentity()` now validates `topic_prefix` before deriving topics. Surrounding whitespace is trimmed first, so a whitespace- or slash-only prefix still throws `MQTT credentials must include topic_prefix.`; a prefix containing an MQTT wildcard (`#` or `+`), a space, or a control character (code point below U+0020, which includes the MQTT-forbidden U+0000) now throws `MQTT topic_prefix contains characters that are not valid in an MQTT topic.` A `+` prefix would otherwise turn `<prefix>/out` into a wildcard subscription and make `<prefix>/in` an invalid publish topic. The check is a character scan, never a regex, so it cannot trip CodeQL's `js/polynomial-redos` rule.

## 0.2.30

- **BREAKING (MQTT data plane)**: migrate HiveMind MQTT topics to the `<topic_prefix>/in|out|status` scheme. Identity MQTT credentials now carry exactly `{ endpoint, username, password, topic_prefix, tls }`, where `topic_prefix` is the full plaintext base `hivemind/<hub-id>/<access-key>`. Publish requests go to `<topic_prefix>/in` (was `c2s`), subscribe replies to `<topic_prefix>/out` (was `s2c`), and retained presence to `<topic_prefix>/status`. `mqttTopicsForIdentity()` now requires a non-empty `topic_prefix` and derives the three topics by suffix; the retired `c2s`/`s2c`/`status` parsing, the `satellite_id`/hash derivation, and the explicit-topic reads are gone. The leading/trailing-slash trim on `topic_prefix` is a character scan, not a regex, so it does not trip CodeQL's `js/polynomial-redos` rule.

## 0.2.29

Security hardening release. No new endpoints or features.

- **BREAKING**: remove the admin analytics branch. `getAnalyticsOverview()` no longer accepts `admin` or `ownerId` and always calls `GET /v1/analytics/overview`; the `GET /v1/admin/analytics/overview` path is gone from the SDK. This SDK is for non-admin Thalovant customers, whose tokens can never use the admin route.
- `createClientIdentity()` result: the default `asObject()` now scrubs the raw `hub`/`client` records too, not just `identity`. The client record's `initial_identify` credential bundle, `initial_identify_token`, and secret-named keys (`apiKey`/`api_key`, `password`, `cryptoKey`/`crypto_key`, `accessKey`/`access_key`, tokens, and similar) are omitted unless you pass `{ includeSecrets: true }`, which still returns the raw records unchanged. The `result.hub`/`result.client` properties themselves are untouched.
- The default `identity.asObject()` view now also filters free-form `metadata`, dropping secret-named entries recursively (nested objects and arrays included), and strips any `user:pass@` userinfo from `default_master`, the data-plane endpoints, and the MQTT endpoint. The `includeSecrets: true` view keeps `metadata` and every URL verbatim, and the `identity.metadata` field the wire path reads is unchanged.
- `ThalovantIdentity`, `MqttBrokerCredentials`, and `ThalovantControlPlane` redact secrets from debug output: in Node, `console.log`/`util.inspect` (via `Symbol.for("nodejs.util.inspect.custom")`) print `[redacted]` instead of `access_key`, `password`, `crypto_key`, the MQTT broker credentials, and the control plane's bearer `accessToken`; `toString()` (and so template-literal/`String()` coercion) prints the same redacted form in Node **and** browsers. Browser devtools enumerate own properties directly, so `console.log(object)` there can still show the fields — browser code should log `identity.asObject()` or the `String(...)` form instead. No `toJSON` was added, so `JSON.stringify` persistence and the wire protocol are byte-for-byte unchanged, and `asObject(true)` still returns real values.
- Thrown `ThalovantApiError` messages no longer embed the raw HTTP response body (which can echo request secrets, for example `POST /v1/clients` validation errors repeating the sent spec). They keep the status plus a short, newline-stripped server detail bounded to 160 characters: structured JSON bodies contribute only a recognized string detail field, and unrecognized JSON is dropped entirely. `createClientIdentity()` additionally scrubs the apiKey/password/cryptoKey it generated out of any error text before it is thrown, before the length bound is applied, so an echoed secret cannot survive even inside a recognized detail string.
- `pollDeviceToken()` and `DevicePollOptions` are now marked `@internal` and stripped from the published type declarations; every other Thalovant SDK keeps the device-token poll internal. The method still exists at runtime and `loginWithBrowser()` is unaffected, but TypeScript consumers should use `loginWithBrowser()` instead.
- README: the "do not log" guidance now says the default `asObject()` is safe to log and that `asObject({ includeSecrets: true })` must never be logged.

## 0.2.28

- Add the hub provisioning surface, which was read-only until now: `createHub(payload, options)`, `updateHub(hubId, payload, { etag })`, `deleteHub(hubId, { etag })`, `releaseHub(hubId, options)`, `setHubRating(hubId, rating)`, `clearHubRating(hubId)`, and `getHubRuntimeCapabilities(hubId)`.
- Add the runtime group and skill surface: `listRuntimeGroups`, `getRuntimeGroup`, `createRuntimeGroup`, `updateRuntimeGroup`, `getRuntimeGroupConfig`, `updateRuntimeGroupConfig`, `releaseRuntimeGroup`, `deleteRuntimeGroup`, `installRuntimeGroupSkill`, and `uninstallRuntimeGroupSkill`.
- Add skill discovery, so callers can find what is installable instead of having to know a skill id: `listMarketplaceSkills(options)` reads the catalog, `listRuntimeGroupMarketplace(runtimeGroupId, options)` resolves that catalog against one group (desired state, observed state, and the plan's `installable`/`purchase_required` verdict), and `listRuntimeGroupInventory(runtimeGroupId, options)` reports only what the group is observed running.
- `PATCH` and `DELETE /v1/hubs/{id}` enforce optimistic locking, so `updateHub` and `deleteHub` take a **required** `etag` option and send it as `If-Match`; a stale *or missing* value is HTTP 412 and changes nothing. The runtime group routes read no `If-Match`. `createHub` sends an `Idempotency-Key` header, generated unless you pass `idempotencyKey`, so a retried create cannot make a second hub.
- Plan and scope gates surface as the usual `ThalovantApiError`: the provisioning writes need a paid plan and `hubs:write` (HTTP 402 on the free plan, HTTP 403 without the scope), the ratings need `hubs:write` with no plan gate, and the three discovery reads are **not** paid-gated at all (`hubs:read` for the catalog, `hubs:inspect` for the two group reads) so a free-plan token can browse before upgrading.
- Unlike `getHubRuntimeCapabilities`, neither group read answers HTTP 409 when nothing is reporting; they return an empty `data` list with the provenance in `source`.
- New exported types: `HubPayload`, `HubWriteOptions`, `RuntimeGroupPayload`, `ReleaseOptions`, `RuntimeGroupListOptions`, `RuntimeGroupConfigOptions`, `RuntimeGroupSkillInstallOptions`, `MarketplaceSkillListOptions`, `RuntimeGroupMarketplaceOptions`, and `RuntimeGroupInventoryOptions`. camelCase options and payload keys map to the API's snake_case bodies and query params, and falsy boolean options are omitted rather than sent as `false`. No existing signature changed and the browser bundle is unaffected.
- Document the provisioning walkthrough (discover skills, create a runtime group, create a hub, install a skill, release) and the skill discovery reads in the README, with the paid-plan and scope requirements per route.

## 0.2.27

- Derive every user agent from a single version constant. `src/version.ts` now owns `SDK_VERSION` and builds `USER_AGENT` from it; `DEFAULT_USER_AGENT` (data plane) and the control plane's default user agent are that one value. Both keep their names and their exact string values, and no runtime behavior changes. The new module imports nothing and reads no files, so browser bundles are unaffected.
- Add `test/version.test.ts`: every user agent must equal `ThalovantNodeSDK/<SDK_VERSION>` as derived (never a hard-coded literal), `SDK_VERSION` must equal the `version` in package.json, and no file under `src/` may hard-code a version inside a user-agent string. This closes the drift class that shipped a stale data-plane user agent in the Python SDK for four releases.
- Repository automation: `auto-release.yml` no longer rewrites the user agents in `src/constants.ts` and `src/control.ts`; it bumps `package.json`, `package-lock.json`, and `src/version.ts` only, and every literal replacement still fails loudly instead of silently matching nothing.

## 0.2.26

- Document the two HTTP 429 responses the control plane returns for token-authenticated calls: `token_rate_limited` (the plan's per-minute request rate, 60 requests per minute on the free plan) and `token_quota_exceeded` (the plan's daily or monthly call quota, reported in `quota`, `limit`, and `used`). Both carry a `Retry-After` header and a matching `retry_after_seconds`, `Retry-After` is authoritative, and the SDK does not retry automatically.
- Correct the CI token example: minted API tokens use the `tvpat_` prefix, not `thal_`.

## 0.2.25

- Add `controlPlane.loginWithBrowser(options)`: sign in through the browser device flow (`POST /v1/auth/device/authorize` plus `POST /v1/auth/device/token`), the sign-in path for accounts without a password such as Google sign-in. It prints `To sign in, visit <verification_uri> and enter the code <user_code>` (override with `prompt`), makes a best-effort attempt to open the default browser at `verification_uri_complete` (disable with `openBrowser: false`), and polls with `authorization_pending` and `slow_down` handling until the request is approved, denied, expired, or `timeoutMs` (default 15 minutes) elapses. On approval the returned durable scoped API token is stored on `accessToken` exactly like `login()`; `access_denied`, `expired_token`, and timeout reject with clear errors.
- Add `controlPlane.pollDeviceToken(deviceCode, options)` with injectable `sleep`/`now` for advanced integrations and tests.
- Browser opening is dependency-free and never fails the sign-in: Node spawns the platform opener (`open`, `start`, or `xdg-open`), web bundles use `window.open`, and any failure falls back to the printed URL.
- Document token authentication for CI and automation: pass a dashboard-minted API token to `new ThalovantControlPlane(url, { accessToken })` (for example from a `THALOVANT_API_TOKEN` environment variable); no login call is needed.

## 0.2.24

- Browser support: the SDK now runs in browsers behind a bundler. The control plane (`login`, `listPublicHubs`, `createClientIdentity`, memory, analytics) and `ThalovantClient` over the `wss` and `https` protocols work in web bundles using the global `fetch`, the global `WebSocket`, and Web Crypto (AES-128-GCM via `crypto.subtle`).
- Add a `browser` map plus a `browser` export condition to package.json so bundlers (esbuild, webpack, Vite, Rollup) substitute browser-safe platform modules and never pull `ws`, `mqtt`, `yaml`, or `node:` builtins into web bundles. The Node entry point and runtime behavior are unchanged.
- The `mqtt` transport stays Node-only: constructing `HiveMindMqttTransport` (or calling `mqttTopicsForIdentity`/`mqttConnectionEndpoint`) in a browser throws `ThalovantUnsupportedProtocolError` with a clear message instead of breaking bundling.
- Identity file helpers stay Node-only: `ThalovantIdentity.fromFile()`, `fromConfig()`, and `defaultConfigPath()` throw a descriptive `ThalovantIdentityError` in browsers; construct identities from in-memory objects there.
- Add async crypto helpers `encryptAsJsonAsync`, `decryptFromJsonAsync`, `encryptAsBinaryAsync`, and `decryptBinaryAsync` that work on Node and browsers; transports now use them. The existing synchronous helpers keep working on Node and throw a descriptive error in browsers. Byte-oriented APIs (`runtimeCryptoKey`, `encryptAsBinary`, `decryptBinary`, `encodeHiveBinaryFrame`) are typed as `Uint8Array` but still return `Buffer` instances on Node.
- Add a browser bundling smoke test (`test/browser-smoke.test.ts`, part of `npm test` and CI) that bundles the SDK with esbuild in `platform: "browser"` mode, asserts no Node builtins/`ws`/`mqtt` leak into the bundle, and executes the control-plane and WSS connect paths in a DOM-less sandbox with stubbed `fetch`/`WebSocket` and no real network. Adds `esbuild` as a devDependency.

## 0.2.23

- Add optional `otpCode` and `recoveryCode` options to `controlPlane.login(email, password, options)` for MFA-enabled accounts. They are sent to `POST /v1/auth/token` as `otp_code` and `recovery_code` only when provided; accounts with MFA enabled receive HTTP 401 `mfa_required` without one.

## 0.2.22

- Update the locked transitive dependency `ws` from 8.21.1 to 8.21.2. No SDK code changes.

## 0.2.21

- Update the locked transitive dependency `ip-address` from 10.3.1 to 10.4.0. No SDK code changes.

## 0.2.20

- Update locked dependencies: `mqtt` 5.15.1 to 5.15.2, `ws` 8.21.0 to 8.21.1, `@types/node` 24.13.0 to 24.13.3, `@types/readable-stream` 4.0.23 to 4.0.24, `broker-factory` 3.1.14 to 3.1.15, `ip-address` 10.2.0 to 10.3.1, and `worker-timers` 8.0.31 to 8.0.34. No SDK code changes.
- Add a regression test proving concurrent `ask()` calls on one transport correlate replies by request id.
- Repository automation: schedule dependabot dependency updates limited to minor and patch, dispatch npm publication explicitly, and support npm 12 pack metadata.

## 0.2.19

- Publish the exact npm tarball with a durable CycloneDX SBOM and GitHub provenance and SBOM attestations.

## 0.2.18

- Add the typed `OperationResource` contract and `getOperation()` control-plane method.
