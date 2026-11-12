Last Edit: Claude Sonnet 5.5 - 2026-11-12 - Motive: Intercom review round 2 (CodeRabbit PR 112): wait deadline vs a fetch that ignores abort, urgent-scope precedence, docs aligned with the API.

# Audit

## Intercom (0.12.0): `AnnounceOptions` is a plain object, so `console.log(options)` prints the text (security review L4)

`AnnounceOptions` (`src/intercom.ts`) is an interface the caller builds; a `console.log(options)` or a logger that serialises it prints `text`. The Rust SDK redacts its `Debug` (the contract names Rust and Go only); in Node the SDK cannot change how the caller's own object prints. Documented in the porting brief; no SDK code logs it (`test/intercom.test.ts`). Not changed.

## Intercom (0.12.0): `ThalovantApiError.problem` keeps the whole API body (review L5)

The API strips `input` and `ctx` from `/intercom/` errors, so the text does not reach `problem` today; a regression would. Not in contract section J; proposed in `SUGGESTIONS.md`.

## Intercom (0.12.0): the timezone and Unicode checks use this runtime's databases

`timezoneName()` (`src/intercom.ts`) asks `Intl.DateTimeFormat`, which accepts any case, an alias and, on Node 22, an offset such as `+01:00`; the API asks Python's `zoneinfo`, which does not. The SDK refuses the offset form by shape and a name that is the right zone in the wrong case (`europe/paris`, `utc`), but an alias in the wrong case (`us/pacific`) passes here and is a 422 there. A runtime without `Intl` checks the shape only. `announcementText()` uses the engine's Unicode tables (`\p{Cc}`...) and `String.prototype.normalize`: a character assigned in a newer Unicode than the SDK's or the API's can pass in one and be refused in the other. The API's answer stays authoritative (`test/intercom.test.ts`, "an unusable do-not-disturb is refused before anything is sent").

## Intercom (0.12.0): `ThalovantApiError.detail` does not read `message`

The final intercom problems carry their sentence in `message`; `problemFields()` (`src/errors.ts`) reads `detail` only, so `error.detail` is undefined for them (the sentence is in `problem.message` and in the error message). Changing it moves the shared api-error behaviour in every SDK; proposed in `SUGGESTIONS.md`.

## Intercom (0.12.0): fixed in the final-API round

- **Rooms, groups and the key length** (was L6): every target list is capped at 50 names of 64 characters and `idempotencyKey()` caps the key at 128 printable ASCII characters (`test/intercom.test.ts`, "a speakers target list holds at most 50 names of at most 64 characters", "an idempotency key is at most 128 printable ASCII characters").
- **A replayed announcement is marked** (`Announcement.replayed`, from `Idempotency-Replayed: true`; "a replayed announcement says so and a first answer does not").
- **The text rule is the API's** (was: 1-280 and control characters only; "a text the API would refuse is refused first and never echoed"). The trim is the API's too: `pyStrip()` takes what Python's `str.isspace` calls white space, so `\u001f hi` is accepted as the API accepts it and a BOM at the edge is refused as the API refuses it.
- **Quiet hours** that are on need a real IANA zone and `start !== end`; unknown `dnd`, `quiet_hours` and speaker keys are refused ("the speaker update takes only the documented fields").

## Intercom (0.12.0): fixed in review round 2 (CodeRabbit PR 112)

- **A fetch that ignores the abort signal held the `announce({ wait: true })` deadline** (`src/control.ts`, `announce` and `raceAbort`): each status read is now raced against the bounded signal (`test/intercom.test.ts`, "the wait deadline holds when an injected fetch ignores the abort signal", "... when an answer body never ends", "a caller's abort still rejects with an AbortError ...").
- **`urgent_scope_required` with the generic "Insufficient scopes" sentence was a plain `ThalovantAuthError`** (`apiError`): the intercom code now wins ("urgent_scope_required wins over the generic Insufficient scopes refusal ...").
- **Docs said `wait` needs `intercom:read` as well, and that cancel is owner/admin only**: both were wrong against the API (`thalovant-api` `app/auth/utils.py:232`, `app/routes/intercom.py` `cancel_announcement`); corrected.
- **Declined:** redacting the sent text from API error messages. The API strips `input` and `ctx` from every 422 under `/intercom/` (`thalovant-api` `app/middleware/errors.py` `NO_ECHO_FRAGMENT`), and a redaction of a short text would rewrite the `code` the typed errors are read from.

## Intercom (0.12.0): a poll that fails after the POST leaves an accepted announcement

`ThalovantControlPlane.announce({ wait: true })` (`src/control.ts`) sends the POST, then polls `getAnnouncement` (`intercom:read`, which `intercom:send` implies: `thalovant-api` `app/auth/utils.py` `expand_granted_scopes`). A 429 or a network error fails a poll after the announcement was accepted, and the rejection carries no announcement id (`test/intercom.test.ts`, "a failed poll rejects after the POST was accepted"). The answer is a fresh `idempotencyKey`: calling again with the same key replays the stored announcement (with its id) and does not send again. Not fixed in the SDK because a rejection cannot also return the announcement; the README and the JSDoc say so.

## Intercom (0.12.0): the settings reader is lenient

`intercomSettingsFromRecord()` (`src/intercom.ts`) reads a missing `plan_allowed` or `enabled` as `false`, as the Python reference does (`IntercomSettings.from_dict`), so a successful answer that omits one looks like a denial. Kept for parity (an unverified review finding): the API always sends both (`app/schemas/intercom.py`, `IntercomSettingsResource`), and changing one SDK alone would break the shared behaviour.

## Intercom (0.12.0): the text is in the request body

`announceBody()` (`src/intercom.ts`) builds the body that holds the text and `ThalovantControlPlane.announce()` (`src/control.ts`) sends it; nothing logs or throws it, and `Announcement` never carries it (`test/intercom.test.ts`, "announce sends the contract body"). It is not redacted from an error the API echoes it in (`ThalovantApiError.problem` keeps the body); the contract says the API never echoes it. The announcement list shape (`items`, `next_cursor`) is taken from the contract; `data` and `cursor` are accepted too. Not exercised against a live API.

## Browser sign-in (0.11.0, 2026-11-08)

Test run after the second review (Python #113 at 39e31d8): `npm test`, 970 tests, 969 passed, 1 skipped (the live interop test, AUDIT #5 below), 0 failed. Earlier rounds: 920 (919 passed) after the review, 907 (906) at first. `test/browser-login-vectors.test.ts` runs all 119 shared cases (and the 27 callbacks again through a real listener); every case's recorded digest equals the Python reference's at 39e31d8, and the 98 earlier cases record what they did before (`contracts/conformance-results.json`). `test/browser-login.test.ts` adds 33, `test/browser-smoke.test.ts` one. Parity: `check-sdk-parity.py --consumer thalovant-node-sdk` verifies against the current reference (Python `main`, 57c7e71f6456; one rollout note, the capability being ahead of it) and the final candidate (PR #113 head 39e31d8, 6dfb3bb31ac7; nothing outstanding).

| # | Finding | Evidence | Status |
| :--- | :--- | :--- | :--- |
| B1 | On Windows another process could bind the listener's port with `SO_REUSEADDR`: Node exposes no `SO_EXCLUSIVEADDRUSE`, and `exclusive: true` only keeps cluster workers from sharing the handle. The state still has to match, so a squatter receives at most a stray tab, never a code it can use without the verifier. | [`src/loopback.ts`](src/loopback.ts) line 276, `server.listen({ port: 0, host: "127.0.0.1", exclusive: true, backlog: 8 })`. | Accepted: a Node platform limit. Not testable on Linux CI. |
| B2 | A cleartext API URL is refused with a `TypeError` (the `assertSecureTokenExchange` that `completeNativeSignIn()` already throws), where the Python reference raises `ThalovantAPIError`. No vector covers it. | [`src/native-auth.ts`](src/native-auth.ts) line 237; [`src/control.ts`](src/control.ts) `browserLogin` (line 1105) and `interactiveLogin` (line 1137, which counts it as "not usable" in `auto`); [`test/browser-login.test.ts`](test/browser-login.test.ts) line 364. | Documented (README, CHANGELOG); see SUGGESTIONS.md #7. |
| B3 | An echoed authorization code under 8 characters was not replaced (the text pass's floor, #8 below). | `redactSecretsInString` in [`src/redact.ts`](src/redact.ts) now replaces a short secret where it stands alone, in a JSON body's decoded strings and in text; test "a short code is taken out of the error where it stands alone" in [`test/browser-login.test.ts`](test/browser-login.test.ts). | Fixed (CodeRabbit on #110). A short secret glued to a letter or digit (`cab1n` for `ab1`) is kept, so that it cannot take pieces out of words. |
| B4 | `src/platform/node.ts`'s header still says it is the only module besides `transport-mqtt.js` that may import `node:` builtins; `src/loopback.ts` now does too, behind the same `browser` map. Left as it is so that the `binary`, `identity` and `inventory` evidence does not move for a comment. | [`src/platform/node.ts`](src/platform/node.ts) line 2; [`src/loopback.ts`](src/loopback.ts) header; [`test/browser-smoke.test.ts`](test/browser-smoke.test.ts) asserts `node:net` and `dist/src/loopback.js` stay out of the browser bundle. | Open, cosmetic; fix with the next change to `platform/node.ts`. |
| B5 | Browser sign-in has not completed against the live API. thalovant-api #501 is live: on 2026-11-08 `GET https://api.thalovant.com/v1/auth/native/config`, read through the SDK's own configuration path, was usable (`https://dash.thalovant.com/authorize`, `/v1/auth/native/token`, `thalovant-sdk`). No person approved a sign-in, so the exchange is proved against loopback peers only. | The vectors' `sign_ins` and `chooser` sections. | Open: one manual sign-in before release. |
| B6 | The authorization endpoint parser refuses a backslash anywhere in `authorization_endpoint`, which the Python reference does not check. Stricter only; no vector has one. | [`src/native-auth.ts`](src/native-auth.ts) line 465. | Accepted: a backslash is not valid in a URL, and a browser reads it as `/`. |
| B7 | The injectable opener is named `openUrl`, as `loginWithBrowser()` already names it, rather than the porting brief's `opener`. | [`src/control.ts`](src/control.ts) lines 850, 894 and 915. | Accepted: one name for one hook across both sign-ins. |
| B8 | Port 0 in `authorization_endpoint` was unusable here and usable in the reference. | The final contract makes it unusable everywhere: `config/a dashboard address on port 0 is unusable`. | Closed: in the contract. |
| B9 | Four review items are being settled in the cross-SDK contract (thalovant-python-sdk#113, not yet published): an empty `deviceName` sent as none (CodeRabbit #6), only RFC 6749 `error` values kept from a callback (#8), the tab waiting for the end with no deadline of its own (#11), and a colon refused anywhere in `token_endpoint` (#13), plus a `HEAD` answer without a body. This SDK follows the published vectors (98 cases) until the final reference lands; its fixes for #8, #11 and #13 hold under both. | `test/browser-login-vectors.json` (vendored from e3999cb). | Closed: ported from 39e31d8 (digest 6dfb3bb31ac7), with the drain-before-close rule; see MAINTENANCE_REPORT.md. |
| B10 | Replacing a secret's spellings in a JSON body's text could cut a `\u` escape in two when the secret starts with the escape's own last digit (`\u0032` + `2…`): the body stopped parsing, `problem` was lost, and the message showed the raw text with the escaped spelling. It predates browser sign-in. | `apiError` in [`src/control.ts`](src/control.ts) now parses first and scrubs decoded values; test "an escape in front of a secret that starts with its own digit is not cut in two". | Fixed for every `apiError`, and for the device poll's own pending, denied and expired problems (`deviceTokenOnce`, `pollDeviceToken`), which use the same decoded scrub (`scrubbedJsonBody`). |
| B11 | A connection is drained for at most 2 seconds after its answer, then closed; the accepted tab's own connection is closed with the rest when the listener closes, after at most 1 second for its page. A browser that keeps sending past either bound can still see a reset. | [`src/loopback.ts`](src/loopback.ts) `drain()` and `close()`; tests "an early answer is not lost to a reset" (600 KB head, 600 KB unread body) and "draining a connection is bounded". | Accepted: the contract's bounds (2 s / 1 MiB). |
| B12 | Fixed here and not in the reference (Python 39e31d8), none of them covered by a vector: `_scrub` splits on `[redacted]` first, so a secret that begins with the marker keeps its tail; its regex alternation consumes a short code that overlaps the start of the verifier and leaves the verifier's rest; it leaves numbers alone, so a code of digits echoed as a number stays whole; the device-token poll's `problem` is not scrubbed; an oversized `HEAD` gets a 400 with a body. | [`src/redact.ts`](src/redact.ts) `redactSecretsInString`, `redactSecretsInJsonNumbers`; [`src/control.ts`](src/control.ts) `deviceTokenOnce`, `pollDeviceToken`; [`src/loopback.ts`](src/loopback.ts) `isHead`; the second-review tests in [`test/browser-login.test.ts`](test/browser-login.test.ts). | Reported to the release lead for the reference. |

## Chat apps (0.10.0, 2026-11-03)

Findings from the 2026-11-03 chat apps change. Test run: `npm test`, 748 tests, 747 passed, 1 skipped, 0 failed.

| # | Finding | Evidence | Status |
| :--- | :--- | :--- | :--- |
| 1 | `ThalovantApiError.fields` has no shared conformance vector: its behaviour (top-level `fields`, inside an object `detail`, strings only) is proved only by this repository's own tests. | `test/chat-apps.test.ts` ("a settings refusal carries its code...", "fields inside an object detail..."); `test/api-error-vectors.json` has no `fields` case. | Open; see SUGGESTIONS.md #1. |
| 2 | The `chat-apps` parity entry is ahead of the reference: the checker reports "declares capabilities the reference does not know yet: chat-apps" until the Python reference publishes it. | `contracts/sdk-parity.json` `capabilities.chat-apps`. | Expected rollout state. |
| 3 | `getBridgeAvatar()` reads the whole answer into memory without a size cap of its own; the API caps a picture at 1 MiB. | `src/control.ts`, `getBridgeAvatar`. | Accepted: the cap is the API's. |
| 4 | `requiredString()` in the control plane says "Hub resource is missing X" for every resource it reads, hub skill operations included. | `src/control.ts`, `function requiredString`. | Open, cosmetic. The chat apps readers use their own message (`src/chat-apps.ts`, `text()`). |
| 5 | The live interop test is skipped without credentials, so the Noise handshake against a live hub is not exercised in CI. | `test/noise-interop.test.ts` (skip message names `THALOVANT_INTEROP_WSS`). | Pre-existing. |
| 6 | CI has no lint step; type checking happens through `tsc` in `npm test`. | `.github/workflows/ci.yml`. | Pre-existing. |
| 7 | The CHANGELOG kept an "Unreleased" heading for changes that shipped in 0.9.9. | `CHANGELOG.md`; tag `v0.9.9`. | Fixed in this change (heading is now "0.9.9 — 2026-10-11"). |
| 8 | Secret scrubbing ignores values shorter than 8 characters, so a short token echoed in an error body would not be replaced. No connector's token or secret is that short, and the API repeats no input under `/v1/bridges`. | `src/redact.ts`, `redactSecretsInText`. | Accepted: the floor stops a short value from replacing unrelated text. |
| 9 | `listBridges()` returns one answer of at most `limit` bridges (500 at most); the route has no cursor. | `src/control.ts`, `listBridges`. | Documented; see SUGGESTIONS.md #5. |

Known issues, technical debt and review decisions, each tied to the code and the test that shows it.

## Fixed

- **Secret scrubbing matched spellings, not decoded values** (recorded 2026-11-08, CodeRabbit on #89 and #109; fixed 2026-11-08). A JSON error body is now scrubbed once parsed, every string and key, numbers before parsing ([`src/redact.ts`](src/redact.ts) `redactSecretsInJson`, `redactSecretsInJsonNumbers`; [`src/control.ts`](src/control.ts) `scrubbedJsonBody`), so no JSON spelling decodes a secret back. A body that is not JSON has no escapes to decode: it is scrubbed as text, every secret and every JSON spelling of it in one pass (`secretSpellings`), so overlapping occurrences go together. What is left: a text body that spells a secret in a way JSON does not (percent-encoded, say) is not recognised. Tests: [`test/browser-login.test.ts`](test/browser-login.test.ts), [`test/home-link.test.ts`](test/home-link.test.ts).
- **`usualForm()` was outside the source-bound parity gate** (fixed 2026-11-03). [`src/language-matching.ts`](src/language-matching.ts) and its CLDR tables ([`src/language-matching-data.ts`](src/language-matching-data.ts)) decide which tag [`src/intents.ts`](src/intents.ts) retries a listing with, but no capability in [`contracts/sdk-parity.json`](contracts/sdk-parity.json) declared them, so a change there passed the gate unreviewed. The `listing` capability now declares both and [`test/usual-form.test.ts`](test/usual-form.test.ts).

## Notes

- **Two connect defaults, one documented** (2026-11-03). `ThalovantClient.connect()` and `close()` budget 6,000 ms ([`src/client.ts`](src/client.ts) `normalizeConnectTimeout`), as the docs site says; each transport's own `connect()` defaults to 20,000 ms ([`src/transport-core.ts`](src/transport-core.ts), [`src/transport-mqtt.ts`](src/transport-mqtt.ts)) but the client always passes its own budget. The 0.3.0 CHANGELOG entry had claimed 20 s for `connect()`; corrected under Unreleased.
- **Secret key names are matched exactly** (recorded 2026-11-08, CodeRabbit on #109). `isSecretKey` ([`src/redact.ts`](src/redact.ts), `SECRET_KEY_NAMES`) lowercases a key, drops `_` and `-`, and looks it up in a fixed list. A credential under a name the list lacks, such as `id_token` or `session_token`, stays in the default `asObject()` view and in debug output. No record the SDK reads carries either today. The list is exact on purpose, so that reference fields such as `apiKeyRef` stay visible (#31). A name is added when a record gains one.
- **Published typings are not checked in CI.** `stripInternal` removes `@internal` declarations from the emitted `.d.ts`; a clean-consumer type-check with `skipLibCheck: false` passed on 2026-11-03 and again on the 0.10.0 tarball on 2026-11-08, but `publish.yml` only smoke-tests the ESM import.

- Error bodies are scrubbed of SDK-sent secrets, in their JSON-escaped spellings too, before they are parsed: `redactSecretsInText` in [`src/redact.ts`](src/redact.ts), applied by `apiError` in [`src/control.ts`](src/control.ts). Tests: [`test/home-link.test.ts`](test/home-link.test.ts).

## Open

None recorded.
