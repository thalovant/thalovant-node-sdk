Last Edit: Claude Opus 5.5 - 2026-11-03 - Motive: Created with suggestions from the chat apps change (0.10.0).

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
