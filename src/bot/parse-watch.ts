import type { WatchType } from "../db/watches.js";

export interface ParsedWatchTarget {
  watch_type: WatchType;
  watch_value: string;
}

export class WatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchParseError";
  }
}

const ITEM_ID_RE = /^[1-9]\d{0,11}$/;
const HN_USERNAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const DOMAIN_RE = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

/**
 * Parse a /watch argument into a (watch_type, watch_value) tuple.
 *
 *   "12345"            -> { watch_type: "item",      watch_value: "12345" }
 *   "@pg"              -> { watch_type: "submitter", watch_value: "pg" }
 *   "example.com"      -> { watch_type: "domain",    watch_value: "example.com" }
 *   "https://x.com/y"  -> { watch_type: "domain",    watch_value: "x.com" }
 */
export function parseWatchTarget(rawInput: string): ParsedWatchTarget {
  const input = rawInput.trim();
  if (!input) {
    throw new WatchParseError(
      "missing target. Usage: /watch <item-id|domain|@submitter>",
    );
  }

  if (input.startsWith("@")) {
    const username = input.slice(1);
    if (!HN_USERNAME_RE.test(username)) {
      throw new WatchParseError(
        `"${input}" is not a valid HN username (2-32 alphanum/_/-)`,
      );
    }
    return { watch_type: "submitter", watch_value: username };
  }

  if (ITEM_ID_RE.test(input)) {
    return { watch_type: "item", watch_value: input };
  }

  if (/^https?:\/\//i.test(input)) {
    let host: string;
    try {
      host = new URL(input).hostname.toLowerCase();
    } catch {
      throw new WatchParseError(`"${input}" is not a valid URL`);
    }
    if (host.startsWith("www.")) host = host.slice(4);
    if (!DOMAIN_RE.test(host)) {
      throw new WatchParseError(`"${host}" is not a valid domain`);
    }
    return { watch_type: "domain", watch_value: host };
  }

  let candidate = input.toLowerCase();
  if (candidate.startsWith("www.")) candidate = candidate.slice(4);
  if (DOMAIN_RE.test(candidate)) {
    return { watch_type: "domain", watch_value: candidate };
  }

  throw new WatchParseError(
    `could not parse "${input}". Expected an item id (e.g. 38765432), a domain (e.g. example.com), or a submitter (@username).`,
  );
}
