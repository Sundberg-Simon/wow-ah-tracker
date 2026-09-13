import pg from "pg";
import { env } from "../../config/env.js";

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  // Neon uses publicly-trusted certificates, so full verification works
  // (rejectUnauthorized: false would encrypt the connection without
  // actually authenticating the server).
  ssl: env.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: true } : undefined,
});
