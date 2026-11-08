Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Re-check every CodeRabbit review-body item on merged PRs #31-#89 against main 9dc7a1d, after 0.10.0.

# Maintenance report

## 2026-11-08 — CodeRabbit review-body items re-checked (#31-#89)

All 22 review-body items on twelve merged PRs were checked again against `main` (9dc7a1d, after 0.10.0). This covers the eighteen items on #31-#81 from the 2026-11-03 sweep, plus #87 (one item) and #89 (three items), which were answered on their PRs in September but were not in this report. None is still a defect, so nothing under `src/` changes.

| PR | Item | Outcome on 9dc7a1d |
| :--- | :--- | :--- |
| #31 | `detailString` stops at the first non-null field | Fixed in 07a7c93 (#56); unchanged |
| #31 | Cover token-shaped key names | Fixed in the #31 squash (6bfed4d); `src/redact.ts` `SECRET_KEY_NAMES` unchanged. Names are matched exactly, so a key the list lacks (`id_token`, `session_token`) is not redacted. No record the SDK reads carries one today (AUDIT.md, Notes) |
| #31 | `@internal` + `stripInternal` could leave dangling types | Not a defect, checked again on 0.10.0. Its chat apps module adds twelve `@internal` declarations. The packed 0.10.0 tarball type-checks in a clean consumer with `skipLibCheck: false`, imports as ESM, and its typings name none of the internal declarations |
| #31 | `deepEqual` in the `includeSecrets` checks | Fixed in 9eb0e58 (#106) |
| #36 | Synthetic test password | Declined, as before: an in-process mock transport, not a credential |
| #39, #64, #68, #81 | Run the release validation | Not applicable: `ci.yml` runs `npm ci`, `npm test` and `npm pack --dry-run` on every PR, and `publish.yml` smoke-tests the published package |
| #39 | `requestReply` in the public API | Fixed in the #39 squash (acab13d); still absent from the 0.10.0 ESM namespace and typings |
| #41 | README documents deleted crypto helpers | No longer applies: the README has been a landing page since #92 (f85fa0e) |
| #41 | `client.connect()` caps the handshake at 6000 ms | Not a defect: 6,000 ms is the documented client default and the PSK is WASM-derived and cached (#44); the 0.3.0 CHANGELOG line was corrected in 9eb0e58 (#106) |
| #41 | Async PSK derivation (2 items) | Fixed in 8223603 (#44): `pskFor` awaits `derivePskAsync` |
| #41 | A non-object pin file drops every pin | Fixed in 07a7c93 (#56): `readPins` throws `ThalovantIdentityError` |
| #46 | `/disconnect` outlives the connect deadline | Fixed in 0358a0b (#47): `disconnectHttp(deadline)` |
| #56 | Smoke-test the published package | Fixed in the #56 squash (07a7c93) |
| #59 | Document `listHubSkillHistory` | No longer applies to the README; the docs site's Node page lists it |
| #87 | README: "about ninety seconds" vs the 180000 ms default | Not valid when raised: ninety seconds is how long admission usually takes, and the timeout is deliberately twice that. The README is now a landing page, so the line is gone |
| #89 | A failed legacy-state adoption was swallowed | Fixed before merge (b4e7c8d, in the 59d57bb squash): `startNoiseHandshake` lets the adoption error propagate (`test/noise-key-folder.test.ts`) |
| #89 | `handshakeDoneHere` set after message 3 was sent | Fixed before merge (b4e7c8d): set as soon as XX message 3 exists (`test/link-carrier-vectors.test.ts`) |
| #89 | `\u`-escaped JSON syntax characters in secret scrubbing | Declined, with an updated reason. Since 0.10.0 the scrubbed values include user-entered bridge secrets, which may hold `"` or `\`. Those are covered: the API writes them `\"` and `\\`, the spelling `JSON.stringify` gives, and a check with Python's `json.dumps` bodies (both `ensure_ascii` modes) shows them scrubbed. Only spellings the API does not write get past it: a `\u`-escaped ASCII character (`\u0022`), `\/`, or non-ASCII escaped in some places and not others. Recorded as a limitation in AUDIT.md, with the complete fix in SUGGESTIONS.md #6 |

### Verification

- `npm ci && npm test`: 748 tests, 747 passed, 1 skipped, 0 failed, on 9dc7a1d.
- `npm pack`, then a clean consumer project with `skipLibCheck: false`: `tsc` passes; `import("@thalovant/sdk")` loads 202 exports, without `requestReply` or `bridgeCreateBody`.
- The reference's `scripts/check-sdk-parity.py --consumer thalovant-node-sdk` passes.
- This change touches only `AUDIT.md`, `SUGGESTIONS.md` and this report. None of them is a release path, so `auto-release.yml` cuts no release.

### Transparency Report

- **AI Model:** Claude Opus 5.5 (`claude-opus-5-5`).
- **Actions Taken:** Read every review body in full and checked each item against current code. Re-ran the packed-typings check on 0.10.0 and the scrubbing check on JSON bodies. Wrote this entry, the AUDIT.md limitation and SUGGESTIONS.md #6. Posted a corrected reason on #89.
- **Oversight:** Run by an agent on the repository owner's request to close out every CodeRabbit finding. Merged through the normal CI gates. No release was cut.

## 2026-11-03: chat apps (0.10.0)

**Change.** Added the owner routes under `/v1/bridges` to `ThalovantControlPlane` (`src/control.ts`), their models, readers, request bodies and `SecretValue` (`src/chat-apps.ts`), the exports (`src/index.ts`), and `ThalovantApiError.fields` (`src/errors.ts`). Version 0.10.0 in `package.json`, `package-lock.json` and `src/version.ts`. README "Chat apps" section, CHANGELOG entry, and a `chat-apps` entry in `contracts/sdk-parity.json` with refreshed hashes for the capabilities whose evidence files changed.

**Rationale.** Hub owners can connect chat networks to their hubs; the SDKs and the MCP server expose the same owner routes with parallel names. The Python SDK is the parity reference.

**Verification.**
- `npm ci`, `npm audit --audit-level=high` (0 vulnerabilities), `npm test` (748 tests: 747 passed, 1 skipped live-interop test that needs credentials), `npm pack --dry-run` (116 files), on Node.js 22 locally; CI runs Node.js 20, 22 and 24.
- `test/chat-apps.test.ts`: 31 tests covering every route, parsing with unknown enumeration values and absent optional members, errors with `code` and `fields`, the plan and auth error classes, and secrets absent from every printed form.
- The shared api-error vectors still pass; one local assertion now expects `fields: []` in the error's JSON, and a new one checks that an explicit `fields` wins over the problem's.
- CodeRabbit review: a status without `source` now reads as `unavailable` instead of being refused; `listBridges()` documents that it returns one bounded answer; the explicit-`fields` tests (a list and an empty list) and an empty-`source` test were added. Declined, with reasons in the review threads: making `fields` non-enumerable, and scrubbing echoed secrets shorter than 8 characters.
- Parity checker run as a consumer: verified, with the expected rollout note that the reference does not know `chat-apps` yet.

### Transparency report

- **AI model:** Claude Opus 5.5 (`claude-opus-5-5`).
- **Actions taken:** wrote the chat apps module, the control-plane methods, the error `fields` member, the tests, README, CHANGELOG, parity entry and these repository notes; ran the test suite, package check and parity checker.
- **Oversight:** automated tests and CI, CodeRabbit review on the pull request, merged by the repository owner's delegated agent.

## 2026-11-03 — CodeRabbit review-body items (#31, #36, #39, #41, #46, #56, #59, #64, #68, #81)

CodeRabbit also left items in its review bodies ("Nitpick comments", "Outside diff range comments"). These are not threads, so nothing tracked them. Eighteen items on ten merged PRs were checked against `main` (6dc4e48); each old PR has a comment listing its items and their outcome.

| PR | Item | Outcome |
| :--- | :--- | :--- |
| #31 | `detailString` stops at the first non-null field | Already fixed in 07a7c93 (#56): each of `msg`, `message`, `detail` is tried in turn |
| #31 | Cover token-shaped key names | Already fixed in the #31 squash (6bfed4d): `src/redact.ts` lists `token`, `accesstoken`, `refreshtoken`, `apisecret`, `secretkey`, `credentials`, `authorization` |
| #31 | `@internal` + `stripInternal` could leave dangling types | Verified, not a defect: the packed 0.9.11 tarball type-checks in a clean consumer with `skipLibCheck: false`, and no published `.d.ts` names `DevicePollOptions` or `requestReply` |
| #31 | `deepEqual` in the `includeSecrets` checks | Fixed here: `assert.deepStrictEqual` (test only) |
| #36 | Synthetic test password `"secret"` | Declined: offline mock fixtures, not a credential; a rename churns a parity-pinned test file for no security gain |
| #39 | Release validation for 0.2.38 | Not applicable: `ci.yml` runs `npm ci`, `npm test`, `npm pack --dry-run` on every PR, and `publish.yml` smoke-tests the published package |
| #39 | `requestReply` in the public API | Already fixed in the #39 squash (acab13d): `src/index.ts` exports the intent models by name only |
| #41 | README documents deleted crypto helpers | No longer applies: the README is a landing page and neither it nor the docs site names them |
| #41 | `client.connect()` caps the handshake at 6000 ms | Code unchanged: 6,000 ms is the documented default and the PSK is WASM-derived and cached since 0.3.2 (#44). The 0.3.0 CHANGELOG line that promised 20 s is corrected here |
| #41 | Async PSK derivation (2 items) | Already fixed in 8223603 (#44): `pskFor` awaits `derivePskAsync` |
| #41 | A non-object pin file drops every pin | Already fixed in 07a7c93 (#56): `readPins` throws `ThalovantIdentityError` |
| #46 | `/disconnect` outlives the connect deadline | Already fixed in 0358a0b (#47): failed-connect cleanup runs within the connect deadline; `test/transport-deadlines.test.ts` |
| #56 | Smoke-test the published package | Already fixed in the #56 squash (07a7c93): `publish.yml` "Smoke-test the public npm package" |
| #59 | Document `listHubSkillHistory` | No longer applies to the README; the docs site Node page lists it |
| #64, #68, #81 | Run the release validation | Not applicable, as for #39 |

### Verification

- `npm ci && npm test` pass; the reference's `scripts/check-sdk-parity.py --consumer thalovant-node-sdk` passes with the refreshed `test/sdk.test.ts` hash.
- The change touches only `test/`, `contracts/`, `CHANGELOG.md` and these reports, none of which are release paths, so `auto-release.yml` cuts no release.

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
- **Actions Taken**: Read the four threads, then the review-body items, against the current code and tests; switched three test assertions to strict comparison; corrected the 0.3.0 CHANGELOG line about the connect default; added three files to the `listing` capability with their SHA-256 evidence; wrote the CHANGELOG entry, this report and `AUDIT.md`; replied on the threads.
- **Oversight**: Run by an agent on the repository owner's request to handle every open CodeRabbit thread; merged through the normal CI gates. No package file changes, so `auto-release.yml` cuts no release.
