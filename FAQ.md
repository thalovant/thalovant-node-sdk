Last Edit: Claude Opus 5.5 - 2026-11-08 - Motive: Browser sign-in and interactiveLogin() questions (0.11.0).

# FAQ

**How do I connect a Telegram bot to a hub?**
`createBridge({ hubId, connector: "telegram", token: new SecretValue(botToken) })`, add the bot to a group with `bridge.invite_links.add_to_group`, pick chats from `listBridgeChats(bridge.id)` and start it with `updateBridge(bridge.id, { allowed })`. See the README's "Chat apps" section.

**Why does `createBridge()` refuse before sending anything?**
It takes exactly one of `token` and `secrets`, as the Thalovant API does. Telegram, Discord and Mattermost take `token`; Matrix and Twitch take `secrets` (`listChatAppConnectors()` lists each connector's secret keys).

**Can I pass a plain string as a token?**
Yes. It is wrapped in a `SecretValue` at once. Wrapping it yourself keeps it out of your own logs too: a `SecretValue` prints `[redacted]` in `String()`, template strings, `JSON.stringify` and `console.log`.

**How do I pause or resume a bridge?**
`updateBridge(id, { paused: true })` and `updateBridge(id, { paused: false })`. Resuming needs room in the plan's allowance (403 `plan_limit` otherwise).

**What does `bridge.hold` mean?**
`null` when the owner paused it (or it is running). `{ reason: "plan_limit" }` when the plan allows fewer running bridges, and `{ reason: "account_suspended" }` while the account is suspended.

**Which settings did the API refuse?**
`error.fields` on the `ThalovantApiError` lists their names (`bridge_settings_invalid`, `bridge_secrets_invalid`, `bridge_url_*`); never their values.

**Why does `listBridgeChats()` return no rows for Matrix or Twitch?**
Those connectors have no chat discovery: `manual_entry` is `true`, and the ids are typed, checked against the connector's `targets.pattern`.

**Why does Telegram answer 409 `bridge_running` when I list chats?**
A running Telegram bridge owns the bot's update stream. Pause it, list the chats, then resume.

**What happens to a status reason the SDK does not know?**
It is kept as the string the API sent. Every enumeration in `src/chat-apps.ts` is open.

**How should a script or CLI sign somebody in?**
`await api.interactiveLogin()`. On a machine with a browser it opens the Thalovant consent page and waits on `http://127.0.0.1:<port>/callback` (OAuth with PKCE, RFC 8252); elsewhere it prints a device code to approve from any browser. See the README's "Sign in" section.

**Why did `interactiveLogin()` print a device code instead of opening my browser?**
`auto` uses the browser only when `canOpenBrowser()` is true and `GET /v1/auth/native/config` answers with a usable configuration. It is false when `CI`, `SSH_CONNECTION` or `SSH_TTY` is set (`CI=false` counts), and on Linux or a BSD without `DISPLAY` or `WAYLAND_DISPLAY`. An API without browser sign-in answers the configuration 404. Pass `{ method: "browser" }` to force the browser.

**Can a denied or timed-out browser sign-in fall back to a device code?**
No. Once the consent page was shown, its outcome stands: `ThalovantDeviceLoginDeniedError` or `ThalovantDeviceLoginExpiredError` (both with no `statusCode`). Call `interactiveLogin()` again, or `{ method: "device" }`.

**Why is a browser sign-in safer than a device code?**
A device code can be read off one screen and typed in anywhere, so it can be relayed to somebody else (device-code phishing). A loopback redirect cannot: the browser that approves delivers the code to its own computer.

**A browser tab says "This answer does not belong to the sign-in in progress." Did the sign-in fail?**
No. That tab carried another sign-in's `state` (an old tab, another program) and was answered 400; the sign-in in progress keeps waiting for its own answer.

**Can I use `browserLogin()` in a web page?**
No: a page cannot listen on a port. In a browser bundle `browserLogin()` refuses, and `interactiveLogin()` uses the device login. Web apps use their own redirect with `beginNativeSignIn()` and `completeNativeSignIn()`.

**How do I show the sign-in URL in my own UI, or cancel the wait?**
`browserLogin({ prompt: (url) => show(url), openBrowser: false })` shows it without opening anything, and `signal` (an `AbortSignal`) cancels either method and closes the port.

**Why does `browserLogin()` throw a `TypeError` about cleartext?**
The API URL is neither https nor a loopback address. The SDK refuses before asking or opening anything, so a code and its verifier never cross the network in cleartext. `completeNativeSignIn()` refuses the same way.

**How do I sign out after a browser sign-in?**
`await api.revokeApiToken()`. The token is kept exactly as a device login's (`accessToken`, `tokenId`), and revoking it twice sends nothing the second time.
