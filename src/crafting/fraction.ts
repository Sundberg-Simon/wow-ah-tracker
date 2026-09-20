/**
 * Exact rational number over safe integers.
 *
 * Yields are ratios of observed counts (e.g. 12 431 gems / 100 000 ore), and
 * the optimizer will multiply them with integer copper amounts later. Floats
 * would make "2 batches of the same data" and "1 merged batch" disagree in the
 * last digit; a reduced fraction makes them compare equal. Every operation
 * throws instead of silently leaving the safe-integer range.
 */
export interface Fraction {
  readonly num: number;
  readonly den: number;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function fraction(num: number, den: number): Fraction {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new RangeError(`Fraction needs safe integers, got ${num}/${den}`);
  }
  if (den <= 0) throw new RangeError(`Fraction denominator must be > 0, got ${den}`);
  const g = gcd(Math.abs(num), den); // gcd(0, den) = den, so 0/n reduces to 0/1
  return { num: num / g, den: den / g };
}

/** Multiply by an integer, e.g. yield-per-ore x ores in a cast. */
export function scaleFraction(f: Fraction, k: number): Fraction {
  if (!Number.isSafeInteger(k)) throw new RangeError(`Scale factor must be a safe integer, got ${k}`);
  const num = f.num * k;
  if (!Number.isSafeInteger(num)) {
    throw new RangeError(`Fraction overflow scaling ${f.num}/${f.den} by ${k}`);
  }
  return fraction(num, f.den);
}

/** For display only - never feed the result back into currency math. */
export function fractionToNumber(f: Fraction): number {
  return f.num / f.den;
}
