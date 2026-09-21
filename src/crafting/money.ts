import type { Fraction } from "./fraction.js";

/*
 * Currency is always whole copper (a safe integer), never a float. The only
 * place a fraction meets money is "expected units x price", and that product
 * can pass 2^53 in a big-sample calculation, so it is done in BigInt and
 * rounded ONCE, to the nearest copper (halves up).
 */

/** round(f x copper) to whole copper. f >= 0 and copper >= 0. */
export function mulRound(f: Fraction, copper: number): number {
  if (!Number.isSafeInteger(copper) || copper < 0) throw new RangeError(`copper must be a whole number >= 0, got ${copper}`);
  if (f.num < 0) throw new RangeError(`fraction must be >= 0, got ${f.num}/${f.den}`);
  const num = BigInt(f.num) * BigInt(copper);
  const den = BigInt(f.den);
  const rounded = (2n * num + den) / (2n * den);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("copper amount exceeds the safe integer range");
  return Number(rounded);
}

/** Sum of whole-copper amounts, checked against the safe integer range. */
export function sumCopper(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) {
    total += a;
    if (!Number.isSafeInteger(total)) throw new RangeError("copper total exceeds the safe integer range");
  }
  return total;
}

/**
 * Whole copper -> "12.34g", rounded to the nearest silver (display only; the
 * value itself stays an integer). Rounded rather than cut off, so 10.7696g
 * reads 10.77g; a value that rounds to nothing has no sign ("0.00g", not "-0.00g").
 */
export function formatGold(copper: number): string {
  const totalSilver = Math.round(Math.abs(copper) / 100);
  const gold = Math.floor(totalSilver / 100);
  const silver = totalSilver % 100;
  const sign = copper < 0 && totalSilver > 0 ? "-" : "";
  return `${sign}${gold.toLocaleString("en-US")}.${String(silver).padStart(2, "0")}g`;
}
