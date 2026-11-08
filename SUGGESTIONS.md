Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Add #7-#10 from the browser sign-in port (0.11.0).

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

## 7. One error type for a cleartext token exchange, across the SDKs

- **Problem:** this SDK refuses a cleartext API URL with a `TypeError` (`assertSecureTokenExchange`, shared with `completeNativeSignIn()`); the Python reference raises `ThalovantAPIError` (AUDIT.md B2). No shared vector says which, so each port picks.
- **Proposal:** add a `sign_ins` case to the reference's `browser-login-vectors.json` for an API served on a non-loopback `http` URL, expecting a named outcome (for example `{"outcome": "refused"}`), and have each SDK map its own error to it. Changing this SDK's error type would be a breaking change for `completeNativeSignIn()` callers, so it waits for a major release or stays mapped.
- **Impact:** low; one behaviour proved the same way everywhere.

## 8. Browser sign-in on the documentation site

- **Problem:** the README carries the new "Sign in" section; the Node SDK page on docs.thalovant.com still describes password, device and token sign-in only.
- **Proposal:** move the section to the documentation site in the same release train (AGENTS.md asks for it), and link it from the README.
- **Impact:** medium; people find `interactiveLogin()` where they look first.

## 9. Drop the old reference digest after the Python merge

- **Problem:** `contracts/sdk-parity.json` acknowledges both `57c7e71f6456` and the candidate `49744ee385bf` so this change is green before and after thalovant-python-sdk#113 merges.
- **Proposal:** once Python's `main` carries `49744ee385bf`, remove `57c7e71f6456` from `reference_digests` in a follow-up, re-running `check-sdk-parity.py`. If #113 changes anything under `src/` or `contracts/conformance/` before it merges, the candidate moves: re-read it and re-run this suite first.
- **Impact:** low; keeps the acceptance honest about what was reviewed.

## 10. MCP's begin/poll tools on top of `browserLogin()`

- **Problem:** the MCP server turns browser sign-in into two tools (`thalovant_begin_browser_login`, `thalovant_poll_browser_login`), and this SDK offers one call that waits.
- **Proposal:** none needed in this SDK: the begin tool can call `browserLogin({ prompt, openBrowser, signal })`, answer the URL its `prompt` receives, and keep the pending promise per principal; the poll tool reads that promise's state, and `signal` cancels it. Only if MCP needs to survive a server restart mid sign-in would a stepwise API help, and a loopback port does not survive one anyway.
- **Impact:** informational for the MCP port.
