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
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const results = new Map<string, Map<string, string>>();

function canonicalJson(value: unknown): string {
  if (typeof value === "number") {
    // Refused rather than passed through. Only a whole number inside 2^53 is
    // written the same way by every language here; 1.5 and 1e-7 have
    // per-language spellings, and recording one would be a digest for a value
    // nobody produced. No vector contains one, and if one ever does this
    // should stop rather than lie.
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
      throw new Error(
        `conformance: cannot canonicalise ${value}: only whole numbers within 2^53 are ` +
          "spelled the same way in every language",
      );
    }
    return String(value);
  }
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
  // Only this process's shard, written atomically. `node --test` runs a
  // process per test file, so the binary cases and the conversation cases are
  // computed in different processes; aggregating them here would mean several
  // processes reading the shard directory and writing the same file at once,
  // and a merge that scanned before another process wrote its shard could
  // publish an incomplete record afterwards. `scripts/record-conformance.mjs`
  // does the aggregation once, after every test process has exited.
  const parts = `${target}.parts`;
  mkdirSync(parts, { recursive: true });
  const mine: Record<string, Record<string, string>> = {};
  for (const vectorFile of results.keys()) {
    mine[vectorFile] = Object.fromEntries(results.get(vectorFile)!);
  }
  if (Object.keys(mine).length === 0) return;
  const shard = join(parts, `${process.pid}.json`);
  const staging = `${shard}.writing`;
  writeFileSync(staging, JSON.stringify(mine), "utf8");
  renameSync(staging, shard);
}

process.on("exit", write);
