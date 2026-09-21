import { strict as assert } from "node:assert";
import { test } from "node:test";

import { usualForm } from "../src/language-matching.js";

/**
 * The tag to retry a listing with, when the hub had nothing under the one
 * asked for.
 *
 * These answers are CLDR's, not this SDK's, and they must be the same ones
 * the Python reference gives: a managed port that disagreed about which
 * language to retry would list a different hub.
 */
test("a regional tag becomes the form skills actually register", () => {
  assert.equal(usualForm("en-CA"), "en-us");
  assert.equal(usualForm("en-AT"), "en-us");
  assert.equal(usualForm("fr-BE"), "fr-fr");
  assert.equal(usualForm("pt-AO"), "pt-br");
  assert.equal(usualForm("pt-PT"), "pt-br");
  assert.equal(usualForm("de-AT"), "de-de");
});

test("a tag already in its usual form has nothing to retry with", () => {
  // undefined rather than the same tag, so a caller can tell "already right"
  // from "no idea", and a hub that answered is never asked twice.
  // Only byte-for-byte. The capital spelling is a different string to a
  // manifest keyed `en-us`, and suppressing its retry was the bug.
  assert.equal(usualForm("en-US"), "en-us");
  assert.equal(usualForm("fr-FR"), "fr-fr");
  assert.equal(usualForm("en-us"), undefined);
  assert.equal(usualForm("fr-fr"), undefined);
});

test("a language nobody has heard of is undefined and not a guess", () => {
  // maximize does not fail on an unknown language: it walks down to `und`
  // and takes the root locale's region, so "zzz" would come back "zzz-us" --
  // a confident United States for a language that does not exist.
  assert.equal(usualForm("zzz"), undefined);
  assert.equal(usualForm(""), undefined);
  assert.equal(usualForm("xx-YY"), undefined);
});
