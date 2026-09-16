/**
 * Record what this SDK produced for each conformance case.
 *
 * The parity gate can check that a test *names* a vector file. It cannot check
 * that the test ran it: a name reaching a loader call is evidence of intent,
 * not of execution. So the gate stopped asking about the test and started
 * asking about its output -- this writes what we computed, and the checker
 * compares it against what the Python reference computed for the same case.
 *
 * The digest has to agree across languages, so it is deliberately the same
 * recipe as `tests/conformance_record.py`: JSON with keys sorted at every
 * depth, no insignificant whitespace, non-ASCII left as itself, SHA-256 of the
 * UTF-8 bytes. `JSON.stringify` already omits whitespace and emits literal
 * non-ASCII; sorting is the only part it will not do for us.
 *
 * Set `THALOVANT_CONFORMANCE_OUT` to a path and run the suite; the results are
 * written there when the process exits.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const results = new Map<string, Map<string, string>>();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  // Built by hand rather than by stringifying a key-sorted object. JavaScript
  // orders integer-like properties numerically however they were inserted, so
  // an object keyed "0".."15" -- `payload_kinds` in binary-vectors.json is
  // exactly that -- comes back 0,1,2,..,10 where Python's sort_keys gives
  // 0,1,10,11,2. Same data, different bytes, different digest.
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys.map(
    (key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key]),
  );
  return "{" + body.join(",") + "}";
}

export function canonicalDigest(value: unknown): string {
  if (value instanceof Uint8Array) {
    return "bytes:" + createHash("sha256").update(value).digest("hex");
  }
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Record what this SDK produced for one case of one vector file. */
export function record(vectorFile: string, name: string, produced: unknown): void {
  let cases = results.get(vectorFile);
  if (!cases) results.set(vectorFile, (cases = new Map()));
  const digest = canonicalDigest(produced);
  const previous = cases.get(name);
  if (previous !== undefined && previous !== digest) {
    throw new Error(`${vectorFile}/${name}: recorded twice with different outputs`);
  }
  cases.set(name, digest);
}

function write(): void {
  const target = process.env.THALOVANT_CONFORMANCE_OUT;
  if (!target) return;
  // `node --test` runs a process per test file, so the binary cases and the
  // conversation cases are computed in different processes and neither can see
  // the other. Each writes what it has as its own shard and then rebuilds the
  // whole file from every shard present; the last process out leaves it
  // complete. `npm run record-conformance` clears the shard directory first,
  // so a case that stopped running cannot survive in one.
  const parts = `${target}.parts`;
  mkdirSync(parts, { recursive: true });
  const mine: Record<string, Record<string, string>> = {};
  for (const vectorFile of results.keys()) {
    mine[vectorFile] = Object.fromEntries(results.get(vectorFile)!);
  }
  if (Object.keys(mine).length > 0) {
    writeFileSync(join(parts, `${process.pid}.json`), JSON.stringify(mine), "utf8");
  }

  const merged = new Map<string, Map<string, string>>();
  for (const name of readdirSync(parts).sort()) {
    const shard = JSON.parse(readFileSync(join(parts, name), "utf8")) as Record<
      string,
      Record<string, string>
    >;
    for (const [vectorFile, cases] of Object.entries(shard)) {
      let into = merged.get(vectorFile);
      if (!into) merged.set(vectorFile, (into = new Map()));
      for (const [caseName, digest] of Object.entries(cases)) {
        const previous = into.get(caseName);
        if (previous !== undefined && previous !== digest) {
          throw new Error(`${vectorFile}/${caseName}: recorded twice with different outputs`);
        }
        into.set(caseName, digest);
      }
    }
  }

  const out: Record<string, unknown> = {};
  for (const vectorFile of [...merged.keys()].sort()) {
    const parsed = JSON.parse(
      readFileSync(new URL(`../../test/${vectorFile}`, import.meta.url), "utf8"),
    );
    const cases: Record<string, string> = {};
    for (const name of [...merged.get(vectorFile)!.keys()].sort()) {
      cases[name] = merged.get(vectorFile)!.get(name)!;
    }
    // The parsed JSON, not the bytes: a vendored copy is allowed to differ in
    // indentation and line endings, and the checker accepts it on the same
    // terms.
    out[vectorFile] = { digest: canonicalDigest(parsed), cases };
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ schema_version: 1, results: out }, null, 2) + "\n", "utf8");
}

process.on("exit", write);
