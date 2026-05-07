import {
  listDigestEligibleUsers,
  listYesterdayTrackedItems,
  tryClaimDigestRun,
  type DigestEligibleUser,
  type DigestQueryClient,
  type DigestTrackedItem,
} from "../db/digest.js";

export const FRONT_PAGE_RANK_THRESHOLD = 30;
export const DIGEST_HOUR_UTC = 9;

export interface DigestTelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
}

export interface DailyDigestDeps {
  client: DigestQueryClient;
  telegram: DigestTelegramSender;
  publicUrl: string;
  /** Lets tests pin the run time. Defaults to `() => new Date()`. */
  clock?: () => Date;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export interface DailyDigestResult {
  digestDate: string;
  eligibleUsers: number;
  sent: number;
  skippedEmpty: number;
  skippedAlreadySent: number;
  failed: number;
}

interface YesterdayWindow {
  fromUtc: Date;
  toUtc: Date;
  digestDate: string;
}

/**
 * Computes the [start, end) UTC window covering "yesterday" relative to `now`,
 * plus the ISO date string used as the digest_runs key.
 */
export function yesterdayUtcWindow(now: Date): YesterdayWindow {
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60_000);
  return {
    fromUtc: yesterdayStart,
    toUtc: todayStart,
    digestDate: yesterdayStart.toISOString().slice(0, 10),
  };
}

interface DigestStats {
  total: number;
  hits: number;
  misses: number;
  pendingPredictions: number;
}

function classifyItems(items: ReadonlyArray<DigestTrackedItem>): DigestStats {
  let hits = 0;
  let misses = 0;
  let pending = 0;
  for (const it of items) {
    if (it.predicted_p == null) pending += 1;
    if (it.final_rank != null && it.final_rank <= FRONT_PAGE_RANK_THRESHOLD) {
      hits += 1;
    } else {
      misses += 1;
    }
  }
  return {
    total: items.length,
    hits,
    misses,
    pendingPredictions: pending,
  };
}

function fmtPct(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "n/a";
  return `${Math.round(p * 100)}%`;
}

function fmtRank(rank: number | null | undefined): string {
  if (rank == null) return "—";
  return `#${rank}`;
}

function fmtItem(it: DigestTrackedItem): string {
  const title = it.title ?? `item ${it.item_id}`;
  const onFp =
    it.final_rank != null && it.final_rank <= FRONT_PAGE_RANK_THRESHOLD
      ? "✅"
      : "❌";
  return `${onFp} ${title} — predicted ${fmtPct(it.predicted_p)}, final ${fmtRank(it.final_rank)} (p=${fmtPct(it.final_p)}) — https://news.ycombinator.com/item?id=${it.item_id}`;
}

export function buildDigestMessage(args: {
  user: DigestEligibleUser;
  digestDate: string;
  items: ReadonlyArray<DigestTrackedItem>;
  publicUrl: string;
}): string {
  const { user, digestDate, items, publicUrl } = args;
  const stats = classifyItems(items);
  const calibrationLink = `${publicUrl.replace(/\/$/, "")}/calibration/${user.id}`;

  const header = `HN Pulse digest — ${digestDate}`;
  const summary = `Tracked ${stats.total} item${stats.total === 1 ? "" : "s"}: ${stats.hits} hit${stats.hits === 1 ? "" : "s"}, ${stats.misses} miss${stats.misses === 1 ? "" : "es"}.`;
  const body = items.map(fmtItem).join("\n");
  const footer = `Calibration over the last 30 days: ${calibrationLink}`;

  return [header, summary, "", body, "", footer].join("\n");
}

async function processUser(
  user: DigestEligibleUser,
  window: YesterdayWindow,
  deps: DailyDigestDeps,
): Promise<"sent" | "empty" | "already-sent" | "failed"> {
  const items = await listYesterdayTrackedItems(deps.client, {
    userId: user.id,
    fromUtc: window.fromUtc,
    toUtc: window.toUtc,
  });
  if (items.length === 0) return "empty";

  const claimed = await tryClaimDigestRun(deps.client, {
    userId: user.id,
    digestDate: window.digestDate,
  });
  if (!claimed) return "already-sent";

  const message = buildDigestMessage({
    user,
    digestDate: window.digestDate,
    items,
    publicUrl: deps.publicUrl,
  });

  try {
    await deps.telegram.sendMessage(user.telegram_user_id, message);
    return "sent";
  } catch (err) {
    if (deps.onError) deps.onError(err, "digest-send");
    return "failed";
  }
}

export async function runDailyDigest(
  deps: DailyDigestDeps,
): Promise<DailyDigestResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const log = deps.log ?? (() => {});
  const window = yesterdayUtcWindow(now);

  const users = await listDigestEligibleUsers(deps.client);

  const result: DailyDigestResult = {
    digestDate: window.digestDate,
    eligibleUsers: users.length,
    sent: 0,
    skippedEmpty: 0,
    skippedAlreadySent: 0,
    failed: 0,
  };

  for (const user of users) {
    try {
      const outcome = await processUser(user, window, deps);
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "empty") result.skippedEmpty += 1;
      else if (outcome === "already-sent") result.skippedAlreadySent += 1;
      else result.failed += 1;
    } catch (err) {
      result.failed += 1;
      if (deps.onError) deps.onError(err, "digest-user");
    }
  }

  log(
    `[digest] date=${result.digestDate} eligible=${result.eligibleUsers} ` +
      `sent=${result.sent} empty=${result.skippedEmpty} ` +
      `already=${result.skippedAlreadySent} failed=${result.failed}`,
  );
  return result;
}
