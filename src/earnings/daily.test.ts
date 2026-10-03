import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dailySales, localDay, nextDay } from "./daily.js";
import type { SaleRec } from "./aggregate.js";

const TZ = "Europe/Stockholm";
const sale = (capturedAt: string, netGold: number, realmName = "Garona", characterName = "Alt"): SaleRec => ({
  account: "A",
  realmName,
  characterName,
  capturedAt: new Date(capturedAt),
  netCopper: netGold * 10000,
  itemName: "Widget",
  itemId: null,
  quantity: 1,
});
const roster = new Set(["Garona|Alt"]);

describe("localDay / nextDay", () => {
  it("uses the local calendar day, not UTC", () => {
    // 23:30 UTC on 2 Oct is 01:30 on 3 Oct in Stockholm (CEST, UTC+2)
    assert.equal(localDay(new Date("2026-10-02T23:30:00Z"), TZ), "2026-10-03");
    assert.equal(localDay(new Date("2026-10-02T21:59:00Z"), TZ), "2026-10-02");
  });
  it("steps calendar days across month ends and the DST change", () => {
    assert.equal(nextDay("2026-09-30"), "2026-10-01");
    assert.equal(nextDay("2026-10-24"), "2026-10-25");
    assert.equal(nextDay("2026-10-25"), "2026-10-26"); // DST ends 25 Oct in Europe
    assert.equal(nextDay("2026-12-31"), "2027-01-01");
  });
});

describe("dailySales", () => {
  const now = new Date("2026-10-05T10:00:00Z");

  it("zero-fills every day from the first sale through today", () => {
    const r = dailySales([sale("2026-10-01T10:00:00Z", 100), sale("2026-10-03T10:00:00Z", 50)], roster, now, TZ);
    assert.deepEqual(
      r.all.points.map((p) => [p.day, p.netCopper / 10000, p.salesCount]),
      [
        ["2026-10-01", 100, 1],
        ["2026-10-02", 0, 0],
        ["2026-10-03", 50, 1],
        ["2026-10-04", 0, 0],
        ["2026-10-05", 0, 0],
      ],
    );
  });

  it("buckets a sale just after local midnight into the new day", () => {
    const r = dailySales([sale("2026-10-02T21:30:00Z", 10), sale("2026-10-02T22:30:00Z", 20)], roster, now, TZ);
    const byDay = Object.fromEntries(r.all.points.map((p) => [p.day, p.netCopper / 10000]));
    assert.equal(byDay["2026-10-02"], 10);
    assert.equal(byDay["2026-10-03"], 20);
  });

  it("splits cross-realm/other like the report, unclassified only in all", () => {
    const r = dailySales(
      [
        sale("2026-10-04T10:00:00Z", 100), // roster -> cross
        sale("2026-10-04T11:00:00Z", 30, "Kazzak", "Main"), // not in roster -> other
        sale("2026-10-04T12:00:00Z", 7, "", ""), // no realm/character -> all only
      ],
      roster,
      now,
      TZ,
    );
    const day = (split: "cross" | "other" | "all") => r[split].points.find((p) => p.day === "2026-10-04")!;
    assert.deepEqual([day("cross").netCopper, day("cross").salesCount], [1000000, 1]);
    assert.deepEqual([day("other").netCopper, day("other").salesCount], [300000, 1]);
    assert.deepEqual([day("all").netCopper, day("all").salesCount], [1370000, 3]);
    // Same x-axis for every split
    assert.deepEqual(r.cross.points.map((p) => p.day), r.all.points.map((p) => p.day));
  });

  it("totals match the input and pick the best day", () => {
    const sales = [sale("2026-10-01T10:00:00Z", 40), sale("2026-10-02T10:00:00Z", 90), sale("2026-10-02T11:00:00Z", 15), sale("2026-10-04T10:00:00Z", 105)];
    const r = dailySales(sales, roster, now, TZ);
    assert.equal(r.all.totalCopper, 250 * 10000);
    assert.equal(r.all.salesCount, 4);
    assert.equal(r.all.best?.day, "2026-10-02"); // 105 on 2 Oct ties 105 on 4 Oct -> earliest
  });

  it("lists each day's items: units, sales, net, realms - most gold first", () => {
    const s = (at: string, gold: number, item: string, realm: string, quantity = 1): SaleRec => ({
      ...sale(at, gold, realm, "Alt"),
      itemName: item,
      quantity,
    });
    const r = dailySales(
      [
        s("2026-10-04T08:00:00Z", 100, "Vial", "Garona"),
        s("2026-10-04T09:00:00Z", 120, "Vial", "Aggramar"),
        s("2026-10-04T10:00:00Z", 30, "Lily", "Garona", 5),
        s("2026-10-04T11:00:00Z", 900, "Panther", "Garona"),
        s("2026-10-05T08:00:00Z", 1, "Lily", "Garona"), // another day
      ],
      new Set(["Garona|Alt", "Aggramar|Alt"]),
      now,
      TZ,
    );
    const day = r.all.points.find((p) => p.day === "2026-10-04")!;
    assert.deepEqual(
      day.items.map((i) => [i.name, i.units, i.sales, i.netCopper / 10000, i.realms]),
      [
        ["Panther", 1, 1, 900, ["Garona"]],
        ["Vial", 2, 2, 220, ["Aggramar", "Garona"]],
        ["Lily", 5, 1, 30, ["Garona"]],
      ],
    );
    // The list adds up to the day's bar.
    assert.equal(day.items.reduce((n, i) => n + i.netCopper, 0), day.netCopper);
    assert.deepEqual(r.all.points.find((p) => p.day === "2026-10-03")?.items ?? [], []);
  });

  it("no sales -> no days, no best", () => {
    const r = dailySales([], roster, now, TZ);
    assert.equal(r.all.points.length, 0);
    assert.equal(r.all.best, null);
  });
});
