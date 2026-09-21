import assert from "node:assert/strict";
import { test } from "node:test";
import type { Auction } from "../blizzard-api/types.js";
import { aggregateRealmAuctions } from "./auctions.js";
import { buildSnapshotSpec, classifyListing, resolveIlvl, unmappedVariants, type IlvlTable } from "./variants.js";

// The same table shape as config/ilvlBonusIds.json: upgrade-step bonus id -> item level.
const TABLE: IlvlTable = new Map([
  [12842, 308],
  [12843, 311],
]);

const HELM = 271441;
const auction = (id: number, buyout: number, bonus: number[] | undefined, quantity = 1): Auction => ({
  id: Math.floor(Math.random() * 1e9),
  item: { id, bonus_lists: bonus },
  buyout,
  quantity,
  time_left: "LONG",
});

test("resolveIlvl reads the item level from the upgrade-step id and ignores every other bonus id", () => {
  // Real bonus lists from the in-game export (heroic track 13334, step 12842 = 308, 12843 = 311).
  assert.equal(resolveIlvl([6652, 13696, 13662, 13334, 12842, 10844], TABLE), 308);
  assert.equal(resolveIlvl([6652, 13696, 13662, 13334, 12843, 10844], TABLE), 311);
  // The stat-roll id at the front differs between listings of the same level (42 vs 6652): irrelevant.
  assert.equal(resolveIlvl([42, 13662, 13334, 12842, 10844], TABLE), 308);
});

test("resolveIlvl is null when no id is known, and null (not a guess) when ids contradict", () => {
  assert.equal(resolveIlvl(undefined, TABLE), null);
  assert.equal(resolveIlvl([], TABLE), null);
  assert.equal(resolveIlvl([6652, 13662, 10844], TABLE), null);
  assert.equal(resolveIlvl([12842, 12843], TABLE), null);
  // The same level named twice is not a contradiction.
  assert.equal(resolveIlvl([12842, 12842], TABLE), 308);
});

test("classifyListing: untracked item, whole-item tracking, and variant tracking", () => {
  const spec = buildSnapshotSpec([
    { id: HELM, variants: [308, 311] },
    { id: 1234 }, // whole item
    { id: 5678, variants: [] }, // empty variants = whole item
  ]);
  assert.deepEqual(classifyListing(999, [12842], spec, TABLE), { tracked: false });
  assert.deepEqual(classifyListing(1234, undefined, spec, TABLE), { tracked: true, ilvl: null });
  assert.deepEqual(classifyListing(1234, [12842], spec, TABLE), { tracked: true, ilvl: null });
  assert.deepEqual(classifyListing(5678, [12842], spec, TABLE), { tracked: true, ilvl: null });
  assert.deepEqual(classifyListing(HELM, [13334, 12842], spec, TABLE), { tracked: true, ilvl: 308 });
  assert.deepEqual(classifyListing(HELM, [13334, 12843], spec, TABLE), { tracked: true, ilvl: 311 });
});

test("classifyListing drops variant-item listings at an untracked or unrecognised level", () => {
  const spec = buildSnapshotSpec([{ id: HELM, variants: [308] }]);
  assert.deepEqual(classifyListing(HELM, [12843], spec, TABLE), { tracked: false }); // 311 not tracked
  assert.deepEqual(classifyListing(HELM, [13334, 12841], spec, TABLE), { tracked: false }); // step not in table
  assert.deepEqual(classifyListing(HELM, undefined, spec, TABLE), { tracked: false });
});

test("aggregateRealmAuctions keeps item levels apart: 308 and 311 get their own min price, quantity and count", () => {
  const spec = buildSnapshotSpec([{ id: HELM, variants: [308, 311] }]);
  const rows = aggregateRealmAuctions(
    [
      auction(HELM, 30_000_0000, [6652, 13334, 12842]),
      auction(HELM, 25_000_0000, [42, 13334, 12842]), // cheaper 308 with a different stat roll
      auction(HELM, 60_000_0000, [6652, 13334, 12843]),
      auction(HELM, 99_000_0000, [6652, 13334, 12841]), // a level we don't track
      auction(777, 1_0000, undefined), // an item we don't track
    ],
    spec,
    TABLE,
  );
  const by = new Map(rows.map((r) => [r.ilvl, r]));
  assert.equal(rows.length, 2);
  assert.deepEqual(by.get(308), { itemId: HELM, ilvl: 308, minPrice: 25_000_0000, totalQuantity: 2, listingCount: 2 });
  assert.deepEqual(by.get(311), { itemId: HELM, ilvl: 311, minPrice: 60_000_0000, totalQuantity: 1, listingCount: 1 });
});

test("aggregateRealmAuctions: a whole-item series blends every listing, priced per unit for stacks", () => {
  const spec = buildSnapshotSpec([{ id: 1234 }]);
  const rows = aggregateRealmAuctions(
    [auction(1234, 100, [12842], 4), auction(1234, 60, [12843], 2), auction(1234, undefined as unknown as number, undefined)],
    spec,
    TABLE,
  );
  assert.deepEqual(rows, [{ itemId: 1234, ilvl: null, minPrice: 25, totalQuantity: 6, listingCount: 2 }]);
});

test("unmappedVariants names a tracked item level that no bonus id can produce", () => {
  const items = [
    { id: HELM, name: "Crushing Coiler Coif", variants: [308, 311, 314] },
    { id: 1, name: "Whole item" },
  ];
  assert.deepEqual(unmappedVariants(items, TABLE), [{ id: HELM, name: "Crushing Coiler Coif", ilvl: 314 }]);
});
