import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const env = {
  blizzardClientId: required("BLIZZARD_CLIENT_ID"),
  blizzardClientSecret: required("BLIZZARD_CLIENT_SECRET"),
  region: process.env.BLIZZARD_REGION ?? "eu",
  databaseUrl: process.env.DATABASE_URL,
};
