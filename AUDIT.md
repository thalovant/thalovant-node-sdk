Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Record the secret-scrubbing spelling limitation (CodeRabbit on #89) as open, and re-check the published typings on 0.10.0.

# Audit

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

- **`usualForm()` was outside the source-bound parity gate** (fixed 2026-11-03). [`src/language-matching.ts`](src/language-matching.ts) and its CLDR tables ([`src/language-matching-data.ts`](src/language-matching-data.ts)) decide which tag [`src/intents.ts`](src/intents.ts) retries a listing with, but no capability in [`contracts/sdk-parity.json`](contracts/sdk-parity.json) declared them, so a change there passed the gate unreviewed. The `listing` capability now declares both and [`test/usual-form.test.ts`](test/usual-form.test.ts).

## Notes

- **Two connect defaults, one documented** (2026-11-03). `ThalovantClient.connect()` and `close()` budget 6,000 ms ([`src/client.ts`](src/client.ts) `normalizeConnectTimeout`), as the docs site says; each transport's own `connect()` defaults to 20,000 ms ([`src/transport-core.ts`](src/transport-core.ts), [`src/transport-mqtt.ts`](src/transport-mqtt.ts)) but the client always passes its own budget. The 0.3.0 CHANGELOG entry had claimed 20 s for `connect()`; corrected under Unreleased.
- **Published typings are not checked in CI.** `stripInternal` removes `@internal` declarations from the emitted `.d.ts`; a clean-consumer type-check with `skipLibCheck: false` passed on 2026-11-03 and again on the 0.10.0 tarball on 2026-11-08, but `publish.yml` only smoke-tests the ESM import.

- Error bodies are scrubbed of SDK-sent secrets, in their JSON-escaped spellings too, before they are parsed: `redactSecretsInText` in [`src/redact.ts`](src/redact.ts), applied by `apiError` in [`src/control.ts`](src/control.ts). Tests: [`test/home-link.test.ts`](test/home-link.test.ts).

## Open

- **Secret scrubbing matches spellings, not decoded values** (recorded 2026-11-08, CodeRabbit on #89). `redactSecretsInText` ([`src/redact.ts`](src/redact.ts), `jsonSpellings`) replaces a secret in the error body before `apiError` ([`src/control.ts`](src/control.ts)) parses it. It knows the raw spelling, the `JSON.stringify` spelling and the `\u`-escaped non-ASCII spellings. It does not know an encoder that `\u`-escapes ASCII (`"` for `"`), nor `\/` for `/`. A body spelt that way decodes the secret back into `problem` and the message. The API writes `\"`, `\\` and raw `/`, so no answer it gives gets past this. Since 0.10.0 the scrubbed values include user-entered bridge secrets, which may hold any character. Scrubbing the parsed strings after `JSON.parse` would cover every spelling at once (SUGGESTIONS.md #6). It is a `src/` change, so it waits for a release. Tests: [`test/home-link.test.ts`](test/home-link.test.ts) ("a secret the SDK sent is redacted in its JSON-escaped spellings too").
