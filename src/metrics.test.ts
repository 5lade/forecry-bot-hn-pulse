import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetMetricsForTest,
  alertsSentTotal,
  hnItemsSeenTotal,
  setActiveWatchesProvider,
  telegramSendFailuresTotal,
} from "./metrics.js";
import { createApp } from "./server.js";

afterEach(() => {
  _resetMetricsForTest();
  setActiveWatchesProvider(null);
});

async function withApp<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const app = createApp();
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /metrics", () => {
  it("returns text/plain prometheus format with all required metric names", async () => {
    setActiveWatchesProvider(() => 0);
    hnItemsSeenTotal.inc(2);
    alertsSentTotal.inc({ type: "front_page_likely" }, 1);
    telegramSendFailuresTotal.inc(1);

    await withApp(async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toMatch(/text\/plain/);
      const body = await res.text();
      expect(body).toMatch(/^# HELP hn_items_seen_total/m);
      expect(body).toMatch(/^# HELP alerts_sent_total/m);
      expect(body).toMatch(/^# HELP telegram_send_failures_total/m);
      expect(body).toMatch(/^# HELP poller_lag_seconds/m);
      expect(body).toMatch(/^# HELP active_watches/m);
      expect(body).toMatch(/^# HELP model_brier_7d/m);
      expect(body).toMatch(/^hn_items_seen_total 2/m);
      expect(body).toMatch(/alerts_sent_total\{type="front_page_likely"\} 1/);
      expect(body).toMatch(/^telegram_send_failures_total 1/m);
    });
  });
});
