import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Validation is lazy (getters) rather than eager: a DB-only script like
// migrate.ts imports this module via pool.ts but never touches the Blizzard
// fields, and shouldn't need Blizzard credentials set just to run.
export const env = {
  get blizzardClientId() {
    return required("BLIZZARD_CLIENT_ID");
  },
  get blizzardClientSecret() {
    return required("BLIZZARD_CLIENT_SECRET");
  },
  region: process.env.BLIZZARD_REGION ?? "eu",
  databaseUrl: process.env.DATABASE_URL,
};
