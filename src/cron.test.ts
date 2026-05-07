import { describe, expect, it, vi } from "vitest";
import { msUntilNextDailyUtc, startCron } from "./cron.js";
import type {
  DailyDigestDeps,
  DigestTelegramSender,
} from "./jobs/daily-digest.js";
import { InMemoryPlotStore } from "./jobs/plot-store.js";
import type {
  WeeklyCalibrationDeps,
  WeeklyCalibrationTelegramSender,
} from "./jobs/weekly-calibration.js";
import type { ItemsQueryClient } from "./db/items.js";

describe("msUntilNextDailyUtc", () => {
  it("returns ms to today's slot when before it", () => {
    const now = new Date("2026-05-08T08:00:00.000Z");
    const ms = msUntilNextDailyUtc(now, 9);
    expect(ms).toBe(60 * 60_000);
  });

  it("rolls to tomorrow when now is past today's slot", () => {
    const now = new Date("2026-05-08T09:00:00.000Z");
    const ms = msUntilNextDailyUtc(now, 9);
    expect(ms).toBe(24 * 60 * 60_000);
  });

  it("rolls to tomorrow on exact second boundary at the slot", () => {
    const now = new Date("2026-05-08T09:00:00.000Z");
    const ms = msUntilNextDailyUtc(now, 9);
    expect(ms).toBeGreaterThan(0);
  });
});

describe("startCron", () => {
  it("schedules the daily-digest using the injected timer", () => {
    const fakeClient: ItemsQueryClient = {
      async query(): Promise<{ rows: never[] }> {
        return { rows: [] };
      },
    };
    const tg: DigestTelegramSender = {
      async sendMessage(): Promise<void> {},
    };
    const digest: DailyDigestDeps = {
      client: fakeClient,
      telegram: tg,
      publicUrl: "https://example.com",
    };

    const setTimeoutImpl = vi.fn((_fn: () => void, _ms: number) => 42);
    const clearTimeoutImpl = vi.fn();

    const handle = startCron({
      digest,
      now: () => new Date("2026-05-08T08:00:00.000Z"),
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    expect(setTimeoutImpl.mock.calls[0]![1]).toBe(60 * 60_000);

    handle.stop();
    expect(clearTimeoutImpl).toHaveBeenCalledWith(42);
  });

  it("does not schedule when no digest deps are provided", () => {
    const setTimeoutImpl = vi.fn();
    startCron({
      now: () => new Date(),
      setTimeoutImpl,
    });
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });

  it("schedules the weekly-calibration job for next Monday 09:00 UTC", () => {
    const fakeClient: ItemsQueryClient = {
      async query(): Promise<{ rows: never[] }> {
        return { rows: [] };
      },
    };
    const tg: WeeklyCalibrationTelegramSender = {
      async sendMessage(): Promise<void> {},
    };
    const weekly: WeeklyCalibrationDeps = {
      client: fakeClient,
      telegram: tg,
      plotStore: new InMemoryPlotStore(),
      publicUrl: "https://example.com",
    };

    let nextHandleId = 0;
    const setTimeoutImpl = vi.fn(
      (_fn: () => void, _ms: number) => ++nextHandleId,
    );
    const clearTimeoutImpl = vi.fn();

    // Tuesday 2026-05-05 00:00 UTC → next Monday 09:00 is 6d 9h away
    const handle = startCron({
      weeklyCalibration: weekly,
      now: () => new Date("2026-05-05T00:00:00.000Z"),
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    expect(setTimeoutImpl.mock.calls[0]![1]).toBe(
      6 * 24 * 60 * 60_000 + 9 * 60 * 60_000,
    );

    handle.stop();
    expect(clearTimeoutImpl).toHaveBeenCalled();
  });

  it("schedules both daily-digest and weekly-calibration when both are provided", () => {
    const fakeClient: ItemsQueryClient = {
      async query(): Promise<{ rows: never[] }> {
        return { rows: [] };
      },
    };
    const dailyTg: DigestTelegramSender = {
      async sendMessage(): Promise<void> {},
    };
    const weeklyTg: WeeklyCalibrationTelegramSender = {
      async sendMessage(): Promise<void> {},
    };

    let nextHandleId = 0;
    const setTimeoutImpl = vi.fn(
      (_fn: () => void, _ms: number) => ++nextHandleId,
    );
    const clearTimeoutImpl = vi.fn();

    const handle = startCron({
      digest: {
        client: fakeClient,
        telegram: dailyTg,
        publicUrl: "https://example.com",
      },
      weeklyCalibration: {
        client: fakeClient,
        telegram: weeklyTg,
        plotStore: new InMemoryPlotStore(),
        publicUrl: "https://example.com",
      },
      now: () => new Date("2026-05-04T08:00:00.000Z"), // Mon 08:00
      setTimeoutImpl,
      clearTimeoutImpl,
    });

    expect(setTimeoutImpl).toHaveBeenCalledTimes(2);
    // Both fire in 1 hour: daily at 09:00 today, weekly at 09:00 today.
    expect(setTimeoutImpl.mock.calls[0]![1]).toBe(60 * 60_000);
    expect(setTimeoutImpl.mock.calls[1]![1]).toBe(60 * 60_000);

    handle.stop();
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(2);
  });
});
