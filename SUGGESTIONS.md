Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Add #6, scrubbing secrets from the parsed error body (CodeRabbit on #89).

# Suggestions

## 1. Shared vectors for `fields`

- **Problem:** every SDK reads the problem's `fields`, but no shared vector says what each must produce (AUDIT.md #1).
- **Proposal:** add cases to the Python reference's `api-error-vectors.json` (top-level `fields`, `fields` inside an object `detail`, a list with non-strings, none), record `fields` in each SDK's conformance output, and re-vendor here.
- **Impact:** medium; one behaviour proved the same way in every SDK.

## 2. A "wait until connected" helper

- **Problem:** after `updateBridge({ allowed })` a caller polls `getBridge()` until `status.reason` is `Connected`, or reads `TokenRejected` / `Unavailable`.
- **Proposal:** `waitForBridge(bridgeId, { timeoutMs })`, built like `waitForHubSkillOperation` in `src/control.ts`, resolving on `Connected` and rejecting on `TokenRejected`.
- **Impact:** low to medium; fewer hand-written loops in apps and the MCP server.

## 3. Chat apps on the documentation site

- **Problem:** the README carries the chat apps guide; the Node SDK page on docs.thalovant.com does not yet.
- **Proposal:** move the README section to the documentation site in the same release train and link it from the README.
- **Impact:** medium; one place to read it.

## 4. A lint step in CI

- **Problem:** CI type-checks but does not lint (AUDIT.md #6).
- **Proposal:** add a lint step (for example `tsc --noUnusedLocals --noUnusedParameters` or ESLint) to `.github/workflows/ci.yml`.
- **Impact:** low; catches unused code early.

## 5. Paging for the bridge list

- **Problem:** `GET /v1/bridges` answers at most 500 bridges and has no cursor (AUDIT.md #9).
- **Proposal:** once the API adds a cursor, follow it in `listBridges()` the way `listHubs()` takes `cursor`.
- **Impact:** low today; matters for platform administrators and large tenants.

## 6. Scrub secrets from the parsed error body as well

- **Problem:** `redactSecretsInText` (`src/redact.ts`) replaces a secret's known spellings before `apiError` (`src/control.ts`) parses the body: the raw one, the `JSON.stringify` one, and the one with every non-ASCII character `\u`-escaped. Any other valid JSON spelling decodes the secret back into `problem` and the message (AUDIT.md, Open). That covers a `\u`-escaped ASCII character such as `\u0022`, `\/`, and non-ASCII escaped in some places only. The API does not write those spellings. Since 0.10.0, though, user-entered bridge secrets take this path.
- **Proposal:** after `JSON.parse`, walk the parsed value and replace each secret in every string, keys included, then build the message from that. Keep the text pass for a body that is not JSON. Add a case to `test/home-link.test.ts` whose JSON body spells a quote inside the secret as `\u0022`, and assert that the decoded secret is in neither `message` nor `problem`. Port it to the other SDKs in the same release train.
- **Impact:** low today. For a JSON body, the scrub then no longer depends on how the body is escaped. A body that is not JSON has no escapes to decode, so it keeps today's text pass: the raw spelling and the listed ones are scrubbed, and nothing else.
