import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPrivateTerms, formatPrivateTermsFile } from "./privateTerms.js";
import type { ExtractedAccountData } from "../earnings/savedVariables.js";

function emptyData(): ExtractedAccountData {
  return {
    sales: [],
    purchases: [],
    roster: [],
    missingRealmOrCharacter: 0,
    stockObservations: [],
    stockHeld: [],
    stockWarnings: [],
  };
}

test("collects character, buyer and seller names from sales/purchases/roster - NOT realm names", () => {
  const data = emptyData();
  data.sales.push({
    realmName: "Anub'arak",
    characterName: "Examplechar",
    itemName: "Vial of the Sands",
    itemId: 65891,
    quantity: 1,
    totalSaleCopper: 1000000,
    depositCopper: null,
    consignmentCopper: 50000,
    netCopper: 950000,
    buyer: "Buyerchar",
    commerceAuction: true,
    capturedAt: "2026-09-20T10:00:00Z",
    dupOrdinal: 0,
  });
  data.purchases.push({
    realmName: "Aggramar",
    characterName: "Otherchar",
    itemName: "Kyparite",
    itemId: 72093,
    quantity: 20,
    totalPaidCopper: 200000,
    seller: "Sellerchar",
    commerceAuction: true,
    capturedAt: "2026-09-20T10:00:00Z",
    dupOrdinal: 0,
  });

  const terms = collectPrivateTerms([{ data }]);
  for (const expected of ["Examplechar", "Buyerchar", "Otherchar", "Sellerchar"]) {
    assert.ok(
      terms.some((t) => t.toLowerCase() === expected.toLowerCase()),
      `expected "${expected}" in ${JSON.stringify(terms)}`,
    );
  }
  // Realm names are deliberately excluded: with a roster spanning most EU
  // realm clusters (CLAUDE.md #16), a real realm name shows up coincidentally
  // in unrelated code/doc examples far too often to be useful as a denylist
  // term (verified 2026-09-27: it flagged code comments and test fixtures
  // that merely used a real realm name as an illustrative example).
  assert.ok(!terms.some((t) => t.toLowerCase() === "anub'arak"));
  assert.ok(!terms.some((t) => t.toLowerCase() === "aggramar"));
});

test("drops short terms (below MIN_TERM_LENGTH) and null buyer/seller", () => {
  const data = emptyData();
  data.roster.push({ realmName: "EU", characterName: "Bob", connectedRealmId: null, addedAt: null });
  data.sales.push({
    realmName: "Longrealmname",
    characterName: "Longcharname",
    itemName: "X",
    itemId: null,
    quantity: 1,
    totalSaleCopper: 1,
    depositCopper: null,
    consignmentCopper: null,
    netCopper: 1,
    buyer: null,
    commerceAuction: null,
    capturedAt: "2026-09-20T10:00:00Z",
    dupOrdinal: 0,
  });

  const terms = collectPrivateTerms([{ data }]);
  assert.ok(!terms.some((t) => t.toLowerCase() === "bob")); // below MIN_TERM_LENGTH
  assert.ok(terms.some((t) => t.toLowerCase() === "longcharname"));
});

test("does not split a multi-word term into individual words", () => {
  // Regression test: an earlier version split multi-word terms (e.g. a
  // two-word character or buyer name) into individual words, which then
  // matched ordinary English words all over the repo. Full phrase only.
  const data = emptyData();
  data.sales.push({
    realmName: "Somerealm",
    characterName: "Solochar",
    itemName: "X",
    itemId: null,
    quantity: 1,
    totalSaleCopper: 1,
    depositCopper: null,
    consignmentCopper: null,
    netCopper: 1,
    buyer: "Main Account",
    commerceAuction: null,
    capturedAt: "2026-09-20T10:00:00Z",
    dupOrdinal: 0,
  });
  const terms = collectPrivateTerms([{ data }]);
  assert.ok(terms.some((t) => t.toLowerCase() === "main account"));
  assert.ok(!terms.some((t) => t.toLowerCase() === "account"));
  assert.ok(!terms.some((t) => t.toLowerCase() === "main"));
});

test("dedupes character-name terms case-insensitively across sources", () => {
  const data = emptyData();
  data.roster.push({ realmName: "Somerealm", characterName: "Golden", connectedRealmId: null, addedAt: null });
  data.stockObservations.push({
    realmName: "Somerealm",
    characterName: "GOLDEN",
    source: "bags",
    itemId: 1,
    quantity: 1,
    observedAt: "2026-09-20T10:00:00Z",
  });
  const terms = collectPrivateTerms([{ data }]);
  assert.equal(terms.filter((t) => t.toLowerCase() === "golden").length, 1);
});

test("includes the WTF account folder id but NOT the account label", () => {
  // Deliberately not a realistic Battle.net-account-id-shaped fixture (six
  // or more digits, a hash, then a digit): that's exactly what
  // checkPrivateData.ts's own generic pattern looks for, so a fixture in that
  // shape would make this test file flag itself on every future push. The
  // folder-passthrough behavior under test doesn't depend on the string's
  // shape.
  const terms = collectPrivateTerms([], [{ folder: "test-folder-id", label: "Account 1" }]);
  assert.ok(terms.some((t) => t === "test-folder-id"));
  // Label excluded deliberately: low sensitivity (CLAUDE.md #13 - the folder
  // is the actual Battle.net identifier, the label is just a display name)
  // and it collides with config/earningsAccounts.example.json's own
  // placeholder text ("Account 1", "Account 2", ...).
  assert.ok(!terms.some((t) => t.toLowerCase() === "account 1"));
});

test("formatPrivateTermsFile writes a header comment and one term per line", () => {
  const out = formatPrivateTermsFile(["alpha", "beta"]);
  assert.match(out, /^# Auto-generated/);
  assert.match(out, /\nalpha\nbeta\n$/);
});

test("formatPrivateTermsFile with no terms still writes the header", () => {
  const out = formatPrivateTermsFile([]);
  assert.match(out, /^# Auto-generated/);
  assert.ok(!out.includes("\n\n\n"));
});
