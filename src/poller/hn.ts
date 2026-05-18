import { HttpError, retry, type RetryOptions } from "../util/retry.js";

export const HN_BASE_URL = "https://hacker-news.firebaseio.com/v0";

export interface HnItem {
  id: number;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  type?: string;
  score?: number;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

// Re-export centralized retry primitives so existing callers/tests of hn.ts
// keep working. New code should import directly from "../util/retry.js".
export { HttpError };
export type BackoffOptions = RetryOptions;
export const withBackoff = retry;

export interface HnClientOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  backoff?: BackoffOptions;
}

const defaultFetch: FetchLike = async (url) => {
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
  };
};

async function fetchStoryIdsEndpoint(
  endpoint: "newstories" | "topstories",
  opts: HnClientOptions = {},
): Promise<number[]> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = opts.baseUrl ?? HN_BASE_URL;
  return retry(async () => {
    const path = `${endpoint}.json`;
    const res = await fetchImpl(`${baseUrl}/${path}`);
    if (!res.ok) {
      throw new HttpError(res.status, `${path} HTTP ${res.status}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error(`${path}: expected array`);
    }
    return body.filter((x): x is number => typeof x === "number");
  }, opts.backoff);
}

export async function fetchNewStoryIds(
  opts: HnClientOptions = {},
): Promise<number[]> {
  return fetchStoryIdsEndpoint("newstories", opts);
}

export async function fetchTopStoryIds(
  opts: HnClientOptions = {},
): Promise<number[]> {
  return fetchStoryIdsEndpoint("topstories", opts);
}

export async function fetchItem(
  id: number,
  opts: HnClientOptions = {},
): Promise<HnItem | null> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = opts.baseUrl ?? HN_BASE_URL;
  return retry(async () => {
    const res = await fetchImpl(`${baseUrl}/item/${id}.json`);
    if (!res.ok) {
      throw new HttpError(res.status, `item/${id}.json HTTP ${res.status}`);
    }
    const body = (await res.json()) as HnItem | null;
    return body;
  }, opts.backoff);
}

export function diffNewIds(
  seen: ReadonlySet<number>,
  fresh: ReadonlyArray<number>,
): number[] {
  const out: number[] = [];
  for (const id of fresh) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
