import { Counter, Gauge, Registry } from "prom-client";

export const registry = new Registry();

export const hnItemsSeenTotal = new Counter({
  name: "hn_items_seen_total",
  help: "Total number of HN items seen by the poller (newstories or rescan).",
  registers: [registry],
});

export const alertsSentTotal = new Counter({
  name: "alerts_sent_total",
  help: "Total number of alerts successfully delivered, labeled by alert type.",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const telegramSendFailuresTotal = new Counter({
  name: "telegram_send_failures_total",
  help: "Total number of Telegram sendMessage failures (after retries).",
  registers: [registry],
});

export const pollerLagSeconds = new Gauge({
  name: "poller_lag_seconds",
  help: "Seconds elapsed since the poller's last successful batch.",
  registers: [registry],
  collect(): void {
    if (lastBatchAtMs == null) {
      this.set(0);
      return;
    }
    this.set(Math.max(0, (Date.now() - lastBatchAtMs) / 1000));
  },
});

export const activeWatches = new Gauge({
  name: "active_watches",
  help: "Number of active user watches across all watch types.",
  registers: [registry],
});

let activeWatchesProvider: (() => Promise<number> | number) | null = null;

export function setActiveWatchesProvider(
  provider: (() => Promise<number> | number) | null,
): void {
  activeWatchesProvider = provider;
}

async function refreshActiveWatches(): Promise<void> {
  if (!activeWatchesProvider) return;
  try {
    const value = await activeWatchesProvider();
    if (Number.isFinite(value)) activeWatches.set(value);
  } catch {
    // Leave the previous value; don't crash a scrape because the DB blipped.
  }
}

export const modelBrier7d = new Gauge({
  name: "model_brier_7d",
  help: "Rolling 7-day Brier score of the trained scorer (lower is better).",
  registers: [registry],
});

let lastBatchAtMs: number | null = null;

export function recordBatchAt(when: Date): void {
  lastBatchAtMs = when.getTime();
}

export function _resetMetricsForTest(): void {
  lastBatchAtMs = null;
  registry.resetMetrics();
}

export async function renderMetrics(): Promise<{
  contentType: string;
  body: string;
}> {
  await refreshActiveWatches();
  const body = await registry.metrics();
  return { contentType: registry.contentType, body };
}
