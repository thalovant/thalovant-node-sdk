Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: CodeRabbit follow-ups of merged PRs #80, #84 and #86.

# Maintenance Report

## 2026-11-03 — CodeRabbit follow-ups (#80, #84, #86)

Four review threads were still open on merged pull requests. Each was checked against `main` (a09a32a) before acting.

| Thread | Finding | Outcome |
| :--- | :--- | :--- |
| #84 `src/language-matching.ts` | Document the byte comparison in `usualForm()` and put its source and test under the listing parity capability | Fixed: `contracts/sdk-parity.json` `listing` declares `src/language-matching.ts`, `src/language-matching-data.ts` and `test/usual-form.test.ts`; CHANGELOG entry |
| #80 `package.json` | Make `record-conformance` portable | Already fixed in the #80 squash (1423a0c): `scripts/record-conformance.mjs` sets the variable through `env` and cleans up in `finally` |
| #86 `src/control.ts` (device-token poll) | Redact the device code on the non-pending error branch | Already fixed in #89 (59d57bb); covered by `test/home-link.test.ts` "a refused device-token poll never repeats the device code" |
| #86 `src/control.ts` (`apiError`) | Redact JSON-escaped secrets before parsing | Already fixed in #89 (59d57bb): `redactSecretsInText` + `jsonSpellings` in `src/redact.ts`; covered by `test/home-link.test.ts` "a secret the SDK sent is redacted in its JSON-escaped spellings too" |

### Verification

- `npm ci && npm test`: 717 tests, 716 passed, 1 skipped, 0 failed.
- The reference's `scripts/check-sdk-parity.py --consumer thalovant-node-sdk` passes with the new contract.
- Gate evidence: with the new contract, a one-line edit to `src/language-matching.ts` fails the check (`listing: implementation changed: src/language-matching.ts`); with the old contract the same edit passes. That is the gap the thread named.

## Transparency Report

- **AI Model**: Claude Opus 5.5.
- **Actions Taken**: Read the four threads and the current code and tests; added three files to the `listing` capability with their SHA-256 evidence; wrote the CHANGELOG entry, this report and `AUDIT.md`; replied on the threads.
- **Oversight**: Run by an agent on the repository owner's request to handle every open CodeRabbit thread; merged through the normal CI gates. No package file changes, so `auto-release.yml` cuts no release.
