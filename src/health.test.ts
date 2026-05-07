import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_LAG_MULTIPLIER,
  type HealthQueryClient,
  checkDb,
  checkPollerLag,
  checkStripe,
  checkTelegram,
  failedDependencies,
  liveness,
  runReadiness,
} from "./health.js";

type Handler = (
  text: string,
  params?: ReadonlyArray<unknown>,
) => Promise<{ rows: Array<Record<string, unknown>> }>;

function mockClient(handler: Handler): HealthQueryClient {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      const r = await handler(text, params);
      return { rows: r.rows as T[] };
    },
  };
}

describe("liveness", () => {
  it("returns status ok plus uptime + version with no I/O", () => {
    const startedAt = 1000;
    const report = liveness({
      now: () => 5500,
      startedAt,
      version: "9.9.9",
    });
    expect(report.status).toBe("ok");
    expect(report.uptime).toBeCloseTo(4.5, 5);
    expect(report.version).toBe("9.9.9");
  });

  it("clamps negative uptime to zero (clock skew tolerant)", () => {
    const report = liveness({
      now: () => 100,
      startedAt: 500,
      version: "0.0.1",
    });
    expect(report.uptime).toBe(0);
  });

  it("falls back to package.json version when not provided", () => {
    const report = liveness({ now: () => 1, startedAt: 0 });
    expect(typeof report.version).toBe("string");
    expect(report.version.length).toBeGreaterThan(0);
  });
});

describe("checkDb", () => {
  it("returns ok when SELECT 1 succeeds", async () => {
    const client = mockClient(async () => ({ rows: [] }));
    const res = await checkDb(client);
    expect(res.status).toBe("ok");
    expect(res.reason).toBeUndefined();
  });

  it("returns down with reason when query throws", async () => {
    const client = mockClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await checkDb(client);
    expect(res.status).toBe("down");
    expect(res.reason).toContain("ECONNREFUSED");
  });

  it("treats slow queries past the timeout as down", async () => {
    const client: HealthQueryClient = {
      async query() {
        await new Promise((r) => setTimeout(r, 50));
        return { rows: [] };
      },
    };
    const res = await checkDb(client, 5);
    expect(res.status).toBe("down");
    expect(res.reason).toMatch(/timed out/);
  });
});

describe("checkPollerLag", () => {
  const now = new Date("2025-01-01T00:00:00Z");

  it("ok when last poll is within 3× the expected interval", () => {
    const last = new Date(now.getTime() - DEFAULT_POLL_INTERVAL_MS * 2);
    const res = checkPollerLag({
      getLastBatchAt: () => last,
      now: () => now,
    });
    expect(res.status).toBe("ok");
  });

  it("down when no poll has been recorded", () => {
    const res = checkPollerLag({
      getLastBatchAt: () => null,
      now: () => now,
    });
    expect(res.status).toBe("down");
    expect(res.reason).toMatch(/no successful poll/);
  });

  it("down when lag exceeds 3× the expected interval", () => {
    const last = new Date(
      now.getTime() - DEFAULT_POLL_INTERVAL_MS * (DEFAULT_POLL_LAG_MULTIPLIER + 1),
    );
    const res = checkPollerLag({
      getLastBatchAt: () => last,
      now: () => now,
    });
    expect(res.status).toBe("down");
    expect(res.reason).toMatch(/poll lag/);
  });
});

describe("checkTelegram", () => {
  it("ok when getMe resolves", async () => {
    const res = await checkTelegram(async () => ({ ok: true }));
    expect(res.status).toBe("ok");
  });

  it("down when getMe rejects", async () => {
    const res = await checkTelegram(async () => {
      throw new Error("401 Unauthorized");
    });
    expect(res.status).toBe("down");
    expect(res.reason).toMatch(/401/);
  });

  it("down when getMe takes longer than the timeout", async () => {
    const res = await checkTelegram(
      () => new Promise((r) => setTimeout(() => r({}), 50)),
      5,
    );
    expect(res.status).toBe("down");
    expect(res.reason).toMatch(/timed out/);
  });
});

describe("checkStripe", () => {
  it("ok when ping resolves", async () => {
    const res = await checkStripe(async () => ({ available: [] }));
    expect(res.status).toBe("ok");
  });

  it("down when ping rejects", async () => {
    const res = await checkStripe(async () => {
      throw new Error("invalid_api_key");
    });
    expect(res.status).toBe("down");
    expect(res.reason).toMatch(/invalid_api_key/);
  });
});

describe("runReadiness", () => {
  const okClient = mockClient(async () => ({ rows: [] }));
  const okGetMe = async () => ({ ok: true });
  const okPing = async () => ({ available: [] });
  const now = () => new Date("2025-01-01T00:00:00Z");
  const recentPoll = () => new Date("2024-12-31T23:59:30Z");

  it("ok=true when every check passes", async () => {
    const report = await runReadiness({
      client: okClient,
      getLastBatchAt: recentPoll,
      telegramGetMe: okGetMe,
      stripePing: okPing,
      now,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.db.status).toBe("ok");
    expect(report.checks.poller.status).toBe("ok");
    expect(report.checks.telegram.status).toBe("ok");
    expect(report.checks.stripe.status).toBe("ok");
    expect(failedDependencies(report)).toEqual([]);
  });

  it("ok=false and identifies db when SELECT 1 throws", async () => {
    const report = await runReadiness({
      client: mockClient(async () => {
        throw new Error("connection refused");
      }),
      getLastBatchAt: recentPoll,
      telegramGetMe: okGetMe,
      stripePing: okPing,
      now,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.db.status).toBe("down");
    expect(failedDependencies(report)).toEqual(["db"]);
  });

  it("ok=false and identifies poller when lag is too high", async () => {
    const report = await runReadiness({
      client: okClient,
      getLastBatchAt: () => new Date("2024-12-31T22:00:00Z"),
      telegramGetMe: okGetMe,
      stripePing: okPing,
      now,
    });
    expect(report.ok).toBe(false);
    expect(failedDependencies(report)).toEqual(["poller"]);
  });

  it("ok=false and identifies telegram when getMe rejects", async () => {
    const report = await runReadiness({
      client: okClient,
      getLastBatchAt: recentPoll,
      telegramGetMe: async () => {
        throw new Error("telegram 503");
      },
      stripePing: okPing,
      now,
    });
    expect(report.ok).toBe(false);
    expect(failedDependencies(report)).toEqual(["telegram"]);
  });

  it("ok=false and identifies stripe when ping rejects", async () => {
    const report = await runReadiness({
      client: okClient,
      getLastBatchAt: recentPoll,
      telegramGetMe: okGetMe,
      stripePing: async () => {
        throw new Error("stripe 500");
      },
      now,
    });
    expect(report.ok).toBe(false);
    expect(failedDependencies(report)).toEqual(["stripe"]);
  });
});
