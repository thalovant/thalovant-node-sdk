# Changelog

## 0.6.1 — 2026-09-12

- Refresh bundled listing rules to thalovant-languages 0.2.1, matching Python 0.6.8 across 270 languages. Preserve regional inheritance and the corrected French/Spanish trailing-word behavior.
- Regenerate public-reference cases for every shipped locale, including Spanish questions and French complete phrases.

## 0.6.0 — 2026-09-12

- Add locale-aware sentence listings, regional phrase selection, canonical slot examples and fuller phrase ranking, matching the Python 0.6.5 listing feature for supported locales.
- Ship generated thalovant-languages 0.1.1 rules. Custom `ListingRules` snapshots and explicit no-data rendering work in Node and browsers without filesystem access.
- Match OVOS locale distances, regional preferences and script boundaries using versioned langcodes CLDR tables.
- Preserve selected locale, compile question rules independently, and support optional question categories without requiring opener words.

## 0.5.1 — 2026-09-12

- Reject non-finite configuration values before JSON serialization can turn them into null. Guarded writes also validate unsafe integers in personas and overflowing numeric exponents in stored snapshots.

## 0.5.0 — 2026-09-12

- Refuse guarded merges with integers outside JavaScript’s safe range before writing, preventing silent rounding of untouched values.

- Match Python 0.6.3 request hints, location construction, ordered embedded audio replies, strict bounded hex decoding, and speakable intent examples with original phrase priority.
- Default runtime configuration updates to revision-guarded deep merges. Retry only HTTP 412 (three attempts maximum); fail before writing against older servers. Explicit replacement remains available. Merging now requires both hubs:read and hubs:write scopes, plus a paid plan.
- Add regression coverage for conflict preservation, retry limits, unsupported revisions, audio bounds, caller context preservation, and example ranking.

## 0.4.0 — 2026-09-12

- Add shared-runtime hub skill history with bounded limits.
- Correct hub skill documentation: changes affect every hub sharing the runtime group.

## 0.3.16

- Stop hub-skill operation polling before starting a read at or after the wait deadline, including an already-expired budget.
- Keep the accepted operation ID in poll-read and terminal-operation errors so callers can resume tracking the change. Preserve the sanitized API error as the cause of a failed read, without retrying the mutation or failed read or exposing unknown native error contents.

## 0.3.15

- Add hub-scoped skill management on the control plane: `listHubSkills`, `installHubSkill`, `updateHubSkill`, and `removeHubSkill` address one hub by id over `GET`/`POST /v1/hubs/{hub_id}/skills` and `PATCH`/`DELETE /v1/hubs/{hub_id}/skills/{skill}`. Listing resolves with a typed `HubSkillList` envelope (`hub_id`, `runtime_group_id`, `observed_at`, `source`, runtime phase and message, `data` rows with the requested, installed, observed, and latest versions, `update_available`, `active`, and a `state` of `pending`, `installed`, `failed`, `removing`, `drifted`, `quarantined`, or `unmanaged`). The writes resolve with a typed `HubSkillOperation` from the API's HTTP 202 (`operation_id`, `hub_id`, `runtime_group_id`, `skill`, `version`, `previous_version`, `state`); installing at another version performs an update. `wait: true` polls the operation every two seconds until it converges (`installed` or `removed`), rejects with `ThalovantApiError` carrying the operation's error when it fails, and with `ThalovantTimeoutError` after `timeoutMs` (default 120000). Listing needs `hubs:inspect`; the writes need `hubs:write` and a paid plan.
- Keep the RFC 7807 problem `code` of a failed control-plane request in the `ThalovantApiError` message, appended after the detail (for example `HTTP 409: Skill version already installed. (skill_version_already_installed)`), so callers can branch on `skill_version_already_installed` or `hub_without_runtime_group` without parsing prose.
- Export `HubSkill`, `HubSkillList`, `HubSkillState`, `HubSkillOperation`, `HubSkillOperationState`, `HubSkillInstallOptions`, `HubSkillUpdateOptions`, and `HubSkillWaitOptions`. Route paths and result types live in one block in `control.ts`.
## 0.3.14

- Require an actual usable definition before suppressing a describe timeout within or across batches. Empty or unknown-intent replies followed by silence now report the timeout; fully answered empty responses remain successful. Correlation and partial recovery with actual definitions are unchanged.

## 0.3.13

- Compare validated Noise pins by case-insensitive hexadecimal value without rewriting established bytes, strip normalized legacy crypto-key fields before bootstrap requests, and verify a clean public npm import in the publish workflow.

- Fail closed on corrupt, empty, or unreadable Noise identity and pin state. Serialize Node state transactions across processes with a bounded lock wait, preserving existing trust after failures. Browser coordination remains scoped to one page.
- Reject overlapping Ask request IDs and Query query IDs on one client before dispatch, without disturbing the active collector. Different wire namespaces remain independent.
- Retain usable nested API error details and redact additional normalized secret-bearing metadata keys from display output. Explicit persistence remains unchanged.
- Correct removed crypto-helper documentation, runtime-config replacement guidance, boolean query-option release notes, and the Node patch floor required by npm trusted publishing.

## 0.3.12

- Reject HTTP disconnect acknowledgments that also report `ok: false` or combine a known no-session error with extra fields. Keep admission ownership and replica affinity until cleanup is confirmed.
- Preserve compatibility with the exact one-field `Already Disconnected` and `Client is not connected` replies. Add five failing-before Noise lifecycle regressions covering contradictory acknowledgments and safe cleanup retry.

## 0.3.11

- Report HTTP disconnect refusals and invalid acknowledgments through `close()` and `waitForClosed()`. Retain the remote admission and replica affinity until cleanup succeeds, so a later close or reconnect can retry safely; failed cleanup remains visible in connection diagnostics.
- Preserve the original connection failure when its cleanup also fails. Sanitize native HTTP network and JSON parsing errors without exposing authorization URLs, response previews or raw causes.

## 0.3.10

- Add optional `AbortSignal` cancellation to `query` and conversation Query calls across connection admission, sending and reply collection. Cancellation remains `AbortError` after partial speech; queued callers leave the active connection owner intact.
- Preserve the first accepted cancellation, completion or hard failure when an admitted write later throws or rejects. Keep that write observed until it retires, remove collector listeners and timers, and never replay a cancelled application request.
- Apply the existing finite JavaScript timer-duration validation to Query. Ask and Query both recheck cancellation and their original deadline immediately before deferred publication.

## 0.3.9

- Return the first nonempty session ID from accepted runtime events in Ask and Query replies, falling back to the requested session when the hub omits it. Foreign and post-terminal events cannot supply reply metadata.
- Return completed Query replies immediately; its retained `replySettleMs` option no longer adds a delay after collection has already stopped. Ask keeps its bounded speech collection window.

## 0.3.8

- Apply one total deadline to Ask and event waits, including connection readiness, send waiting, delayed speech, and fragment settling. Preserve replies emitted just before readiness returns.
- Freeze Ask results on policy denial or explicit query timeout, preserving earlier partial speech and ignoring later events or write failures.
- Add optional `AbortSignal` cancellation to Ask, conversations, event waits, and `connect(timeoutMs, signal)`; queued cancellation leaves the active connection owner intact, and all collector timers/listeners are removed.

## 0.3.7

- Give routed queries one deadline across connect, send, response and optional settling. Keep intent misses provisional until completion or recovery; freeze completed and hard-failed queries, retain failed partial replies, and observe late sends without accepting later events.

- Validate browser-login URLs and open them without a Windows command shell, preventing verification URLs from being interpreted as commands.

- Reject control-plane redirects so 307/308 responses cannot forward password-login bodies to another origin. Require HTTPS for credentials except explicit loopback HTTP used in local development, and reject credentials embedded in API URLs.
- Verify redirect rejection against real HTTP servers for bearer and password requests, including zero requests received at the redirect target.

## 0.3.6

- Enforce one caller deadline through queued connection work, transport setup and authenticated readiness. Timed-out cleanup cannot hold the caller indefinitely, and replacement sessions wait for the retired connect and cleanup to finish. Closing cancels active and queued attempts, uses a bounded caller deadline, and exposes `waitForClosed()` to observe cleanup retained after timeout.
- Align intent discovery with Python: a silent listing can use engine manifests; discover fallback skills with a bounded optional probe, preserve unknown versus known-empty support, and expose `HubFallback`, `fallbacksKnown` and `mayAnswer(lang)`. Bare language strings are one tag.
- Ignore explicitly mismatched request IDs on policy denials and intent descriptions while retaining compatibility with replies that omit IDs.
- Exercise Node 20, 22 and 24 in CI, including package checks, dependency audit, real Noise transport regressions and browser bundle smoke.

## 0.3.5

- Validate the effective MQTT URL before handing credentials to MQTT.js. An explicit TLS flag upgrades `ws://` to `wss://` as well as `mqtt://` to `mqtts://`; plaintext and unsupported schemes fail closed.
- Use one MQTT connect deadline across broker connection, subscription, admission, Noise handshake writes, and online presence. Each broker reconnect gets a fresh deadline, and stale operations cannot replace the active deadline.
- Keep HTTP connect failure cleanup and waits for an earlier disconnect inside the original connect budget, preserving admission ownership when cleanup needs a later retry.
- Add deterministic regressions for stalled MQTT session steps, secure endpoint normalization, and bounded HTTP cleanup.

## 0.3.4

- Fix HiveMind v3 Noise negotiation on HTTPS and MQTT. HTTPS now retains replica affinity and uses encrypted binary endpoints; MQTT carries raw Noise frames and reauthenticates after broker reconnects. Both require TLS and reject legacy offers.
- Share persistent client keys and hub pins across runtime transports through `noiseStateDir`. Failed authentication preserves trusted server pins.
- Reset ephemeral keys and readiness on disconnect, reject pre-authentication application traffic, and serialize encrypted sends and receives, including chunked messages.
- Preserve custom `noiseStateDir` through every client convenience factory. Concurrent connection attempts share admission; cancelled operations and held chunks cannot alter a newer session.
- Clean up this transport's admitted HTTP session before retrying after poll/send failure, so r8 produces a fresh HELLO and Noise offer. Unconnected identity-inspection clients never disconnect a remote peer.
- Add HTTP and MQTT encrypted request/reply, XX-to-KK reconnect, concurrent chunking, rejected-offer, JSON-error, and tamper regressions.

## 0.3.0

- **Breaking.** `wss` connections now perform the HiveMind v3 Noise handshake,
  and only that. A HiveMind-core 5.x hub accepts no other key exchange, so this
  release requires one; against an older hub the connection is refused rather
  than downgraded. `Noise_XXpsk2_25519_ChaChaPoly_SHA256` on first contact and
  `Noise_KKpsk0_...` once the hub's static key is pinned, with
  `25519_AESGCM_SHA256` supported where a hub prefers it.
- **Breaking.** `ThalovantIdentity.cryptoKey` is gone, along with the whole
  `crypto` module (`encryptAsJson`, `decryptFromJson`, `encryptAsBinary`,
  `decryptBinary`, `runtimeCryptoKey` and their async variants) and the
  pre-shared handshake on all three transports. Hubs no longer issue a crypto
  key and v3 derives its pre-shared key from the `password`, so the field named
  a credential that no longer exists. `crypto_key` is still accepted and
  ignored when parsing an older identity file, and stays in the redaction lists
  so an older payload carrying one does not leak it. `https` and `mqtt` now
  rely on TLS for confidentiality, as they already did for everything the
  crypto key did not cover.
- New `noise` and `noise-store` modules: `derivePsk`, `canonicalJson`,
  `selectNoiseOptions`, `NoiseHandshake`, `NoiseSession`, and the state helpers
  `loadOrCreateNoiseKey`, `loadNoisePin`, `saveNoisePin` and `forgetNoisePin`.
  The Noise state machine is written out against the spec because no
  dependency-light JavaScript library implements these patterns; every
  primitive under it comes from the audited `@noble` packages, which are new
  dependencies and work identically in Node and in a browser bundle.
- Two pieces of state persist: this client's static X25519 key and the hub keys
  it has pinned. In Node they are `noise_key` and `noise_pins.json` beside the
  SDK config file, both `0600`; in a browser they live in `localStorage`. The
  `noiseStateDir` client option overrides the location.
- Trust on first use: the first hub key seen for a node id is pinned, and a
  later connection presenting a different key is refused with an error naming
  `forgetNoisePin`, rather than silently re-pinned. A failed `KKpsk0` handshake
  drops the stale pin, because `KK` needs each side to hold the other's key and
  the failure is as likely to mean the hub no longer has this client's.
- `HiveMindWSSTransport.remoteStaticKey` reports the hub's static key for the
  current session.
- `connect()` now defaults to a 20 second budget rather than 6, because the
  first handshake with a hub runs argon2id at 64 MiB.
- **Breaking.** `HiveMindMqttTransport.connect` now refuses a broker whose
  identity does not enable TLS. Removing the crypto key took the separate
  payload cipher with it, so TLS is the only confidentiality left on that hop;
  without it every message and the broker password would travel in the clear.
  Use an `mqtts://` endpoint, or set `tls: true` on the identity's `mqtt` block.
- **Breaking.** The HTTPS transport now refuses a `baseUrl` that is not
  `https://`. Removing the crypto key took the separate payload cipher with it,
  so TLS is the only confidentiality left on that hop, and the access key
  travels in the `authorization` query.
- `createClientIdentity` strips `cryptoKey` and `crypto_key` from a
  caller-supplied `options.spec` rather than forwarding them to `/v1/clients`.
  The generated-secret redaction covers only what the SDK mints, so a legacy
  value passed in by a caller could otherwise be echoed back inside a
  `ThalovantApiError`.
- Pin-file updates are serialized in-process and written through a temporary
  file renamed into place. The read-modify-write was previously unguarded, so
  two connections pinning different hubs at once could lose an entry, and a
  failed write could leave the file empty -- which reads back as "no pins" and
  would silently re-pin whatever key the next connection was offered.
- Messages larger than one Noise transport message are chunked at 65000 bytes
  and reassembled by the peer, with reassembly capped at 32 MiB. Sends are
  serialized so two callers cannot interleave a message's chunks: the cipher
  state nonce counter is strictly sequential. Any transport message that fails
  to decrypt, and any malformed chunk sequence, drops the session rather than
  the frame.

## 0.2.39

- `listIntents()` rejects with `ThalovantRuntimeError` when the hub answers `ovos.intent.list` with `ok: false`, instead of reading the missing `intents` key as an empty list. A refused listing is not an empty hub, and reporting it as no intents showed a person a device that can do nothing; the rejection carries the hub's `error` text. The engines' manifests stay the fallback for a policy refusal only, not for a listing the hub answered and failed. `describeIntent()` keeps returning an empty list for `ok: false`, which is a real answer: the hub does not know that registration. Reported by the Kotlin port's review.
- `ThalovantPolicyDeniedError.allowed` keeps only string entries. A number or a null in the hub's `allowed` list is not a message type, and stringifying one put `"3"` or `"null"` in front of an operator reading which types to allow. Reported by the Kotlin port's review.
- README: `intents(...)` needs `ovos.intent.describe` only when definitions are requested, which is the default; listing alone (`describe: false`) needs `ovos.intent.list` alone. The engine-manifest fallback is documented as what it is — reached only when the hub refuses `ovos.intent.list` and `fallback` is on — so the documented `source` and `denied` values stay correct; a refused `ovos.intent.describe` rejects either way.

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
- `PATCH` and `DELETE /v1/hubs/{id}` enforce optimistic locking, so `updateHub` and `deleteHub` take a **required** `etag` option and send it as `If-Match`; a stale *or missing* value is HTTP 412 and changes nothing. The runtime group routes read no `If-Match`. `createHub` sends an `Idempotency-Key` header, generated unless you pass `idempotencyKey`. To safely retry after an uncertain outcome, retain an explicit key before the first call and reuse that key with the same payload; a later call without it generates a fresh key and can create another hub.
- Plan and scope gates surface as the usual `ThalovantApiError`: the provisioning writes need a paid plan and `hubs:write` (HTTP 402 on the free plan, HTTP 403 without the scope), the ratings need `hubs:write` with no plan gate, and the three discovery reads are **not** paid-gated at all (`hubs:read` for the catalog, `hubs:inspect` for the two group reads) so a free-plan token can browse before upgrading.
- Unlike `getHubRuntimeCapabilities`, neither group read answers HTTP 409 when nothing is reporting; they return an empty `data` list with the provenance in `source`.
- New exported types: `HubPayload`, `HubWriteOptions`, `RuntimeGroupPayload`, `ReleaseOptions`, `RuntimeGroupListOptions`, `RuntimeGroupConfigOptions`, `RuntimeGroupSkillInstallOptions`, `MarketplaceSkillListOptions`, `RuntimeGroupMarketplaceOptions`, and `RuntimeGroupInventoryOptions`. camelCase options and payload keys map to the API's snake_case bodies and query params, and falsy boolean query options are omitted rather than sent as `false`; request bodies preserve explicit `active: false`. No existing signature changed and the browser bundle is unaffected.
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
