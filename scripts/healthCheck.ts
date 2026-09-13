/**
 * GitHub only notifies on *failed* runs, which misses every failure mode
 * that looks like silence instead of an error: dropped cron ticks, an
 * exhausted Actions quota, or a stalled Blizzard dump. This translates
 * absence into a failure by asking the DB whether recent sync activity
 * looks healthy, and exiting non-zero (with a GitHub ::error:: annotation)
 * if not - so the normal failed-run email actually fires.
 */
import { pool } from "../src/db/pool.js";

const WINDOW_HOURS = 24;
const MIN_SUCCESSFUL_RUNS = 18; // 24 expected at ~hourly; tolerate a few dropped ticks
const MAX_GAP_MINUTES = 180;
const MAX_STALE_SOURCE_RUNS = 3; // same Blizzard Last-Modified N runs in a row

async function main() {
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
  if (Number(s.partial) > 0) {
    problems.push(`${s.partial} partial run(s) - check failed_realm_ids`);
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
