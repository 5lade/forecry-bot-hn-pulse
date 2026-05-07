export type AuthorKarmaBucket =
  | "unknown"
  | "newbie"
  | "low"
  | "mid"
  | "high";

export interface FeatureItemInput {
  posted_at: Date;
  url?: string | null;
  title?: string | null;
  by?: string | null;
  author_karma?: number | null;
}

export interface FeatureSnapshotInput {
  taken_at: Date;
  score: number | null;
  comments: number | null;
}

export interface FeatureRow {
  upvotes: number;
  comments: number;
  age_minutes: number;
  score_velocity: number;
  comment_velocity: number;
  posting_hour_utc: number;
  day_of_week: number;
  domain: string | null;
  domain_reputation: number;
  title_length: number;
  has_show_hn: boolean;
  has_ask_hn: boolean;
  author_karma_bucket: AuthorKarmaBucket;
}

export const DEFAULT_DOMAIN_REPUTATION = 0;

const DOMAIN_REPUTATION_CACHE = new Map<string, number>();

export function setDomainReputation(domain: string, reputation: number): void {
  DOMAIN_REPUTATION_CACHE.set(domain, reputation);
}

export function getDomainReputation(domain: string | null): number {
  if (!domain) return DEFAULT_DOMAIN_REPUTATION;
  return DOMAIN_REPUTATION_CACHE.get(domain) ?? DEFAULT_DOMAIN_REPUTATION;
}

export function clearDomainReputationCache(): void {
  DOMAIN_REPUTATION_CACHE.clear();
}

export function authorKarmaBucket(
  karma: number | null | undefined,
): AuthorKarmaBucket {
  if (karma == null || !Number.isFinite(karma)) return "unknown";
  if (karma < 100) return "newbie";
  if (karma < 1000) return "low";
  if (karma < 10000) return "mid";
  return "high";
}

function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const SHOW_HN_RE = /^\s*show\s+hn\b/i;
const ASK_HN_RE = /^\s*ask\s+hn\b/i;

function hasPrefix(title: string | null | undefined, re: RegExp): boolean {
  if (!title) return false;
  return re.test(title);
}

function ratePerMinute(
  current: number | null,
  previous: number | null,
  dtMinutes: number,
): number {
  if (dtMinutes <= 0) return 0;
  return ((current ?? 0) - (previous ?? 0)) / dtMinutes;
}

export function extractFeatures(
  item: FeatureItemInput,
  currentSnapshot: FeatureSnapshotInput,
  previousSnapshot?: FeatureSnapshotInput | null,
): FeatureRow {
  const upvotes = currentSnapshot.score ?? 0;
  const comments = currentSnapshot.comments ?? 0;

  const ageMs =
    currentSnapshot.taken_at.getTime() - item.posted_at.getTime();
  const age_minutes = Math.max(0, ageMs / 60_000);

  let score_velocity = 0;
  let comment_velocity = 0;
  if (previousSnapshot) {
    const dtMinutes = Math.max(
      0,
      (currentSnapshot.taken_at.getTime() -
        previousSnapshot.taken_at.getTime()) /
        60_000,
    );
    score_velocity = ratePerMinute(
      currentSnapshot.score,
      previousSnapshot.score,
      dtMinutes,
    );
    comment_velocity = ratePerMinute(
      currentSnapshot.comments,
      previousSnapshot.comments,
      dtMinutes,
    );
  }

  const domain = extractDomain(item.url);
  const title = item.title ?? "";

  return {
    upvotes,
    comments,
    age_minutes,
    score_velocity,
    comment_velocity,
    posting_hour_utc: item.posted_at.getUTCHours(),
    day_of_week: item.posted_at.getUTCDay(),
    domain,
    domain_reputation: getDomainReputation(domain),
    title_length: title.length,
    has_show_hn: hasPrefix(title, SHOW_HN_RE),
    has_ask_hn: hasPrefix(title, ASK_HN_RE),
    author_karma_bucket: authorKarmaBucket(item.author_karma),
  };
}
