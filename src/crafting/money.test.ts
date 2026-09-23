import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMoney } from "./money.js";
import { ValidationError } from "./validate.js";

describe("parseMoney", () => {
  it("parses gold, silver and copper suffixes, combined or alone", () => {
    assert.equal(parseMoney("2400g"), 24_000_000);
    assert.equal(parseMoney("20c"), 20);
    assert.equal(parseMoney("12g50s"), 125_000);
    assert.equal(parseMoney("5s"), 500);
  });

  it("rejects a bare number (no unit) and garbage", () => {
    assert.throws(() => parseMoney("2400"), ValidationError);
    assert.throws(() => parseMoney(""), ValidationError);
    assert.throws(() => parseMoney("2400x"), ValidationError);
    assert.throws(() => parseMoney("g"), ValidationError);
  });
});
