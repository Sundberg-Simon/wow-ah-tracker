/** Bad input from the user (CLI or caller) - as opposed to a bug or a DB fault. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function assertPositiveInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive whole number, got ${String(value)}`);
  }
}

export function assertNonNegativeInt(label: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a whole number >= 0, got ${String(value)}`);
  }
}

/** Strict YYYY-MM-DD that is also a real calendar date (rejects 2026-02-30). */
export function assertIsoDate(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${label} must be YYYY-MM-DD, got ${String(value)}`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    throw new ValidationError(`${label} is not a real calendar date: ${value}`);
  }
}

/** Trim; empty/whitespace/undefined all become null so "no patch" has one representation. */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Today's date in the local timezone as YYYY-MM-DD (the player's "today"). */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
