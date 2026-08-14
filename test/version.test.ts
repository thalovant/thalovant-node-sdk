/**
 * Pin every user agent to the one package version.
 *
 * Mirrors the Python SDK's tests/test_version.py. That SDK shipped 0.4.20
 * through 0.4.23 with a stale data-plane user agent because the constant was
 * hand-maintained and the release workflow's literal replacement silently
 * no-opped once it fell out of sync. These tests assert against the *derived*
 * value only -- asserting a hard-coded literal would just add another copy to
 * keep in sync -- and reject any version literal that creeps back into a
 * user-agent string.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_USER_AGENT } from "../src/constants.js";
import { ThalovantControlPlane } from "../src/control.js";
import { ThalovantIdentity } from "../src/identity.js";
import { HiveMindHttpTransport } from "../src/transport.js";
import { SDK_VERSION, USER_AGENT, USER_AGENT_PRODUCT } from "../src/version.js";

// Compiled location is dist/test/, so the repository root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function typeScriptSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await typeScriptSources(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files.sort();
}

test("every user agent is derived from the one version constant", () => {
  const expected = `${USER_AGENT_PRODUCT}/${SDK_VERSION}`;

  assert.equal(USER_AGENT, expected);
  assert.equal(DEFAULT_USER_AGENT, expected);

  // The control-plane default is module-private, so read it off an instance.
  assert.equal(new ThalovantControlPlane().userAgent, expected);

  const identity = new ThalovantIdentity({
    access_key: "access",
    password: "secret",
    crypto_key: "0123456789abcdef",
    site_id: "site",
    default_master: "https://hub.example.com",
  });
  assert.equal(new HiveMindHttpTransport(identity).userAgent, expected);
});

test("the data-plane and control-plane user agents are one value", () => {
  // Both surfaces deliberately share one product token and one version, so a
  // future bump cannot move one without the other.
  assert.equal(DEFAULT_USER_AGENT, USER_AGENT);
  assert.equal(new ThalovantControlPlane().userAgent, USER_AGENT);
  assert.ok(USER_AGENT.startsWith(`${USER_AGENT_PRODUCT}/`));
});

test("SDK_VERSION matches the package.json version", async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version?: string };

  assert.ok(manifest.version, "package.json does not declare a version");
  assert.equal(
    SDK_VERSION,
    manifest.version,
    `src/version.ts declares ${SDK_VERSION} but package.json declares ${manifest.version}`,
  );
});

test("no source file hard-codes a user-agent version", async () => {
  const hardCoded = new RegExp(`${USER_AGENT_PRODUCT}/\\d`);
  const offenders: string[] = [];

  for (const path of await typeScriptSources(join(repoRoot, "src"))) {
    if (hardCoded.test(await readFile(path, "utf8"))) {
      offenders.push(relative(repoRoot, path));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "user agents must be derived from src/version.ts USER_AGENT, but a pinned " +
      `version literal was found in: ${offenders.join(", ")}`,
  );
});
