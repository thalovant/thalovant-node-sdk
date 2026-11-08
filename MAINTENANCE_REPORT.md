Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Browser sign-in ported to the final contract (Python #113 at 39e31d8, digest 6dfb3bb31ac7): ten changes, 119 vectors.

# Maintenance report

## 2026-11-08 — Browser sign-in on the final contract (Python #113 at 39e31d8)

The producer's final head is 39e31d8, reference digest `6dfb3bb31ac7590591febef1c4d8372984ca6cdad4700381f869db30c38452df`. `test/browser-login-vectors.json` is re-vendored from it byte for byte (sha256 `b0c73f808c4f26328c27dd4d04eebfbbc3e7c0c81b8d63a666f63737d0259e73`, 119 cases). `contracts/sdk-parity.json` keeps `57c7e71f6456` and replaces the interim `49744ee385bf` with `6dfb3bb31ac7`; the interims 49744ee, 50af673, 0bb293e and 1374f68 were never published.

| # | Change | Here | Tests |
| :--- | :--- | :--- | :--- |
| 1 | No control-plane request leaves the API's origin (scheme, host, port); refused with no status | `send()` resolves the path against the API's URL and refuses a different origin ("Refusing a request off the Thalovant API's origin."). The rewrite of a scheme-like path into a path, from the review round, is removed: the contract refuses it. | vector `sign_ins/a token endpoint that would leave the API is refused before anything is opened`; "no request leaves the API's origin" (the reference's four paths, through `request()` and a body-carrying `send()`, a token on the plane, nothing reaching either server); "the exchange never leaves the API's origin, even past the configuration's own check" |
| 2 | `token_endpoint`: no colon anywhere; every `%` followed by two hex digits | `usableTokenEndpoint()` in `src/native-auth.ts` | the five `config/a token endpoint ...` vectors; extra cases in "a token endpoint that is not a path on the API ..." (`/v1/a:b`, `/v1/%7`, `/v1/%7G`, `/v1/%`, `/v1/%2Fx/%74oken` usable) |
| 3 | `authorization_endpoint` must be openable: port 0 or above 65535; a real host | `realHost()` in `src/native-auth.ts`: a bracketed host must be IPv6 (checked by WHATWG `URL`), a dotted quad is IPv4 (0-255, no leading zero), a numeric last label that is not IPv4 is refused, otherwise ASCII labels `[a-z0-9]` with inner hyphens of 1-63, at most 253 characters | the nine `config/` dashboard vectors; extra cases (leading or trailing hyphen, trailing dot, `1.2.3`, `01.2.3.4`, `[1.2.3.4]`, a 64-character label, 257 characters, `_`; usable: `[2001:db8::1]`, `xn--`, a 63-character label, `localhost`) |
| 4 | Callback `error` keeps only RFC 6749's seven codes | `OAUTH_ERRORS` and `classifyRequest()` in `src/loopback.ts`; `signInThroughBrowser()` repeats `callback.error` only | the three new `callbacks/` vectors and `sign_ins/an error that repeats the state never reaches the error` |
| 5 | Only a missing device name gets the default | `deviceName ?? defaultDeviceName()` in both calls; the chooser's device login gets the empty name, and sends no `client_name` | `sign_ins/an empty device name keeps the hostname off the consent page`, `chooser/an empty device name is not sent to a device login either`; "only a missing device name gets the default" (`undefined`, `null`, `""`) |
| 6 | The accepted tab waits until the sign-in ends | `answerAccepted()` awaits `finish()` with no deadline; `answerTimeoutMs` and `ANSWER_TIMEOUT_MS` removed; `close()` answers a waiting tab | "the accepted tab waits as long as the sign-in takes", "closing the listener answers a tab that is still waiting" (mirroring the reference's two tests) |
| 7 | A `HEAD` answer has headers and no body | `responseBytes(status, text, { head })`; `serve()` passes it for a `HEAD` | "a HEAD request gets the headers and no body" (404, the page headers, a positive `Content-Length`, no body) |
| 8 | Redact the exchange's answer before formatting; one pass, longest first, never inside `[redacted]`; a fresh error | `apiError(..., { everywhere: true })` for the exchange: a JSON answer is scrubbed once parsed (`redactSecretsInJson`), text otherwise, every occurrence of the code, the verifier and the state however short, before the bounded message is built; `redactSecretsInString` is a single pass that skips `[redacted]`. The error is built new from the scrubbed answer, and a transport failure is a fresh `ThalovantApiUnreachableError` with no cause | "a message cut to length keeps no part of a secret" (the verifier straddling the 160-character cut), "scrubbing is one pass, longest first, and leaves its marker alone" (the reference's cases), "a transport failure during the exchange carries nothing of the request" |
| 9 | Drain before closing every answered connection | after the head, reading pauses; `reply()` shuts the write side (`end()`), then `drain()` reads and drops for at most 2 s and 1 MiB and closes | "an early answer is not lost to a reset" (a 600 KB head and a 600 KB unread body, sent while reading: the 400 or 404 arrives whole and no ECONNRESET), "draining a connection is bounded" (a client that never closes; the connection is gone after the bound) |
| 10 | Wording: a link or code sent to someone on another computer delivers nothing to the sender | README, FAQ, CHANGELOG, and the comments in `src/native-auth.ts` and `src/control.ts`; nothing says "cannot be relayed" any more | documentation |

The exchange is sent once: `send()` makes one `fetch`, nothing loops around it, and "the exchange is sent once, never retried, even when its connection resets" counts one POST against a token endpoint that resets the connection. The vectors' scripted API also refuses a second exchange in every case.

### Verification

| Command | Result |
| :--- | :--- |
| `npm test` | 958 tests: 957 passed, 1 skipped (live interop), 0 failed |
| `node --test dist/test/browser-login-vectors.test.js` | 149 passed: the 119 cases, the 27 callbacks through a real listener, 3 checks of the file |
| `npm run record-conformance` | 958 tests, 957 passed; `browser-login-vectors.json` recorded with 119 cases, each equal to the reference's at 39e31d8; the 98 earlier cases record what they did before; every other vector unchanged |
| `check-sdk-parity.py --consumer thalovant-node-sdk` from Python 39e31d8, and from Python `main` (44b6e2b) | both verified; the only note is, against `main`, the capability being ahead of it |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | nothing in the changed files |

### Transparency Report

- **AI Model:** Claude Opus 5.5 (`claude-opus-5-5`), a Claude Code agent directed by the release lead.
- **Actions Taken:** Cloned Python 39e31d8 on its own; read the brief's change table, the final `native_auth.py`, `_loopback.py` and `control.py` and the unit tests it names; ported the ten changes to `src/native-auth.ts`, `src/loopback.ts`, `src/loopback.browser.ts`, `src/control.ts` and `src/redact.ts`; mirrored the named Python tests in `test/browser-login.test.ts`; re-vendored the vectors; re-recorded conformance; refreshed only the changed files' evidence hashes after the suite passed; updated the documentation and these records.
- **Oversight:** No human review yet; the PR stays unmerged for the lead.

## 2026-11-08 — CodeRabbit review of #110 (browser sign-in)

All 14 threads answered. Eleven are fixed with tests, and one (#11) is fixed inside the contract. Two are replied to, because the reference's contract decides them. The reference digests are left as they were (`57c7e71f6456`, `49744ee385bf`); the Python producer is reworking #113, and the lead sends the final digest.

| # | Thread | Outcome |
| :--- | :--- | :--- |
| 0 | Redact decoded JSON | Fixed: a JSON error body is scrubbed once parsed, every string and key, and numbers (`redactSecretsInJson`, `src/redact.ts`). Doing so exposed AUDIT.md B10, a text pass cutting a `\u` escape in two; fixed too. |
| 1 | Document `openUrl` as a callback | Fixed: README states the function type; `browserLogin()` and `interactiveLogin()` refuse a non-function `prompt` or `openUrl` with a `TypeError`. |
| 2 | Validate the device login timeout | Fixed: `interactiveLogin()` refuses a `NaN` or negative `timeoutMs` for either method before sending anything. `loginWithBrowser()` is unchanged. |
| 3 | Abortable opener wait | Fixed: with a `signal`, the device login's opener wait ends on abort with an `AbortError`; without one, `loginWithBrowser()` waits for its opener as before. |
| 4 | Fall back when the listener cannot start | Replied: the brief's chooser falls back only on the browser rule and the configuration, and the reference raises the bind error too. SUGGESTIONS.md #11. |
| 5 | Fall back when the configuration body breaks | Fixed: a broken-off answer is a `ThalovantApiUnreachableError`; `auto` falls back, a forced browser raises it, a cancel stays an `AbortError`. |
| 6 | Keep an explicitly empty device name | Replied: the published reference treats `""` as none (`device_name or default_device_name()`); the pending #113 changes that, and it is ported with the final vectors (AUDIT.md B9). |
| 7 | Check cancellation before presenting | Fixed: checked again after the port is bound and the challenge made. |
| 8 | Keep the state out of callback errors | Fixed: an `error` carrying the state is not repeated. The pending reference keeps only RFC 6749 codes; ported with the final vectors (B9). |
| 9 | Redact short codes | Fixed: a secret under 8 characters is replaced where it stands alone (no letter or digit beside it). |
| 10 | Keep a leading BOM | Fixed: `TextDecoder` with `ignoreBOM: true`, as Python's decode keeps U+FEFF. |
| 11 | Do not report failure while the exchange is pending | Fixed within the published contract: the configuration request and the exchange are bounded at 10 s, the reference's request timeout, so the exchange ends before the tab's 60 s bound. The pending reference drops that bound (B9). |
| 12 | Reject port 0 | Fixed: unusable, as the brief's "a port no browser can open". The reference accepts it; reported (B8). |
| 13 | Keep the token exchange on the API origin (major) | Fixed in `send()`: a scheme-like first segment stays a path segment, and a request off the API's origin is refused. The reference shares the bug (`urljoin(api_url, path.lstrip("/"))`); its pending fix refuses a colon in `token_endpoint`, ported with the final vectors (B9). |

### Verification

| Command | Result |
| :--- | :--- |
| `npm test` | 920 tests: 919 passed, 1 skipped (live interop), 0 failed |
| `node --test dist/test/browser-login.test.js` | 46 passed (33 before, plus the regressions for the fixes above) |
| `npm run record-conformance` | 920 tests, 919 passed, 1 skipped; `contracts/conformance-results.json` unchanged (all 98 browser-login digests still equal to the reference's) |
| `check-sdk-parity.py --consumer thalovant-node-sdk` against Python `main` (44b6e2b) and against an archive of #113's head e3999cb | both verified; the one note is the capability being ahead of `main` |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | nothing in the changed files |
| `GET https://api.thalovant.com/v1/auth/native/config` through `nativeSignInConfig()` | usable: `https://dash.thalovant.com/authorize`, `/v1/auth/native/token`, `thalovant-sdk`; no sign-in was attempted |

### Transparency Report

- **AI Model:** Claude Opus 5.5 (`claude-opus-5-5`), a Claude Code agent directed by the release lead.
- **Actions Taken:** Read the 14 threads; fixed eleven, and #11 within the contract, in `src/control.ts`, `src/redact.ts`, `src/loopback.ts`, `src/native-auth.ts` and README, with tests in `test/browser-login.test.ts` and `test/browser-smoke.test.ts`; replied to #4 and #6; refreshed only the changed files' evidence hashes after the suite passed; read the producer's unpublished #113 work (read-only) to keep the fixes compatible with where the contract is going.
- **Oversight:** No human review yet; the PR stays unmerged for the lead.

## 2026-11-08 — Browser sign-in (0.11.0)

Ports browser sign-in from the Python reference (thalovant-python-sdk#113, commit e3999cb, reference digest `49744ee385bf`) as a consumer of the `browser-login` capability, following its porting brief (`docs/browser-login-porting.md` there).

### What changed

- `src/control.ts`: `browserLogin()` and `interactiveLogin()` on `ThalovantControlPlane`, with `LoginMethod`, `BrowserLoginOptions` and `InteractiveLoginOptions`; the private `nativeSignInConfig()`, `signInThroughBrowser()` and `exchangeBrowserCode()`; `presentBrowserLogin()` and `browserTimeout()`. `loginWithBrowser()` now runs on a private `deviceLogin()` that `interactiveLogin()` shares, so its `signal` can cancel the device login; `pollDeviceToken()` takes an internal `signal`. The device login's public options, defaults, prints and errors are unchanged.
- `src/native-auth.ts`: `SDK_CLIENT_ID`, `LOOPBACK_CALLBACK_PATH`, `DEFAULT_BROWSER_LOGIN_TIMEOUT_MS`, `MAX_DEVICE_NAME_LENGTH`, `newState()`, `loopbackRedirectUri()`, `browserAuthorizationUrl()`, `defaultDeviceName()`, `canOpenBrowser()` and `NativeSignInConfig`. `beginNativeSignIn()` draws its state from `newState()` (the same 24 random bytes).
- `src/loopback.ts` (new, Node only): `LoopbackListener` on `node:net` and the pure `classifyRequest()` and `responseBytes()`. `src/loopback.browser.ts` (new) is its browser twin, mapped in `package.json`'s `browser` field.
- Tests: `test/browser-login-vectors.json` (vendored byte for byte, sha256 `9058adf2ad30fd8b7f255882ce718865170d0d4b84d36f8fbfa23bde51d1651e`), `test/browser-login-vectors.test.ts`, `test/browser-login.test.ts`; `test/browser-smoke.test.ts` gains the loopback stub checks and a sandboxed sign-in.
- Parity: `contracts/sdk-parity.json` adds the candidate digest `49744ee385bf` beside the current `57c7e71f6456`, records `browser-login` (required) with its implementation and test hashes, and refreshes the `src/control.ts` hash in `api-errors`, `chat-apps`, `connection-admission`, `connection-kinds`, `control` and `device-login`, and the `src/native-auth.ts` hash in `control`, after the suite passed on the changed files. `contracts/conformance-results.json` gains the 98 browser-login results; every other vector's record is byte-identical to `main`'s.
- Version 0.11.0 (`package.json`, `package-lock.json`, `src/version.ts`); CHANGELOG, README ("Sign in"; the quick start uses `interactiveLogin()`), AGENTS.md, QUICK_FACTS.md, FAQ.md, AUDIT.md (B1-B7) and SUGGESTIONS.md (#7-#10).

### Porting-brief decisions, as implemented

| Decision | Here |
| :--- | :--- |
| Configuration from `GET /v1/auth/native/config`; 404 means no browser sign-in; unusable 2xx is an error with no status; `loopback_redirect_uri` ignored | `nativeSignInConfig()`, `NativeSignInConfig.fromResponse()` |
| Refuse a cleartext API before anything is asked or opened | `assertSecureTokenExchange()` first in `browserLogin()`, `interactiveLogin({ method: "browser" })`, and as "not usable" in `auto` (AUDIT.md B2 on the error type) |
| Verifier 64 random bytes (86 characters), state 24 (32), S256 challenge | `newVerifier()`, `newState()`, `challengeFor()` |
| Bind `127.0.0.1:0` before the URL; never `0.0.0.0`, `::1` or a name | `LoopbackListener.start()`; the redirect from `loopbackRedirectUri(port)` |
| Only `GET /callback`; 404 otherwise; 400 for an unreadable or 16 KiB+ head; missing, repeated or wrong state is 400 and the wait goes on, compared in constant time as UTF-8 | `classifyRequest()` (`timingSafeEqual` after a length check), the head reader in `LoopbackListener` |
| Error wins over code; exactly one non-empty code; values decoded once as a form | `classifyRequest()`, `queryPairs()`/`unquote()` (Python's `parse_qsl` rules) |
| Stop listening on acceptance; a second answer on an open connection is 400; the accepted tab is answered after the sign-in ends (60 s bound); close waits at most 1 s for it and closes the rest without waiting | `serve()`, `answerAccepted()`, `close()` |
| Five page headers on every answer, `Connection: close`, a page that loads nothing, no request line ever logged | `PAGE_HEADERS`, `responseBytes()`; a `node:net` server with no logging |
| URL parameters in the contract's order, RFC 3986 encoding (`! ' ( ) *` too), scope left out when empty, `device_name` cut to 120 code points | `browserAuthorizationUrl()` |
| Always show the URL (`Opening your browser...` / `To sign in to Thalovant, visit:`), `prompt` takes the print's place, open without blocking | `presentBrowserLogin()`; the opener is called unawaited and its failure ignored; default `openExternalUrl()` (`open`, `xdg-open`, `rundll32 url.dll,FileProtocolHandler`, never `cmd /c start`) |
| Exchange exactly four fields at `token_endpoint`, never retried; 2xx without an object `access_token` has no status; keep the token as a device login does | `exchangeBrowserCode()`, `acceptToken()` |
| Timeout on a monotonic clock, never early; expired and denied reuse the device-login errors with no status | `LoopbackListener.wait()` (`performance.now()`, re-armed), `ThalovantDeviceLoginExpiredError`, `ThalovantDeviceLoginDeniedError` |
| No code, verifier, state or token in an error | `apiError(..., [code, verifier, state])` scrubs the body before parsing, so neither the message nor `problem` (keys included) carries them; no `cause` is attached |
| Chooser: `device` never asks for the configuration; `browser` raises its failures; `auto` needs `canOpenBrowser()` and a usable configuration; no fallback once opened; `timeoutMs` defaults per method | `interactiveLogin()` |
| Cancellation and an injectable opener | `signal` (`AbortSignal`) in both calls, closing the port; `openUrl`, the name `loginWithBrowser()` already uses (AUDIT.md B7) |

### Verification

| Command | Result |
| :--- | :--- |
| `npm ci` | 0 vulnerabilities |
| `npm test` (`tsc`, then `node --test dist/test/*.test.js`) | 907 tests: 906 passed, 1 skipped (live interop, needs `THALOVANT_INTEROP_WSS`), 0 failed |
| `node --test dist/test/browser-login-vectors.test.js` | 125 passed: all 98 vector cases plus the 24 callbacks through a real listener and 3 checks of the file itself |
| `node --test dist/test/browser-login.test.js` | 33 passed |
| `npm run record-conformance` | 907 tests, 906 passed, 1 skipped; `browser-login-vectors.json` recorded (file digest `b17cb43466c0`), all 98 case digests equal to the Python reference's `contracts/conformance-results.json`; every other vector unchanged |
| `python check-sdk-parity.py --reference <python main 44b6e2b> --workspace <ws> --consumer thalovant-node-sdk` | verified; one rollout note (`browser-login` ahead of the current reference) |
| `python check-sdk-parity.py --workspace <ws> --consumer thalovant-node-sdk` from PR #113's head (e3999cb) | verified, nothing outstanding |
| `npx tsc -p tsconfig.json --noEmit --noUnusedLocals --noUnusedParameters` (no lint step exists) | nothing in the changed files; 7 findings already on `main`, in `src/client.ts`, `src/noise.ts`, `test/sdk.test.ts`, `test/link-keeping-vectors.test.ts` |
| `node --test --experimental-test-coverage` over the browser sign-in tests | `dist/src/loopback.js` 96.7 % lines, `dist/src/native-auth.js` 98.9 % lines with `native-auth.test.js` (the rest: defensive branches) |
| `npm audit --audit-level=high`, `npm pack --dry-run` | 0 vulnerabilities; 0.11.0, 122 files, `loopback.js` and `loopback.browser.js` included |
| Clean consumer: install the packed tarball, `tsc --noEmit` with `skipLibCheck: false` over the new API, ESM import smoke | passed |

Not run: a live sign-in (thalovant-api #501 is not deployed, AUDIT.md B5) and Windows or macOS (the listener and the opener are platform code; CI runs Linux only).

### Transparency Report

- **AI Model:** Claude Opus 5.5 (`claude-opus-5-5`), as a Claude Code agent directed by the release lead.
- **Actions Taken:** Read the Python reference (porting brief, `native_auth.py`, `_loopback.py`, `control.py`, both test files, the vectors, the parity entry and checker); wrote `src/loopback.ts`, `src/loopback.browser.ts`, the browser sign-in parts of `src/native-auth.ts` and `src/control.ts`, the three test files and the browser bundle checks; vendored the vectors; regenerated `contracts/conformance-results.json` with `npm run record-conformance`; updated `contracts/sdk-parity.json` only for files this change touched, after the suite passed; wrote the documentation and these records.
- **Oversight:** No human review yet. The change is a pull request against `main`, unmerged; the lead merges, after the Python producer's gate. Nothing was tagged, released or published.

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
