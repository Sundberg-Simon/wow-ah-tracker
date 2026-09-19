import type pg from "pg";

/**
 * Appends a realm_population_history row for every connected realm whose
 * population tier in connected_realms differs from its most recent history
 * row (or that has no history row yet). Set-based, one statement - meant to
 * run inside runFullSync's commit transaction right after the
 * connected_realms upsert, so the history can never disagree with what that
 * same run committed. Unchanged realms insert nothing, so steady state is a
 * no-op; a realm whose tier is NULL with no history yet does get a NULL row
 * (its "unknown" starting point), and only changes again if it later resolves.
 *
 * Returns how many rows were appended.
 */
export async function recordPopulationChanges(
  client: pg.PoolClient | pg.Pool,
  observedAt: Date,
): Promise<number> {
  const result = await client.query(
    `INSERT INTO realm_population_history (connected_realm_id, population, observed_at)
     SELECT cr.connected_realm_id, cr.population, $1
     FROM connected_realms cr
     LEFT JOIN LATERAL (
       SELECT h.population, true AS has_row
       FROM realm_population_history h
       WHERE h.connected_realm_id = cr.connected_realm_id
       ORDER BY h.observed_at DESC, h.id DESC
       LIMIT 1
     ) latest ON true
     WHERE latest.has_row IS NULL
        OR latest.population IS DISTINCT FROM cr.population`,
    [observedAt],
  );
  return result.rowCount ?? 0;
}
