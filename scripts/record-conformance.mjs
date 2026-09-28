/**
 * Run the suite with conformance recording on, then aggregate the shards.
 *
 * `node --test` runs a process per test file, so the recorded cases arrive in
 * several shards. Aggregating inside each process would mean several of them
 * reading the directory and writing the same file at once, and a merge that
 * scanned before another process wrote its shard could publish an incomplete
 * record afterwards. This runs once, after every test process has exited.
 *
 * Written in Node rather than as a shell one-liner so it works on every
 * platform this SDK supports: `rm -rf` and `VAR=value cmd` are not portable to
 * the default Windows shell.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const target = resolve(process.env.THALOVANT_CONFORMANCE_OUT ?? "contracts/conformance-results.json");
const parts = `${target}.parts`;

function canonicalJson(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(`conformance: cannot canonicalise ${value}`);
    }
    return String(value);
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

const digestOf = (value) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

// A shard left by an earlier run must not be counted as this one's output.
rmSync(parts, { recursive: true, force: true });
rmSync(target, { force: true });
mkdirSync(parts, { recursive: true });

const run = spawnSync("npm", ["test"], {
  stdio: "inherit",
  env: { ...process.env, THALOVANT_CONFORMANCE_OUT: target },
  shell: process.platform === "win32",
});

try {
  const merged = new Map();
  for (const name of readdirSync(parts).sort()) {
    if (!name.endsWith(".json")) continue;
    const shard = JSON.parse(readFileSync(join(parts, name), "utf8"));
    for (const [vectorFile, cases] of Object.entries(shard)) {
      const into = merged.get(vectorFile) ?? new Map();
      merged.set(vectorFile, into);
      for (const [caseName, digest] of Object.entries(cases)) {
        const previous = into.get(caseName);
        if (previous !== undefined && previous !== digest) {
          throw new Error(`${vectorFile}/${caseName}: recorded twice with different outputs`);
        }
        into.set(caseName, digest);
      }
    }
  }

  const results = {};
  for (const vectorFile of [...merged.keys()].sort()) {
    // The parsed JSON, not the bytes: a vendored copy is allowed to differ in
    // indentation and line endings, and the checker accepts it on the same terms.
    const parsed = JSON.parse(readFileSync(resolve("test", vectorFile), "utf8"));
    const cases = {};
    for (const name of [...merged.get(vectorFile).keys()].sort()) {
      cases[name] = merged.get(vectorFile).get(name);
    }
    results[vectorFile] = { digest: digestOf(parsed), cases };
  }

  // Written even when nothing ran: leaving the old file alone would let a
  // suite that executed no case at all present last week's artifact as this
  // run's output.
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.writing`;
  writeFileSync(staging, JSON.stringify({ schema_version: 1, results }, null, 2) + "\n", "utf8");
  renameSync(staging, target);
} finally {
  rmSync(parts, { recursive: true, force: true });
}

process.exit(run.status ?? 1);
