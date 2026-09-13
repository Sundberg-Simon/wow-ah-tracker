import { env } from "../../config/env.js";
import { getAccessToken } from "./auth.js";

const API_HOST = `https://${env.region}.api.blizzard.com`;

export type Namespace = "dynamic" | "static" | "profile";

interface GetOptions {
  namespace: Namespace;
  locale?: string;
  /** Extra query params beyond namespace/locale. */
  params?: Record<string, string>;
}

/**
 * GET a Game Data API path and parse it as JSON. Retries once on 429 after
 * respecting Retry-After, since a scheduled hourly job has no reason to fail
 * a whole run over a single transient rate-limit hiccup.
 */
export async function blizzardGet<T>(
  path: string,
  { namespace, locale = "en_GB", params = {} }: GetOptions,
): Promise<T> {
  const token = await getAccessToken();

  const url = new URL(`${API_HOST}${path}`);
  url.searchParams.set("namespace", `${namespace}-${env.region}`);
  url.searchParams.set("locale", locale);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const doFetch = () =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  let response = await doFetch();

  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "5");
    await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
    response = await doFetch();
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET ${url} failed (${response.status}): ${body}`);
  }

  return response.json() as Promise<T>;
}
