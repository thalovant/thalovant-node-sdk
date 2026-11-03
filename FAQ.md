Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Created with chat apps questions (0.10.0).

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
