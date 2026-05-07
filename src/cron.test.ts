import { describe, expect, it, vi } from "vitest";
import { msUntilNextDailyUtc, startCron } from "./cron.js";
import type {
  DailyDigestDeps,
  DigestTelegramSender,
} from "./jobs/daily-digest.js";
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
});
