Last Edit: Claude Sonnet 5.5 - 2026-11-11 - Motive: Intercom amendment 2 and the final API: urgent scope, can_play, replayed, platform switch.

# FAQ

**Why does an urgent `announce` reject with `ThalovantUrgentScopeRequiredError`?**
`priority: "urgent"` (and so every `repeat`) needs the scope `intercom:urgent` in addition to `intercom:send`. Nothing implies it, and nothing was spent (no rate token, no hub call). Sign in again with the scope (a paid plan), or send a normal announcement.

**Why does `updateIntercomSpeaker(..., { receive: true })` reject with `ThalovantNotASpeakerError`?**
A connection that cannot play speech (`can_play` false: `home_assistant`, `developer` and `embedded` unless its owner declared `spec.intercom.can_play: true` on the connection) is listed so it can be greyed out, but it cannot receive and is never part of `all`, a room or a group.

**What does `announcement.replayed` mean?**
The API answered with `Idempotency-Replayed: true`: this is the stored announcement for your key, nothing new was sent, whatever its status. Do not tell the person it was sent anew.

**Why does everything reject with `ThalovantIntercomPlatformDisabledError`?**
Intercom ships dark: until the platform operator turns it on, `getIntercomSettings` reads `unavailable_reason: "platform"` for every hub and every write and announcement is a 503 `intercom_disabled_platform`. Reads and `cancelAnnouncement` still work.

**Is intercom a safety system, and why is there no `intercom()` method?**
It is announce-only text spoken by each speaker's own text-to-speech, and **not a certified safety system**: it does not replace smoke or CO alarms, medical alert devices or emergency services. The mesh already has an `intercom` frame, so the HTTP calls are `announce`, `getAnnouncement`, `listAnnouncements` and `*Intercom*`. The API does not store the text (a keyed hash and the length only), and intercom does not record or store speech; while an alert sounds it only checks whether a reply is an acknowledgement.

**Why did `announce({ wait: true })` reject after the announcement was accepted?**
`wait` polls `getAnnouncement` (`intercom:read`, which `intercom:send` implies); a poll can still fail on a 429 or the network. The announcement exists and the rejection has no id. Create a fresh `idempotencyKey` (`crypto.randomUUID()`) **before** the first call and keep that exact key (a new key is a different attempt and can announce twice), then call again with it and without `wait`: the POST replays the stored announcement, with its id, makes no status read and does not say it twice (with `wait` the repeat call polls again and can reject with the same error). If the first call had no key, nothing can replay it: find the announcement with `listAnnouncements(hubId, { limit: 5 })` (newest first) before sending again.

**Why did my second announcement say nothing, and the result is the first one?**
The same `idempotencyKey` replays the stored announcement (`Idempotency-Replayed: true`) for 24 hours and never sends again, whatever its status. You reused a key (or a constant like `"dinner"`). Use a fresh `crypto.randomUUID()` per announcement you mean to send; to send the same text again on purpose, use a new key.

**`announce` rejected with `ThalovantHubUnreachableError`. Can I send again with the same key?**
Not to send again: a replayed `failed` announcement stays `failed`. The hub may have spoken it, and a `failed` record is not proof that it did not. Read `getAnnouncement(hubId, error.announcementId)`, weigh the risk of saying it twice, and use a new key only when you choose to send a second attempt.

**How do I stop an urgent announcement that is repeating?**
`cancelAnnouncement(hubId, announcementId)` (`intercom:send`; the owner, a manager, a plain member or an administrator, an impersonated session too): status `cancelled`, `hub_confirmed: false` when the hub could not confirm. Only while `sending`, else `ThalovantNotCancellableError` (409). Other controls: the hub's switch, the platform kill switch, a speaker's `receive`, and somebody acknowledging by voice.

**Why is `getAnnouncement(hubId, "..")` refused?**
An id that is `.`, `..`, empty, or holds `/`, `?`, `#`, a backslash or a control character is refused before any request: a dot segment would change the route.

**Why was nobody spoken to?**
A speaker is skipped unless its `receive` is true (`skipped_not_receiving`, even for urgent); a normal announcement is skipped inside quiet hours (`skipped_dnd`; urgent bypasses them); an offline speaker is `offline`. `ThalovantIntercomDisabledError` is the hub's switch being off only when the error is exactly that class: `ThalovantIntercomPlatformDisabledError` and `ThalovantIntercomUnavailableError` (a kid or public hub) are kinds of it, so check them first before telling anybody to change the hub's setting. `delivered` is not "heard": there is no playback receipt.

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
A device code can be read off one screen and typed in anywhere, and whoever approves it, from any computer, signs the waiting program in, so it can be passed to somebody else (device-code phishing). With browser sign-in, the browser that approves hands its code to this computer's `127.0.0.1`, so a browser sign-in link, or the code it brings back, sent to someone on another computer delivers nothing to the sender. That is all it promises: a forwarded callback port (`ssh -L`, a port-forwarding tool) or another user of this computer can still complete one.

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

**How do I keep the hostname off the consent page?**
Pass `deviceName: ""`. Only a missing name (`undefined` or `null`) gets the default `thalovant-node-sdk on <hostname>`; an empty one is left out of the URL, and a device login then sends no `client_name`.

**Why does `interactiveLogin()` use a device login although the API offers browser sign-in?**
The configuration was unusable. A `token_endpoint` with a colon anywhere, or a `%` not followed by two hex digits, and an `authorization_endpoint` on port 0 or with a host that is not an IP address or an ASCII hostname (`xn--` for an international name; no `_`, `%` or empty label), all count as unusable. No request ever leaves the API's own origin.

**Why does a callback's `error` sometimes not show in the error?**
Only RFC 6749's seven codes (`invalid_request`, `unauthorized_client`, `access_denied`, `unsupported_response_type`, `invalid_scope`, `server_error`, `temporarily_unavailable`) are kept. Anything else was chosen by whoever opened the tab, and could be the state or a code.
