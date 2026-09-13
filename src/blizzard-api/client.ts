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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a Game Data API path, retrying on 429/5xx/network errors (exponential
 * backoff, respecting Retry-After when present) and timing out a hung
 * request rather than letting it stall the whole sync run. Exposes
 * Last-Modified so callers can detect a stalled/unchanged Blizzard dump.
 */
export async function blizzardGetWithMeta<T>(
  path: string,
  { namespace, locale = "en_GB", params = {} }: GetOptions,
): Promise<{ data: T; lastModified: Date | null }> {
  const token = await getAccessToken();

  const url = new URL(`${API_HOST}${path}`);
  url.searchParams.set("namespace", `${namespace}-${env.region}`);
  url.searchParams.set("locale", locale);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // AbortError (timeout) and plain network failures - retryable, same
      // backoff as a 5xx.
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      const lastModifiedHeader = response.headers.get("last-modified");
      return {
        data: (await response.json()) as T,
        lastModified: lastModifiedHeader ? new Date(lastModifiedHeader) : null,
      };
    }

    const body = await response.text().catch(() => "");
    const httpError = new Error(
      `GET ${url.pathname} failed (${response.status}): ${body.slice(0, 200)}`,
    );
    // Not worth retrying a 4xx (bad auth, bad path, etc.) - fail fast.
    if (!RETRYABLE_STATUS.has(response.status)) throw httpError;

    lastError = httpError;
    if (attempt === MAX_ATTEMPTS) break;
    const retryAfterMs = Number(response.headers.get("retry-after") ?? 0) * 1000;
    await sleep(Math.max(retryAfterMs, 2000 * 2 ** (attempt - 1)));
  }

  throw lastError;
}

export async function blizzardGet<T>(path: string, options: GetOptions): Promise<T> {
  return (await blizzardGetWithMeta<T>(path, options)).data;
}
