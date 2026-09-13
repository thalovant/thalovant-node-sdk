import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Inventory,
  InventoryCache,
  Skill,
  Intent,
  commonAffix,
  stripAffix,
  compareNames,
  friendlyTitle,
  languagesPresent,
} from "../src/index.js";
function inventory(): Inventory {
  return new Inventory(
    "hub-1",
    "Example",
    "hub",
    "2026-09-13",
    [
      new Skill(
        "weather",
        "Weather",
        ["en-US", "fr-FR"],
        [
          new Intent("a", "current.weather", "weather", "padatious", {
            "en-US": ["weather in", "what is the weather"],
            "fr-FR": ["quel temps fait-il"],
          }),
        ],
      ),
    ],
    ["from the hub"],
  );
}
test("inventory round trips, selects regional examples and preserves unknown locale knowledge", () => {
  const value = inventory();
  assert.deepEqual(Inventory.fromObject(value.asObject()), value);
  assert.deepEqual(value.intents[0].examples("en-GB", 1), [
    "what is the weather",
  ]);
  assert.equal(value.skills[0].speaks("fr-CA"), true);
  assert.equal(value.skills[0].speaks("de"), false);
  assert.equal(new Skill("x", "X").speaks("en"), undefined);
  assert.deepEqual(languagesPresent(value), ["en-US", "fr-FR"]);
  assert.equal(value.live, true);
  assert.equal(value.hasPhrases, true);
  assert.throws(() =>
    Inventory.fromObject({ ...value.asObject(), cache_version: 99 }),
  );
});
test("display helpers remove common affixes and sort numeric runs", () => {
  assert.equal(
    friendlyTitle("thalovant-skill-date-time.thalovant"),
    "Date Time",
  );
  assert.deepEqual(commonAffix(["current.weather", "high_low.weather"]), [
    "suffix",
    "weather",
  ]);
  assert.equal(stripAffix("high_low.weather", "suffix", "weather"), "high low");
  assert.equal(stripAffix("", "suffix", "weather"), "");
  assert.deepEqual(["intent10", "intent2", "Intent1"].sort(compareNames), [
    "Intent1",
    "intent2",
    "intent10",
  ]);
});
test("cache uses private unique atomic writes and rejects escaping keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-inventory-"));
  try {
    const cache = new InventoryCache(directory);
    const outside = join(directory, "outside");
    await writeFile(outside, "keep");
    await symlink(outside, join(directory, "intents-safe.partial"));
    await Promise.all(
      Array.from({ length: 16 }, () => cache.store("safe", inventory())),
    );
    assert.equal(await readFile(outside, "utf8"), "keep");
    assert.deepEqual(await cache.load("safe"), inventory());
    if (process.platform !== "win32")
      assert.equal(
        (await stat(join(directory, cache.filename("safe")))).mode & 0o777,
        0o600,
      );
    for (const key of ["x/../../outside", "x\\outside", "x".repeat(161)]) {
      await cache.store(key, inventory());
      assert.equal(await cache.load(key), undefined);
    }
    const old = new Date(Date.now() - 7200_000);
    await utimes(join(directory, cache.filename("safe")), old, old);
    assert.equal(await cache.load("safe"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared Python inventory contract survives sorted JSON across SDKs", async () => {
  const data = JSON.parse(
    await readFile(
      new URL("../../test/inventory-vectors.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(InventoryCache.key("hub"), data.cache_key);
  const inventory = Inventory.fromObject(data.inventory);
  for (const row of data.examples)
    assert.deepEqual(
      inventory.intents[0].examples(row.language ?? undefined, row.limit),
      row.expected,
    );
  for (const row of data.speaks)
    assert.equal(inventory.skills[0].speaks(row.language), row.expected);
  assert.equal(inventory.skills[1].speaks("en"), undefined);
});

test("cache keys normalize identity hosts and hash their full untruncated names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thalovant-cache-key-"));
  try {
    const path = join(directory, "identity.json");
    const first = "a".repeat(40) + "one.example",
      second = "a".repeat(40) + "two.example";
    await writeFile(path, JSON.stringify({ default_master: first }), {
      mode: 0o600,
    });
    const key = await InventoryCache.keyForIdentity("hub", path);
    assert.ok(key.startsWith("hub-" + "a".repeat(40) + "-"));
    await writeFile(path, JSON.stringify({ default_master: second }));
    assert.notEqual(await InventoryCache.keyForIdentity("hub", path), key);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
