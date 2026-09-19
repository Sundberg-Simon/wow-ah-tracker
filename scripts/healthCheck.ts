/**
 * GitHub only notifies on *failed* runs, which misses every failure mode
 * that looks like silence instead of an error: dropped cron ticks, an
 * exhausted Actions quota, or a stalled Blizzard dump. This translates
 * absence into a failure by asking the DB whether recent sync activity
 * looks healthy, and exiting non-zero (with a GitHub ::error:: annotation)
 * if not - so the normal failed-run email actually fires.
 */
import { pool } from "../src/db/pool.js";
import { getSnapshotTrackedItems } from "../config/trackedItems.js";

const WINDOW_HOURS = 24;
const MIN_SUCCESSFUL_RUNS = 18; // 24 expected at ~hourly; tolerate a few dropped ticks
const MAX_GAP_MINUTES = 180;
const MAX_STALE_SOURCE_RUNS = 3; // same Blizzard Last-Modified N runs in a row

// Must mirror runFullSync.ts's own MAX_FAILED_REALM_FRACTION (0.1): a run
// under that ceiling is marked partial but is, by the sync job's own
// design, NOT a failure - a single flaky realm out of ~90 is expected and
// tolerated on purpose. Alarming on every partial run here would defeat
// that tolerance and just generate noise on ordinary Blizzard-side hiccups
// (see docs/sync-pipeline-review-2026-09-14.md, findings 1+2). Instead,
// only alarm when a run's failure rate is closing in on the real ceiling,
// or when partial runs are happening on most recent runs (systemic)
// rather than the occasional one-off.
const MAX_FAILED_REALM_FRACTION = 0.1;
const NEAR_CEILING_FRACTION = 0.8; // alarm once a run reaches 80% of the ceiling
const SYSTEMIC_PARTIAL_RATE = 0.5; // alarm if over half of successful runs are partial

// With no active patch-specific items the snapshot sync is idle BY DESIGN
// (CLAUDE.md #14): no sync_runs rows, no price rows, so the cadence rules
// below (>=18 runs/24h, max gap, stale Blizzard dump) would alarm forever.
// The idle job's one remaining duty is refreshing realm metadata about daily
// (runFullSync.ts, METADATA_MAX_AGE_MS = 20h) - so silence is still detected,
// just against that: alarm if it hasn't happened for MAX_METADATA_AGE_HOURS.
const MAX_METADATA_AGE_HOURS = 48;

async function checkIdleMode(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT extract(epoch FROM now() - max(last_synced_at)) / 3600 AS age_hours FROM connected_realms`,
  );
  const age = rows[0]?.age_hours === null || rows[0]?.age_hours === undefined ? null : Number(rows[0].age_hours);
  console.log(
    JSON.stringify({ mode: "idle (no active patch-specific items)", realm_metadata_age_hours: age === null ? null : Math.round(age * 10) / 10 }, null, 2),
  );
  if (age === null || age > MAX_METADATA_AGE_HOURS) {
    console.log(
      `::error::Sync health (idle mode): realm metadata not refreshed for ${age === null ? "ever" : Math.round(age) + "h"} (limit ${MAX_METADATA_AGE_HOURS}h) - the idle job's daily refresh isn't running.`,
    );
    process.exitCode = 1;
  } else {
    console.log("Sync health OK (idle mode: snapshot sync intentionally off, realm metadata is fresh).");
  }
}

async function main() {
  if (getSnapshotTrackedItems().length === 0) {
    await checkIdleMode();
    return;
  }

  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT * FROM sync_runs
      WHERE started_at > now() - interval '${WINDOW_HOURS} hours'
      ORDER BY started_at
    ),
    gaps AS (
      SELECT started_at - lag(started_at) OVER (ORDER BY started_at) AS gap
      FROM recent WHERE success
    )
    SELECT
      (SELECT count(*) FROM recent WHERE success)                          AS successful,
      (SELECT count(*) FROM recent WHERE NOT success)                      AS failed,
      (SELECT count(*) FROM recent WHERE partial)                          AS partial,
      (SELECT coalesce(max(
         CASE WHEN realms_expected > 0
              THEN (realms_expected - realms_ok)::float / realms_expected
              ELSE 0 END
       ), 0) FROM recent WHERE success)                                    AS max_failure_fraction,
      (SELECT coalesce(max(extract(epoch FROM gap)/60), 0) FROM gaps)      AS max_gap_min,
      (SELECT extract(epoch FROM now() - max(started_at))/60
         FROM recent WHERE success)                                        AS since_last_min,
      (SELECT count(*) FROM (
         SELECT source_modified_at FROM recent WHERE success
         ORDER BY started_at DESC LIMIT ${MAX_STALE_SOURCE_RUNS}
       ) t WHERE source_modified_at IS NOT NULL
       GROUP BY source_modified_at HAVING count(*) = ${MAX_STALE_SOURCE_RUNS}) AS stale_source
  `);

  const s = rows[0];
  const problems: string[] = [];

  if (Number(s.successful) < MIN_SUCCESSFUL_RUNS) {
    problems.push(`only ${s.successful} successful runs in ${WINDOW_HOURS}h (expected ~24)`);
  }
  if (Number(s.max_gap_min) > MAX_GAP_MINUTES) {
    problems.push(`max gap between successful runs ${Math.round(s.max_gap_min)}min`);
  }
  if (s.since_last_min === null || Number(s.since_last_min) > MAX_GAP_MINUTES) {
    problems.push(`last successful run ${Math.round(s.since_last_min ?? 9999)}min ago`);
  }
  const successful = Number(s.successful);
  const partial = Number(s.partial);
  const maxFailureFraction = Number(s.max_failure_fraction);
  const nearCeiling = MAX_FAILED_REALM_FRACTION * NEAR_CEILING_FRACTION;

  if (maxFailureFraction >= nearCeiling) {
    problems.push(
      `a run's failed-realm fraction (${(maxFailureFraction * 100).toFixed(1)}%) is close to the ` +
        `${(MAX_FAILED_REALM_FRACTION * 100).toFixed(0)}% tolerance ceiling - check failed_realm_ids`,
    );
  }
  if (successful > 0 && partial / successful > SYSTEMIC_PARTIAL_RATE) {
    problems.push(
      `${partial}/${successful} successful runs in ${WINDOW_HOURS}h were partial - looks systemic, not occasional`,
    );
  }
  if (Number(s.stale_source) > 0) {
    problems.push(`Blizzard dump unchanged for the last ${MAX_STALE_SOURCE_RUNS} runs`);
  }

  console.log(JSON.stringify(s, null, 2));
  if (problems.length > 0) {
    console.log(`::error::Sync health: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("Sync health OK.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
