import { pool } from "../db/pool.js";

export interface ConnectedRealmInfo {
  connectedRealmId: number;
  realmNames: string[];
}

/**
 * All known EU connected-realm groups and their member realm names,
 * regardless of whether any tracked item currently has active listings
 * there. The per-item `realms` breakdown in the data export only lists
 * realms with current listings for that specific item, which isn't enough
 * for the WoW addon to reliably map GetRealmName() to a connected-realm id -
 * this is the complete list for that purpose.
 */
export async function getAllConnectedRealms(): Promise<ConnectedRealmInfo[]> {
  const { rows } = await pool.query(
    `SELECT connected_realm_id, realm_names FROM connected_realms ORDER BY connected_realm_id`,
  );
  return rows.map((r) => ({
    connectedRealmId: r.connected_realm_id,
    realmNames: r.realm_names,
  }));
}
