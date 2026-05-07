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

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface BackoffOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxMs?: number;
  jitter?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
}

const defaultIsRetryable = (err: unknown): boolean =>
  err instanceof HttpError && err.status >= 500 && err.status < 600;

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 8000;
  const jitter = opts.jitter ?? Math.random;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const expo = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jittered = expo * (0.5 + jitter() * 0.5);
      await sleep(jittered);
    }
  }
}

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

export async function fetchNewStoryIds(
  opts: HnClientOptions = {},
): Promise<number[]> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = opts.baseUrl ?? HN_BASE_URL;
  return withBackoff(async () => {
    const res = await fetchImpl(`${baseUrl}/newstories.json`);
    if (!res.ok) {
      throw new HttpError(res.status, `newstories.json HTTP ${res.status}`);
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error("newstories.json: expected array");
    }
    return body.filter((x): x is number => typeof x === "number");
  }, opts.backoff);
}

export async function fetchItem(
  id: number,
  opts: HnClientOptions = {},
): Promise<HnItem | null> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = opts.baseUrl ?? HN_BASE_URL;
  return withBackoff(async () => {
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
