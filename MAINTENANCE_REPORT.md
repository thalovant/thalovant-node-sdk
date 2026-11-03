Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Created with the chat apps change (0.10.0).

# Maintenance report

## 2026-11-03: chat apps (0.10.0)

**Change.** Added the owner routes under `/v1/bridges` to `ThalovantControlPlane` (`src/control.ts`), their models, readers, request bodies and `SecretValue` (`src/chat-apps.ts`), the exports (`src/index.ts`), and `ThalovantApiError.fields` (`src/errors.ts`). Version 0.10.0 in `package.json`, `package-lock.json` and `src/version.ts`. README "Chat apps" section, CHANGELOG entry, and a `chat-apps` entry in `contracts/sdk-parity.json` with refreshed hashes for the capabilities whose evidence files changed.

**Rationale.** Hub owners can connect chat networks to their hubs; the SDKs and the MCP server expose the same owner routes with parallel names. The Python SDK is the parity reference.

**Verification.**
- `npm ci`, `npm audit --audit-level=high` (0 vulnerabilities), `npm test` (747 tests: 746 passed, 1 skipped live-interop test that needs credentials), `npm pack --dry-run` (116 files), on Node.js 22 locally; CI runs Node.js 20, 22 and 24.
- `test/chat-apps.test.ts`: 30 tests covering every route, parsing with unknown enumeration values and absent optional members, errors with `code` and `fields`, the plan and auth error classes, and secrets absent from every printed form.
- The shared api-error vectors still pass; one local assertion now expects `fields: []` in the error's JSON.
- Parity checker run as a consumer: verified, with the expected rollout note that the reference does not know `chat-apps` yet.

### Transparency report

- **AI model:** Claude Opus 5.5 (`claude-opus-5-5`).
- **Actions taken:** wrote the chat apps module, the control-plane methods, the error `fields` member, the tests, README, CHANGELOG, parity entry and these repository notes; ran the test suite, package check and parity checker.
- **Oversight:** automated tests and CI, CodeRabbit review on the pull request, merged by the repository owner's delegated agent.
