import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clusterStatus, computeStock, makeClusterResolver, stockCoverage, type StockObservationRec } from "./stock.js";

// Ids, realms and observations are arbitrary fixtures, NOT real game data.
const ITEM = 100;
const T0 = new Date("2026-09-23T00:00:00.000Z");
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

const connectedRealms = [
  { id: 1, names: ["Silvermoon", "Argent Dawn"] },
  { id: 2, names: ["Tichondrius"] },
];

const obs = (over: Partial<StockObservationRec>): StockObservationRec => ({
  account: "acc1",
  realmName: "Silvermoon",
  characterName: "Char1",
  source: "bags",
  itemId: ITEM,
  quantity: 0,
  observedAt: T0,
  ...over,
});

describe("makeClusterResolver", () => {
  it("groups realm names sharing a connected realm, and falls back to a lone pseudo-cluster otherwise", () => {
    const resolve = makeClusterResolver(connectedRealms);
    assert.equal(resolve("Silvermoon").key, resolve("Argent Dawn").key);
    assert.deepEqual(resolve("Silvermoon").members, ["Silvermoon", "Argent Dawn"]);
    assert.equal(resolve("Unlisted Realm").key, "name:unlistedrealm");
  });

  it("normalizes case and spacing", () => {
    const resolve = makeClusterResolver(connectedRealms);
    assert.equal(resolve("silvermoon").key, resolve("Silvermoon").key);
    assert.equal(resolve(" Argent  Dawn ").key, resolve("Argent Dawn").key);
  });
});

describe("stockCoverage", () => {
  it("counts a cluster once it has any known positive stock, and gives the total roster cluster count", () => {
    const roster = [
      { realmName: "Silvermoon", characterName: "Char1" },
      { realmName: "Tichondrius", characterName: "Char2" },
    ];
    const observations = [obs({ realmName: "Silvermoon", characterName: "Char1", quantity: 3 })];
    const c = stockCoverage(ITEM, { roster, observations, connectedRealms, now: T0 });
    assert.deepEqual(c, { clustersWithStock: 1, totalClusters: 2 });
  });

  it("treats a never-scanned character as 0, not unknown - a cluster with no observations at all does not count", () => {
    const roster = [{ realmName: "Silvermoon", characterName: "Char1" }, { realmName: "Tichondrius", characterName: "Char2" }];
    const c = stockCoverage(ITEM, { roster, observations: [], connectedRealms, now: T0 });
    assert.deepEqual(c, { clustersWithStock: 0, totalClusters: 2 });
  });

  it("ignores a stale (>48h) auction observation but still counts a fresh bags observation", () => {
    const roster = [{ realmName: "Silvermoon", characterName: "Char1" }];
    const observations = [
      obs({ source: "auctions", quantity: 5, observedAt: hoursAgo(72) }),
      obs({ source: "bags", quantity: 1, observedAt: hoursAgo(1) }),
    ];
    const c = stockCoverage(ITEM, { roster, observations, connectedRealms, now: T0 });
    assert.equal(c.clustersWithStock, 1); // the bags unit alone is enough
  });

  it("does not count a different item's stock", () => {
    const roster = [{ realmName: "Silvermoon", characterName: "Char1" }];
    const observations = [obs({ itemId: 999, quantity: 5 })];
    const c = stockCoverage(ITEM, { roster, observations, connectedRealms, now: T0 });
    assert.equal(c.clustersWithStock, 0);
  });

  it("counts every roster cluster in the denominator, even ones this item has never been held in", () => {
    // computeStock would exclude an out-of-scope cluster entirely; stockCoverage never filters by scope.
    const roster = [
      { realmName: "Silvermoon", characterName: "Char1" },
      { realmName: "Tichondrius", characterName: "Char2" },
    ];
    const c = stockCoverage(ITEM, { roster, observations: [], connectedRealms, now: T0 });
    assert.equal(c.totalClusters, 2);
  });
});

describe("computeStock still behaves the same after sharing makeClusterResolver", () => {
  it("groups realms into one row per connected realm and reports OUT/OK correctly", () => {
    const craftedItems = [{ id: ITEM, name: "Widget" }];
    const roster = [{ account: "acc1", realmName: "Silvermoon", characterName: "Char1" }];
    const observations = [obs({ source: "bags", quantity: 2, observedAt: T0 })];
    const report = computeStock({
      craftedItems,
      observations,
      held: [{ realmName: "Silvermoon", characterName: "Char1", itemId: ITEM }],
      roster,
      sales: [],
      connectedRealms,
      now: T0,
    });
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].rows.length, 1);
    assert.equal(report.items[0].rows[0].status, "OK");
    assert.equal(report.items[0].rows[0].total, 2);
  });
});

describe("clusterStatus (sanity, unchanged)", () => {
  it("OUT when fully known and zero, UNKNOWN when partly unknown and zero", () => {
    assert.equal(clusterStatus([{ bags: 0, auctions: 0 }]).status, "OUT");
    assert.equal(clusterStatus([{ bags: null, auctions: 0 }]).status, "UNKNOWN");
    assert.equal(clusterStatus([{ bags: 1, auctions: null }]).status, "OK");
  });
});
