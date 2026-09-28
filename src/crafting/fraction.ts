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

function gcdBig(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
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

/**
 * Reduces a numerator/denominator pair that may be far too big to fit a safe
 * integer BEFORE reduction (e.g. the unreduced cross-product of two
 * fractions' denominators), using BigInt so that intermediate overflow never
 * happens. Only the final, reduced value has to fit a safe integer - and for
 * real yield ratios (which share large common factors) it almost always
 * does, even when the unreduced product wildly overflows. Bug found
 * 2026-09-28: `addFractions`/`subFractions`/etc. used to reduce via
 * `fraction()` AFTER computing unreduced cross-products with plain `number`
 * multiplication, so a long chain of combined fractions at a large scale
 * (`chain --ore <a lot>`) could throw on an intermediate value that would
 * have reduced down to something perfectly ordinary.
 */
function reduceBig(numBig: bigint, denBig: bigint): Fraction {
  if (denBig <= 0n) throw new RangeError(`Fraction denominator must be > 0, got ${denBig}`);
  const g = gcdBig(numBig < 0n ? -numBig : numBig, denBig) || 1n; // gcd(0, den) = den
  const num = numBig / g;
  const den = denBig / g;
  if (num > BigInt(Number.MAX_SAFE_INTEGER) || num < -BigInt(Number.MAX_SAFE_INTEGER) || den > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`Fraction overflow: ${numBig}/${denBig} reduces to ${num}/${den}, which still doesn't fit a safe integer`);
  }
  return { num: Number(num), den: Number(den) };
}

/** Multiply by an integer, e.g. yield-per-ore x ores in a cast. */
export function scaleFraction(f: Fraction, k: number): Fraction {
  if (!Number.isSafeInteger(k)) throw new RangeError(`Scale factor must be a safe integer, got ${k}`);
  return reduceBig(BigInt(f.num) * BigInt(k), BigInt(f.den));
}

/** For display only - never feed the result back into currency math. */
export function fractionToNumber(f: Fraction): number {
  return f.num / f.den;
}

export const ZERO: Fraction = { num: 0, den: 1 };

export function addFractions(a: Fraction, b: Fraction): Fraction {
  const an = BigInt(a.num), ad = BigInt(a.den), bn = BigInt(b.num), bd = BigInt(b.den);
  return reduceBig(an * bd + bn * ad, ad * bd);
}

/** a - b; the result may be negative. */
export function subFractions(a: Fraction, b: Fraction): Fraction {
  const an = BigInt(a.num), ad = BigInt(a.den), bn = BigInt(b.num), bd = BigInt(b.den);
  return reduceBig(an * bd - bn * ad, ad * bd);
}

export function mulFractions(a: Fraction, b: Fraction): Fraction {
  return reduceBig(BigInt(a.num) * BigInt(b.num), BigInt(a.den) * BigInt(b.den));
}

/** Negative, zero or positive as a is less than, equal to or greater than b. */
export function compareFractions(a: Fraction, b: Fraction): number {
  const lhs = BigInt(a.num) * BigInt(b.den);
  const rhs = BigInt(b.num) * BigInt(a.den);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
