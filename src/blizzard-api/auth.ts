import { env } from "../../config/env.js";

// Single global OAuth host - Blizzard issues tokens here for every region
// (US/EU/KR/TW), and the resulting access_token is valid across all of them.
// Region-specific hosts (eu.battle.net/oauth/token etc.) still exist but are
// not required; this is the endpoint shown in Blizzard's own current docs.
const TOKEN_URL = "https://oauth.battle.net/token";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.value;
  }

  const basicAuth = Buffer.from(
    `${env.blizzardClientId}:${env.blizzardClientSecret}`,
  ).toString("base64");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to obtain Blizzard OAuth token (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as TokenResponse;

  // Refresh a little early (60s) to avoid edge-of-expiry failures mid-run.
  cachedToken = {
    value: data.access_token,
    expiresAt: now + (data.expires_in - 60) * 1000,
  };

  return cachedToken.value;
}
