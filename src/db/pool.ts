import pg from "pg";
import { env } from "../../config/env.js";

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: env.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
});
