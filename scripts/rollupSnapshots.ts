/**
 * Thins old auction snapshots into daily/weekly aggregate rows to bound
 * storage (CLAUDE.md #4/#14). A MANUAL tool - not wired into CI or any
 * schedule.
 *
 *   npm run rollup                              # DRY RUN: shows what would happen
 *   npm run rollup -- --apply                   # actually roll up + delete
 *   npm run rollup -- --keep-days 14 --bucket-days 7 [--apply]
 *
 * Defaults: keep the last 30 days as raw rows, roll everything older into
 * daily buckets. Dry run is the default on purpose - --apply DELETES raw
 * price_snapshots rows (after writing their aggregates, in one transaction with
 * integrity checks). It never touches sale/purchase (earnings_*) data.
 *
 * history.ts does not read the rollup table yet; see the note in
 * src/sync/rollupSnapshots.ts.
 */
import { pool } from "../src/db/pool.js";
import { rollupSnapshots } from "../src/sync/rollupSnapshots.js";

function intArg(argv: string[], name: string, fallback: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} needs a positive integer`);
  }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const keepDays = intArg(argv, "--keep-days", 30);
  const bucketDays = intArg(argv, "--bucket-days", 1);
  if (bucketDays !== 1 && bucketDays !== 7) {
    throw new Error("--bucket-days must be 1 (daily) or 7 (weekly)");
  }

  const client = await pool.connect();
  try {
    const result = await rollupSnapshots(client, { keepDays, bucketDays, now: new Date() }, apply);
    console.log(
      `Cutoff (aligned to a ${bucketDays === 7 ? "week" : "day"} boundary, UTC): ${result.cutoff.toISOString()} - rows older than this are in scope, keep-days=${keepDays}`,
    );
    console.log(
      `In scope: ${result.eligibleRows} complete-run row(s) -> ${result.rollupRows} rollup row(s); ` +
        `${result.discardedRows} row(s) from partial/failed runs (removed, not aggregated).`,
    );
    if (result.eligibleRows + result.discardedRows === 0) {
      console.log("Nothing to do.");
    } else if (result.applied) {
      console.log(`APPLIED: wrote ${result.rollupRows} rollup row(s), deleted ${result.deletedRows} raw row(s).`);
    } else {
      console.log("DRY RUN - nothing changed. Re-run with --apply to perform this.");
    }
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error("Rollup failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
