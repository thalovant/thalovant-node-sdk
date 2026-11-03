Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Created from the chat apps change (0.10.0) and its test run.

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
