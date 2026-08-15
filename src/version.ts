/**
 * Single source of truth for the package version and the derived user agent.
 *
 * This module imports nothing, uses no runtime API, and is safe in every
 * bundle: browser entry points reach it through `constants.ts` and
 * `control.ts`, so it must never read `package.json`, `node:fs`, or
 * `import.meta.url`. The version literal is kept in sync with package.json by
 * `npm version` plus the single replacement in `.github/workflows/auto-release.yml`,
 * and `test/version.test.ts` fails if the two ever disagree.
 *
 * Never hard-code a version inside a user-agent literal anywhere else; every
 * user agent must derive from `USER_AGENT`.
 */

/** Package version. Must equal the `version` field of package.json. */
export const SDK_VERSION = "0.2.28";

/** Product token shared by every Thalovant Node SDK user agent. */
export const USER_AGENT_PRODUCT = "ThalovantNodeSDK";

/** User agent sent by both the data-plane and control-plane surfaces. */
export const USER_AGENT = `${USER_AGENT_PRODUCT}/${SDK_VERSION}`;
