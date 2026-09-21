import type pg from "pg";

/**
 * Thins old auction snapshots into aggregate rows (CLAUDE.md #4/#14).
 *
 * Only for price_snapshots - the running market observation for patch-specific
 * items. Sale/purchase (earnings_*) data is never touched by anything here.
 *
 * Safety properties:
 *   - Whole buckets only. The cutoff is aligned DOWN to a bucket boundary, so a
 *     day/week is either entirely raw or entirely rolled up, never split.
 *   - Aggregates come from COMPLETE runs only (success AND NOT partial) - the
 *     same filter history.ts applies, so a partial run's rows never leak into
 *     an aggregate. Older rows from partial/failed runs are simply removed with
 *     the rest (nothing reads them).
 *   - Refuses (throws) if any bucket it would create already has a rollup row -
 *     that means raw rows reappeared under an already-rolled bucket, which
 *     needs a human, not a silent merge or a silent drop.
 *   - Integrity-checked before commit: the samples written must equal the
 *     complete raw rows aggregated, and the rows deleted must equal every raw
 *     row in the range. Any mismatch rolls the whole thing back.
 *   - The caller decides whether to commit: dryRun never writes.
 *
 * NOTE: history.ts (getItemHistory / getEuWideHistory) does not read the
 * rollup table yet. With the default 30-day keep window that's invisible - the
 * report's sparkline uses the latest ~200 raw points - but anything wanting
 * history OLDER than the keep window has to query price_snapshots_rollup itself.
 */

export interface RollupOptions {
  /** Raw rows newer than this many days are always kept. */
  keepDays: number;
  /** 1 = daily buckets, 7 = weekly (ISO week, Monday start, UTC). */
  bucketDays: 1 | 7;
  now: Date;
}

export interface RollupPlan {
  cutoff: Date;
  /** Complete-run raw rows that will be aggregated. */
  eligibleRows: number;
  /** Raw rows from partial/failed runs in range (deleted, not aggregated). */
  discardedRows: number;
  /** Rollup rows that will be created. */
  rollupRows: number;
}

export interface RollupResult extends RollupPlan {
  applied: boolean;
  deletedRows: number;
}

const bucketTrunc = (bucketDays: 1 | 7) => (bucketDays === 7 ? "week" : "day");

/** Cutoff aligned down to a bucket boundary in UTC, as an ISO timestamp from the DB itself. */
async function alignedCutoff(client: pg.PoolClient, opts: RollupOptions): Promise<Date> {
  const raw = new Date(opts.now.getTime() - opts.keepDays * 86400000);
  const { rows } = await client.query(
    `SELECT date_trunc('${bucketTrunc(opts.bucketDays)}', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS c`,
    [raw],
  );
  return rows[0].c as Date;
}

const COMPLETE_ROWS = `
  FROM price_snapshots ps
  JOIN sync_runs sr ON sr.id = ps.sync_run_id AND sr.success AND NOT sr.partial
  WHERE ps.captured_at < $1`;

/**
 * Plans (and, when apply is true, performs) the rollup on the caller's
 * connection. A dry run is read-only. When applying it runs in its own
 * transaction - or, if insideTransaction is true (tests wrapping it in a
 * transaction they roll back), in a savepoint of the caller's.
 */
export async function rollupSnapshots(
  client: pg.PoolClient,
  opts: RollupOptions,
  apply: boolean,
  insideTransaction = false,
): Promise<RollupResult> {
  const begin = insideTransaction ? "SAVEPOINT rollup" : "BEGIN";
  const commit = insideTransaction ? "RELEASE SAVEPOINT rollup" : "COMMIT";
  const rollback = insideTransaction ? "ROLLBACK TO SAVEPOINT rollup" : "ROLLBACK";
  const trunc = bucketTrunc(opts.bucketDays);
  const cutoff = await alignedCutoff(client, opts);

  const groupExpr = `date_trunc('${trunc}', ps.captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

  const eligible = await client.query(`SELECT count(*)::int AS n ${COMPLETE_ROWS}`, [cutoff]);
  const groups = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 ${COMPLETE_ROWS} GROUP BY ps.item_id, COALESCE(ps.ilvl, 0), COALESCE(ps.connected_realm_id, 0), ${groupExpr}
     ) g`,
    [cutoff],
  );
  const all = await client.query(`SELECT count(*)::int AS n FROM price_snapshots ps WHERE ps.captured_at < $1`, [cutoff]);

  const plan: RollupPlan = {
    cutoff,
    eligibleRows: eligible.rows[0].n,
    discardedRows: all.rows[0].n - eligible.rows[0].n,
    rollupRows: groups.rows[0].n,
  };

  if (!apply || all.rows[0].n === 0) {
    return { ...plan, applied: false, deletedRows: 0 };
  }

  await client.query(begin);
  try {
    // Guard: never roll up into a bucket that already has a rollup row.
    const conflicts = await client.query(
      `SELECT count(*)::int AS n FROM (
         SELECT ps.item_id, ps.ilvl, ps.connected_realm_id, ${groupExpr} AS bucket_start
         ${COMPLETE_ROWS}
         GROUP BY ps.item_id, ps.ilvl, ps.connected_realm_id, ${groupExpr}
       ) g
       JOIN price_snapshots_rollup r
         ON r.item_id = g.item_id
        AND COALESCE(r.ilvl, 0) = COALESCE(g.ilvl, 0)
        AND COALESCE(r.connected_realm_id, 0) = COALESCE(g.connected_realm_id, 0)
        AND r.bucket_start = g.bucket_start AND r.bucket_days = $2`,
      [cutoff, opts.bucketDays],
    );
    if (conflicts.rows[0].n > 0) {
      throw new Error(
        `${conflicts.rows[0].n} bucket(s) already have rollup rows but raw rows exist for them - refusing to merge or drop silently. Investigate first.`,
      );
    }

    const inserted = await client.query(
      `INSERT INTO price_snapshots_rollup
         (item_id, ilvl, connected_realm_id, bucket_start, bucket_days, min_price_copper_min, min_price_copper_avg,
          quantity_avg, quantity_max, listing_count_avg, samples)
       SELECT ps.item_id, ps.ilvl, ps.connected_realm_id, ${groupExpr}, $2,
              min(ps.min_price_copper), round(avg(ps.min_price_copper))::bigint,
              round(avg(ps.quantity))::bigint, max(ps.quantity), round(avg(ps.listing_count))::int, count(*)::int
       ${COMPLETE_ROWS}
       GROUP BY ps.item_id, ps.ilvl, ps.connected_realm_id, ${groupExpr}
       RETURNING samples`,
      [cutoff, opts.bucketDays],
    );

    // Judged on what THIS insert returned, not on the table's totals - earlier
    // applies leave older rollup rows behind that must not count here.
    const insertedSamples = inserted.rows.reduce((n: number, r: { samples: number }) => n + r.samples, 0);
    if (insertedSamples !== plan.eligibleRows || inserted.rows.length !== plan.rollupRows) {
      throw new Error(
        `Integrity check failed: this run wrote ${insertedSamples} samples / ${inserted.rows.length} rows, expected ${plan.eligibleRows} / ${plan.rollupRows}. Rolled back.`,
      );
    }

    const deleted = await client.query(`DELETE FROM price_snapshots WHERE captured_at < $1`, [cutoff]);
    if ((deleted.rowCount ?? 0) !== all.rows[0].n) {
      throw new Error(
        `Integrity check failed: deleted ${deleted.rowCount} raw rows, expected ${all.rows[0].n}. Rolled back.`,
      );
    }

    await client.query(commit);
    return { ...plan, applied: true, deletedRows: deleted.rowCount ?? 0 };
  } catch (err) {
    await client.query(rollback);
    throw err;
  }
}
