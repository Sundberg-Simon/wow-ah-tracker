import { test } from "node:test";
import assert from "node:assert/strict";
import { findTermHits } from "./checkPrivateData.js";

test("matches a term as a whole word, case-insensitively", () => {
  assert.equal(findTermHits("the Buyerchar bought it", "buyerchar"), true);
  assert.equal(findTermHits("Buyercharx bought it", "buyerchar"), false);
  assert.equal(findTermHits("xBuyerchar bought it", "buyerchar"), false);
});

test("matches a term followed by a possessive 's (regression: 2026-09-28 fix)", () => {
  // Real bug: a real account folder name followed by "'s export" in a commit
  // message didn't match the term because apostrophe used to be treated as
  // continuing the word on both sides of the boundary check. Fixture name
  // here is a placeholder, not the real one that exposed the bug.
  assert.equal(findTermHits("Someaccount's export", "Someaccount"), true);
  assert.equal(findTermHits("merged from Someaccount's account", "Someaccount"), true);
});

test("still matches a term with its own internal apostrophe (e.g. a name like Anub'arak)", () => {
  assert.equal(findTermHits("sold on Anub'arak last night", "Anub'arak"), true);
  assert.equal(findTermHits("sold on Anub'arakx last night", "Anub'arak"), false);
});
