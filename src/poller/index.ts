import {
  listItemsYoungerThan,
  upsertItem,
  type ItemsQueryClient,
} from "../db/items.js";
import { scoreAndInsertSnapshot } from "../scorer/index.js";
import {
  diffNewIds,
  extractDomain,
  fetchItem,
  fetchNewStoryIds,
  type FetchLike,
  type HnClientOptions,
  type HnItem,
} from "./hn.js";

export const NEWSTORIES_INTERVAL_MS = 30_000;
export const RESCAN_INTERVAL_MS = 60_000;
export const RESCAN_WINDOW_HOURS = 6;

let _lastBatchAt: Date | null = null;

export function getLastBatchAt(): Date | null {
  return _lastBatchAt;
}

export function _resetLastBatchAtForTest(): void {
  _lastBatchAt = null;
}

function setLastBatch(now: Date): void {
  _lastBatchAt = now;
}

function isLiveStory(item: HnItem | null): boolean {
  if (!item) return false;
  if (item.dead || item.deleted) return false;
  if (item.type && item.type !== "story") return false;
  return true;
}

function postedAtOf(item: HnItem, fallback: Date): Date {
  if (typeof item.time === "number" && Number.isFinite(item.time)) {
    return new Date(item.time * 1000);
  }
  return fallback;
}

export interface PollerStepDeps {
  client: ItemsQueryClient;
  hn?: HnClientOptions;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface NewStoriesStepDeps extends PollerStepDeps {
  seen: Set<number>;
  maxNewPerTick?: number;
}

export interface NewStoriesStepResult {
  newIds: number[];
  inserted: number;
  skipped: number;
}

export async function pollNewStoriesStep(
  deps: NewStoriesStepDeps,
): Promise<NewStoriesStepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});
  const maxNew = deps.maxNewPerTick ?? 100;

  const fresh = await fetchNewStoryIds(deps.hn);
  const newIds = diffNewIds(deps.seen, fresh).slice(0, maxNew);

  let inserted = 0;
  let skipped = 0;
  for (const id of newIds) {
    const item = await fetchItem(id, deps.hn);
    deps.seen.add(id);
    if (!isLiveStory(item)) {
      skipped += 1;
      continue;
    }
    const itemNonNull = item as HnItem;
    await upsertItem(deps.client, {
      id: itemNonNull.id,
      by: itemNonNull.by ?? null,
      title: itemNonNull.title ?? null,
      url: itemNonNull.url ?? null,
      domain: extractDomain(itemNonNull.url),
      posted_at: postedAtOf(itemNonNull, now),
      first_seen_at: now,
    });
    await scoreAndInsertSnapshot(deps.client, {
      item_id: itemNonNull.id,
      posted_at: postedAtOf(itemNonNull, now),
      url: itemNonNull.url ?? null,
      title: itemNonNull.title ?? null,
      by: itemNonNull.by ?? null,
      taken_at: now,
      rank: null,
      score: itemNonNull.score ?? null,
      comments: itemNonNull.descendants ?? null,
    });
    inserted += 1;
  }

  setLastBatch(now);
  log(`[poller] newstories: fresh=${fresh.length} new=${newIds.length} inserted=${inserted} skipped=${skipped}`);
  return { newIds, inserted, skipped };
}

export interface RescanStepDeps extends PollerStepDeps {
  windowHours?: number;
  maxItemsPerTick?: number;
}

export interface RescanStepResult {
  scanned: number;
  snapshots: number;
}

export async function rescanStep(
  deps: RescanStepDeps,
): Promise<RescanStepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => {});
  const windowHours = deps.windowHours ?? RESCAN_WINDOW_HOURS;
  const maxItems = deps.maxItemsPerTick ?? 500;

  const tracked = await listItemsYoungerThan(deps.client, windowHours);
  const slice = tracked.slice(0, maxItems);

  let snapshots = 0;
  for (const row of slice) {
    const item = await fetchItem(row.id, deps.hn);
    if (!item) continue;
    await scoreAndInsertSnapshot(deps.client, {
      item_id: row.id,
      posted_at: postedAtOf(item, now),
      url: item.url ?? null,
      title: item.title ?? null,
      by: item.by ?? null,
      taken_at: now,
      rank: null,
      score: item.score ?? null,
      comments: item.descendants ?? null,
    });
    snapshots += 1;
  }

  setLastBatch(now);
  log(`[poller] rescan: tracked=${tracked.length} snapshots=${snapshots}`);
  return { scanned: slice.length, snapshots };
}

export interface PollerOptions {
  client: ItemsQueryClient;
  newstoriesIntervalMs?: number;
  rescanIntervalMs?: number;
  rescanWindowHours?: number;
  fetchImpl?: FetchLike;
  hnBaseUrl?: string;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export interface PollerHandle {
  stop(): Promise<void>;
  getLastBatchAt(): Date | null;
}

export function startPoller(opts: PollerOptions): PollerHandle {
  const newstoriesInterval = opts.newstoriesIntervalMs ?? NEWSTORIES_INTERVAL_MS;
  const rescanInterval = opts.rescanIntervalMs ?? RESCAN_INTERVAL_MS;
  const windowHours = opts.rescanWindowHours ?? RESCAN_WINDOW_HOURS;
  const log = opts.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const onError =
    opts.onError ??
    ((err: unknown, label: string) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[poller:${label}] error: ${msg}\n`);
    });

  const seen = new Set<number>();
  const hn: HnClientOptions = {
    fetchImpl: opts.fetchImpl,
    baseUrl: opts.hnBaseUrl,
  };

  let stopped = false;
  let activeNewstories: Promise<unknown> | null = null;
  let activeRescan: Promise<unknown> | null = null;

  const runNewstories = async (): Promise<void> => {
    try {
      activeNewstories = pollNewStoriesStep({ client: opts.client, seen, hn, log });
      await activeNewstories;
    } catch (err) {
      onError(err, "newstories");
    } finally {
      activeNewstories = null;
    }
  };

  const runRescan = async (): Promise<void> => {
    try {
      activeRescan = rescanStep({
        client: opts.client,
        hn,
        log,
        windowHours,
      });
      await activeRescan;
    } catch (err) {
      onError(err, "rescan");
    } finally {
      activeRescan = null;
    }
  };

  const newstoriesTimer = setInterval(() => {
    if (!stopped) void runNewstories();
  }, newstoriesInterval);
  const rescanTimer = setInterval(() => {
    if (!stopped) void runRescan();
  }, rescanInterval);

  void runNewstories();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(newstoriesTimer);
      clearInterval(rescanTimer);
      if (activeNewstories) await activeNewstories.catch(() => {});
      if (activeRescan) await activeRescan.catch(() => {});
    },
    getLastBatchAt,
  };
}
