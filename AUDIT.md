Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Record the parity-coverage gap closed for usualForm().

# Audit

Known issues, technical debt and review decisions, each tied to the code and the test that shows it.

## Fixed

- **`usualForm()` was outside the source-bound parity gate** (fixed 2026-11-03). [`src/language-matching.ts`](src/language-matching.ts) and its CLDR tables ([`src/language-matching-data.ts`](src/language-matching-data.ts)) decide which tag [`src/intents.ts`](src/intents.ts) retries a listing with, but no capability in [`contracts/sdk-parity.json`](contracts/sdk-parity.json) declared them, so a change there passed the gate unreviewed. The `listing` capability now declares both and [`test/usual-form.test.ts`](test/usual-form.test.ts).

## Notes

- Error bodies are scrubbed of SDK-sent secrets, in their JSON-escaped spellings too, before they are parsed: `redactSecretsInText` in [`src/redact.ts`](src/redact.ts), applied by `apiError` in [`src/control.ts`](src/control.ts). Tests: [`test/home-link.test.ts`](test/home-link.test.ts).

## Open

- None recorded.
