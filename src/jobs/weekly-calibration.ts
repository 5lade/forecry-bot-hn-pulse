import type { ItemsQueryClient } from "../db/items.js";
import { encodePng } from "./png.js";
import type { PlotStore } from "./plot-store.js";

export const WEEKLY_CAL_DAY_OF_WEEK = 1; // Monday (0=Sun)
export const WEEKLY_CAL_HOUR_UTC = 9;
export const WEEKLY_CAL_WINDOW_DAYS = 7;
export const FRONT_PAGE_RANK_THRESHOLD = 30;

export interface WeeklyCalibrationPrediction {
  predicted: number;
  outcome: 0 | 1;
}

export const THRESHOLD_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  // Upper band must include p=1.0 — bump the right edge slightly past 1.
  [0.9, 1.0001],
];

export interface BandStat {
  band: readonly [number, number];
  total: number;
  hits: number;
  hitRate: number;
}

export interface PulseProUser {
  id: string;
  telegram_user_id: number;
}

export interface WeeklyCalibrationTelegramSender {
  sendMessage(chatId: number, text: string): Promise<void>;
}

export interface WeeklyCalibrationDeps {
  client: ItemsQueryClient;
  telegram: WeeklyCalibrationTelegramSender;
  plotStore: PlotStore;
  publicUrl: string;
  /** Lets tests pin the run time. Defaults to `() => new Date()`. */
  clock?: () => Date;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export interface WeeklyCalibrationResult {
  weekKey: string;
  eligibleUsers: number;
  predictionCount: number;
  brier: number | null;
  rocAuc: number | null;
  sent: number;
  skippedAlreadySent: number;
  failed: number;
}

interface WeeklyWindow {
  fromUtc: Date;
  toUtc: Date;
  weekKey: string;
}

/**
 * The recap covers the trailing 7 calendar days strictly before today
 * (UTC). When invoked at 09:00 Monday, that is Mon..Sun of the prior week.
 * weekKey is the ISO date of the window start.
 */
export function lastSevenDaysWindow(now: Date): WeeklyWindow {
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(
    todayStart.getTime() - WEEKLY_CAL_WINDOW_DAYS * 24 * 60 * 60_000,
  );
  return {
    fromUtc: start,
    toUtc: todayStart,
    weekKey: start.toISOString().slice(0, 10),
  };
}

/**
 * Milliseconds from `now` to the next instance of `hourUtc:00` on the
 * configured day of the week (UTC). If we are at-or-past this week's slot,
 * the next slot is one week ahead.
 */
export function msUntilNextWeeklyUtc(
  now: Date,
  dayOfWeek: number,
  hourUtc: number,
): number {
  const target = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  const currentDow = target.getUTCDay();
  let dayOffset = (dayOfWeek - currentDow + 7) % 7;
  if (dayOffset === 0 && target.getTime() <= now.getTime()) {
    dayOffset = 7;
  }
  target.setUTCDate(target.getUTCDate() + dayOffset);
  return target.getTime() - now.getTime();
}

export function brierScore(
  preds: ReadonlyArray<WeeklyCalibrationPrediction>,
): number {
  if (preds.length === 0) return 0;
  let sum = 0;
  for (const p of preds) sum += (p.predicted - p.outcome) ** 2;
  return sum / preds.length;
}

/**
 * Binary classifier ROC AUC via the Mann-Whitney U statistic with tie
 * correction (average rank inside each tie group). Returns NaN when the
 * sample contains only one class, since AUC is undefined in that case.
 */
export function rocAuc(
  preds: ReadonlyArray<WeeklyCalibrationPrediction>,
): number {
  const positives = preds.filter((p) => p.outcome === 1).length;
  const negatives = preds.length - positives;
  if (positives === 0 || negatives === 0) return Number.NaN;

  const sorted = [...preds].sort((a, b) => a.predicted - b.predicted);
  let rankSumPos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (
      j < sorted.length &&
      sorted[j]!.predicted === sorted[i]!.predicted
    ) {
      j += 1;
    }
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (sorted[k]!.outcome === 1) rankSumPos += avgRank;
    }
    i = j;
  }
  const u = rankSumPos - (positives * (positives + 1)) / 2;
  return u / (positives * negatives);
}

export function hitRateByBand(
  preds: ReadonlyArray<WeeklyCalibrationPrediction>,
  bands: ReadonlyArray<readonly [number, number]> = THRESHOLD_BANDS,
): BandStat[] {
  return bands.map(([lo, hi]) => {
    let total = 0;
    let hits = 0;
    for (const p of preds) {
      if (p.predicted >= lo && p.predicted < hi) {
        total += 1;
        if (p.outcome === 1) hits += 1;
      }
    }
    return {
      band: [lo, hi] as const,
      total,
      hits,
      hitRate: total === 0 ? 0 : hits / total,
    };
  });
}

function setPx(
  rgba: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 0xff,
): void {
  if (x < 0 || x >= w || y < 0 || y >= h) return;
  const i = (y * w + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
  rgba[i + 3] = a;
}

/**
 * Render a calibration bar chart for a sequence of band stats. Each bar
 * shows realized hit rate; a red dot marks the band's mid-point predicted
 * probability — perfect calibration sits all dots on top of all bars.
 */
export function renderCalibrationChart(
  stats: ReadonlyArray<BandStat>,
): Buffer {
  const W = 600;
  const H = 400;
  const PAD_L = 60;
  const PAD_R = 30;
  const PAD_T = 30;
  const PAD_B = 60;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 0xff;
    rgba[i + 1] = 0xff;
    rgba[i + 2] = 0xff;
    rgba[i + 3] = 0xff;
  }

  // Y gridlines at 25/50/75/100%
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    const yPos = H - PAD_B - Math.round(plotH * frac);
    for (let x = PAD_L; x < W - PAD_R; x++) {
      setPx(rgba, W, H, x, yPos, 0xdd, 0xdd, 0xdd);
    }
  }

  // Axes (black)
  for (let x = PAD_L; x < W - PAD_R; x++) {
    setPx(rgba, W, H, x, H - PAD_B, 0, 0, 0);
  }
  for (let y = PAD_T; y <= H - PAD_B; y++) {
    setPx(rgba, W, H, PAD_L, y, 0, 0, 0);
  }

  if (stats.length > 0) {
    const slot = plotW / stats.length;
    const barW = Math.max(1, Math.floor(slot * 0.65));
    for (let i = 0; i < stats.length; i++) {
      const s = stats[i]!;
      const xStart = PAD_L + Math.round(i * slot + (slot - barW) / 2);
      const barH = Math.round(plotH * Math.max(0, Math.min(1, s.hitRate)));
      const yStart = H - PAD_B - barH;

      // Bar — solid blue.
      for (let dy = 0; dy < barH; dy++) {
        for (let dx = 0; dx < barW; dx++) {
          setPx(rgba, W, H, xStart + dx, yStart + dy, 0x33, 0x66, 0xcc);
        }
      }

      // Predicted-midpoint marker (red dot, 5x5).
      const mid = (s.band[0] + s.band[1]) / 2;
      const expectedY =
        H - PAD_B - Math.round(plotH * Math.max(0, Math.min(1, mid)));
      const dotX = xStart + Math.floor(barW / 2);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setPx(rgba, W, H, dotX + dx, expectedY + dy, 0xcc, 0x33, 0x33);
        }
      }
    }
  }

  return encodePng(W, H, rgba);
}

export async function listPulseProUsers(
  client: ItemsQueryClient,
): Promise<PulseProUser[]> {
  const res = await client.query<{
    id: string;
    telegram_user_id: number | string;
  }>(
    `SELECT id, telegram_user_id
       FROM users
      WHERE tier = 'pulse-pro' AND digest_opt_in = TRUE
      ORDER BY id`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    telegram_user_id: Number(r.telegram_user_id),
  }));
}

/**
 * Returns one row per item first seen in [fromUtc, toUtc) whose first
 * snapshot has a non-null predicted probability and whose final outcome
 * (`reached_front_page`) has been resolved.
 */
export async function listResolvedPredictions(
  client: ItemsQueryClient,
  args: { fromUtc: Date; toUtc: Date },
): Promise<WeeklyCalibrationPrediction[]> {
  const res = await client.query<{
    predicted_p: number | string | null;
    reached_front_page: boolean | null;
  }>(
    `WITH first_snap AS (
       SELECT DISTINCT ON (s.item_id)
              s.item_id,
              s.p_front_page_6h AS predicted_p
         FROM item_snapshots s
         JOIN items i ON i.id = s.item_id
        WHERE i.first_seen_at >= $1 AND i.first_seen_at < $2
        ORDER BY s.item_id, s.taken_at ASC
     )
     SELECT fs.predicted_p, i.reached_front_page
       FROM first_snap fs
       JOIN items i ON i.id = fs.item_id
      WHERE fs.predicted_p IS NOT NULL
        AND i.reached_front_page IS NOT NULL`,
    [args.fromUtc, args.toUtc],
  );
  return res.rows
    .filter((r) => r.predicted_p != null && r.reached_front_page != null)
    .map((r) => ({
      predicted: Number(r.predicted_p),
      outcome: r.reached_front_page ? 1 : 0,
    }));
}

export async function tryClaimWeeklyCalibrationRun(
  client: ItemsQueryClient,
  args: { userId: string; weekKey: string },
): Promise<boolean> {
  const res = await client.query<{ user_id: string }>(
    `INSERT INTO weekly_calibration_runs (user_id, week_key)
     VALUES ($1, $2)
     ON CONFLICT (user_id, week_key) DO NOTHING
     RETURNING user_id`,
    [args.userId, args.weekKey],
  );
  return res.rows.length > 0;
}

export function plotKeyFor(weekKey: string, userId: string): string {
  return `weekly-calibration/${weekKey}/${userId}`;
}

export function plotUrlFor(publicUrl: string, key: string): string {
  return `${publicUrl.replace(/\/$/, "")}/plots/${key}.png`;
}

function fmtPct(p: number | null | undefined): string {
  if (p == null || Number.isNaN(p)) return "n/a";
  return `${(p * 100).toFixed(1)}%`;
}

function fmtBand(band: readonly [number, number]): string {
  const lo = Math.round(band[0] * 100);
  const hi = Math.min(100, Math.round(band[1] * 100));
  return `${lo}-${hi}%`;
}

export function buildWeeklyCalibrationMessage(args: {
  weekKey: string;
  predictionCount: number;
  brier: number;
  rocAuc: number;
  bands: ReadonlyArray<BandStat>;
  plotUrl: string;
}): string {
  const { weekKey, predictionCount, brier, rocAuc, bands, plotUrl } = args;
  const header = `HN Pulse weekly calibration — week of ${weekKey}`;
  const summary = `Resolved predictions: ${predictionCount}.`;
  const stats = [
    `Brier score: ${brier.toFixed(3)} (lower is better)`,
    `ROC AUC: ${Number.isNaN(rocAuc) ? "n/a (single-class week)" : rocAuc.toFixed(3)}`,
  ].join("\n");
  const bandLines = bands
    .map(
      (b) =>
        `  ${fmtBand(b.band)}: ${fmtPct(b.hitRate)} (${b.hits}/${b.total})`,
    )
    .join("\n");
  const banner =
    bandLines.length > 0
      ? `Hit rate by predicted band:\n${bandLines}`
      : "Hit rate by predicted band: (no predictions)";
  const footer = `Plot: ${plotUrl}`;
  return [header, summary, stats, "", banner, "", footer].join("\n");
}

async function sendOne(
  user: PulseProUser,
  payload: {
    text: string;
    plotKey: string;
    png: Buffer;
  },
  deps: WeeklyCalibrationDeps,
): Promise<"sent" | "failed"> {
  await deps.plotStore.put(payload.plotKey, payload.png);
  try {
    await deps.telegram.sendMessage(user.telegram_user_id, payload.text);
    return "sent";
  } catch (err) {
    if (deps.onError) deps.onError(err, "weekly-calibration-send");
    return "failed";
  }
}

export async function runWeeklyCalibration(
  deps: WeeklyCalibrationDeps,
): Promise<WeeklyCalibrationResult> {
  const now = (deps.clock ?? (() => new Date()))();
  const log = deps.log ?? ((): void => {});
  const window = lastSevenDaysWindow(now);

  const users = await listPulseProUsers(deps.client);
  const predictions = await listResolvedPredictions(deps.client, {
    fromUtc: window.fromUtc,
    toUtc: window.toUtc,
  });

  const result: WeeklyCalibrationResult = {
    weekKey: window.weekKey,
    eligibleUsers: users.length,
    predictionCount: predictions.length,
    brier: predictions.length === 0 ? null : brierScore(predictions),
    rocAuc: predictions.length === 0 ? null : rocAuc(predictions),
    sent: 0,
    skippedAlreadySent: 0,
    failed: 0,
  };

  if (users.length === 0) {
    log(
      `[weekly-calibration] week=${result.weekKey} eligible=0 (no pulse-pro users)`,
    );
    return result;
  }

  const bands = hitRateByBand(predictions);
  const png = renderCalibrationChart(bands);

  for (const user of users) {
    try {
      const claimed = await tryClaimWeeklyCalibrationRun(deps.client, {
        userId: user.id,
        weekKey: window.weekKey,
      });
      if (!claimed) {
        result.skippedAlreadySent += 1;
        continue;
      }

      const plotKey = plotKeyFor(window.weekKey, user.id);
      const plotUrl = plotUrlFor(deps.publicUrl, plotKey);
      const text = buildWeeklyCalibrationMessage({
        weekKey: window.weekKey,
        predictionCount: predictions.length,
        brier: result.brier ?? 0,
        rocAuc: result.rocAuc ?? Number.NaN,
        bands,
        plotUrl,
      });

      const outcome = await sendOne(
        user,
        { text, plotKey, png },
        deps,
      );
      if (outcome === "sent") result.sent += 1;
      else result.failed += 1;
    } catch (err) {
      result.failed += 1;
      if (deps.onError) deps.onError(err, "weekly-calibration-user");
    }
  }

  log(
    `[weekly-calibration] week=${result.weekKey} eligible=${result.eligibleUsers} ` +
      `predictions=${result.predictionCount} sent=${result.sent} ` +
      `already=${result.skippedAlreadySent} failed=${result.failed}`,
  );
  return result;
}
