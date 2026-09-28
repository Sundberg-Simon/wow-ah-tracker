import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fraction,
  scaleFraction,
  fractionToNumber,
  addFractions,
  subFractions,
  mulFractions,
  compareFractions,
  ZERO,
} from "./fraction.js";

test("fraction reduces to lowest terms", () => {
  assert.deepEqual(fraction(6, 8), { num: 3, den: 4 });
  assert.deepEqual(fraction(0, 5), { num: 0, den: 1 });
});

test("fraction rejects a non-safe-integer or a non-positive denominator", () => {
  assert.throws(() => fraction(Number.MAX_SAFE_INTEGER + 1, 1), RangeError);
  assert.throws(() => fraction(1, 0), RangeError);
  assert.throws(() => fraction(1, -1), RangeError);
});

test("addFractions/subFractions/mulFractions do ordinary exact arithmetic", () => {
  assert.deepEqual(addFractions(fraction(1, 3), fraction(1, 6)), fraction(1, 2));
  assert.deepEqual(subFractions(fraction(1, 2), fraction(1, 3)), fraction(1, 6));
  assert.deepEqual(mulFractions(fraction(2, 3), fraction(3, 4)), fraction(1, 2));
  assert.equal(fractionToNumber(addFractions(ZERO, fraction(5, 2))), 2.5);
});

test("compareFractions orders across different denominators", () => {
  assert.equal(compareFractions(fraction(1, 3), fraction(1, 2)), -1);
  assert.equal(compareFractions(fraction(1, 2), fraction(2, 4)), 0);
  assert.equal(compareFractions(fraction(2, 3), fraction(1, 2)), 1);
});

test("scaleFraction multiplies by an integer and reduces", () => {
  assert.deepEqual(scaleFraction(fraction(1, 6), 3), fraction(1, 2));
});

test("regression 2026-09-28: a large accumulated fraction whose unreduced cross-product overflows a safe integer must not throw, when the REDUCED result fits", () => {
  // Reproduces the real crash from `chain --ore 47135` (~9,427 executions):
  // repeatedly combining fractions with denominators that are themselves
  // large products (yields observed over thousands of batch executions)
  // used to compute a.den * b.den as a plain number BEFORE any reduction,
  // overflowing Number.MAX_SAFE_INTEGER even though the true reduced result
  // is ordinary. Uses fractions shaped like real yields (large, but sharing
  // common factors) rather than the exact production numbers (which are the
  // player's own empirical data, not committed here).
  let acc = ZERO;
  for (let i = 0; i < 40; i++) {
    // Each step's denominator is large (~10^9) but shares large common
    // factors with the accumulator, mirroring real yield fractions derived
    // from a shared, growing pool of observed batches.
    acc = addFractions(acc, fraction(3_000_000_00 + i, 9_427_000_000));
  }
  // Must not throw, and the result must be an ordinary safe-integer fraction.
  assert.ok(Number.isSafeInteger(acc.num));
  assert.ok(Number.isSafeInteger(acc.den));
  assert.ok(fractionToNumber(acc) > 0);
});

test("a truly irreducible overflow still throws a clear RangeError (the safety net is not just disabled)", () => {
  // Two large, coprime-ish denominators whose product cannot be reduced back
  // into a safe integer - this must still fail loudly, never silently wrap
  // or lose precision.
  const huge1 = fraction(1, 4_294_967_291); // large prime-ish denominator
  const huge2 = fraction(1, 4_294_967_279); // a different large prime-ish denominator
  assert.throws(() => addFractions(huge1, huge2), RangeError);
});

test("subFractions can go negative and back via compareFractions", () => {
  const result = subFractions(fraction(1, 3), fraction(1, 2));
  assert.deepEqual(result, fraction(-1, 6));
  assert.equal(compareFractions(result, ZERO), -1);
});
