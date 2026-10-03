import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractGold } from "./savedVariables.js";

const sample = (ts: number, copper: number) => ({ ts, copper });
const db = (dataVersion: number | undefined) => ({
  WowAHTrackerGoldDB: {
    ...(dataVersion === undefined ? {} : { dataVersion }),
    characters: { "R|A": { realm: "R", character: "A", log: [sample(1000, 5000000), sample(2000, 0), sample(3000, 5000000)] } },
    warband: { log: [{ ts: 1000, copper: 0, ctx: "bank" }] },
  },
});

describe("extractGold", () => {
  it("drops 0g character readings from the old addon version (false logout reads)", () => {
    const { observations, warnings } = extractGold(db(undefined) as never);
    const chars = observations.filter((o) => o.kind === "character");
    assert.deepEqual(chars.map((o) => o.copper), [5000000, 5000000]);
    assert.equal(warnings.length, 1);
    // the Warband bank is unaffected (its zero rule lives in the report)
    assert.equal(observations.filter((o) => o.kind === "warband").length, 1);
  });

  it("keeps every reading, zeros included, from the fixed version", () => {
    const { observations, warnings } = extractGold(db(2) as never);
    assert.deepEqual(observations.filter((o) => o.kind === "character").map((o) => o.copper), [5000000, 0, 5000000]);
    assert.equal(warnings.length, 0);
  });
});
