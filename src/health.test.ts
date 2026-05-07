import { describe, expect, it } from "vitest";
import {
  type HealthQueryClient,
  POLLER_LIVENESS_WINDOW_MS,
  checkDb,
  checkPollerLiveness,
  runHealthChecks,
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

const fixedNow = new Date("2025-01-01T00:05:00Z");
const now = () => fixedNow;

describe("checkDb", () => {
  it("returns ok when SELECT 1 succeeds", async () => {
    const client = mockClient(async () => ({ rows: [] }));
    const res = await checkDb(client);
    expect(res.ok).toBe(true);
    expect(res.detail).toBeUndefined();
  });

  it("returns not ok with detail when query throws", async () => {
    const client = mockClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await checkDb(client);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("db unreachable");
    expect(res.detail).toContain("ECONNREFUSED");
  });
});

describe("checkPollerLiveness", () => {
  it("ok when most recent items.first_seen_at is within the window", async () => {
    const client = mockClient(async () => ({
      rows: [{ first_seen_at: new Date("2025-01-01T00:01:00Z") }],
    }));
    const res = await checkPollerLiveness(client, now);
    expect(res.ok).toBe(true);
  });

  it("not ok when most recent first_seen_at is older than 5 minutes", async () => {
    const client = mockClient(async () => ({
      rows: [{ first_seen_at: new Date("2024-12-31T23:55:00Z") }],
    }));
    const res = await checkPollerLiveness(client, now);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/poller stalled/);
  });

  it("not ok when there are no items at all (max returns null)", async () => {
    const client = mockClient(async () => ({
      rows: [{ first_seen_at: null }],
    }));
    const res = await checkPollerLiveness(client, now);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no items/);
  });

  it("not ok when result set is empty", async () => {
    const client = mockClient(async () => ({ rows: [] }));
    const res = await checkPollerLiveness(client, now);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no items/);
  });

  it("accepts ISO string return values from the DB driver", async () => {
    const client = mockClient(async () => ({
      rows: [{ first_seen_at: "2025-01-01T00:03:00Z" }],
    }));
    const res = await checkPollerLiveness(client, now);
    expect(res.ok).toBe(true);
  });

  it("returns not ok when query throws", async () => {
    const client = mockClient(async () => {
      throw new Error('relation "items" does not exist');
    });
    const res = await checkPollerLiveness(client, now);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("poller check failed");
  });

  it("respects a custom window argument", async () => {
    const client = mockClient(async () => ({
      rows: [{ first_seen_at: new Date("2025-01-01T00:04:00Z") }],
    }));
    const res = await checkPollerLiveness(client, now, 30 * 1000);
    expect(res.ok).toBe(false);
  });

  it("default window is 5 minutes", () => {
    expect(POLLER_LIVENESS_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});

describe("runHealthChecks", () => {
  it("ok=true when both checks pass", async () => {
    const client = mockClient(async (text) => {
      if (text.startsWith("SELECT 1")) return { rows: [] };
      return { rows: [{ first_seen_at: new Date("2025-01-01T00:04:00Z") }] };
    });
    const report = await runHealthChecks(client, now);
    expect(report.ok).toBe(true);
    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.poller.ok).toBe(true);
  });

  it("ok=false when db is unreachable; poller is reported as skipped", async () => {
    const client = mockClient(async () => {
      throw new Error("connection refused");
    });
    const report = await runHealthChecks(client, now);
    expect(report.ok).toBe(false);
    expect(report.checks.db.ok).toBe(false);
    expect(report.checks.poller.ok).toBe(false);
    expect(report.checks.poller.detail).toMatch(/skipped/);
  });

  it("ok=false when poller is stalled", async () => {
    const client = mockClient(async (text) => {
      if (text.startsWith("SELECT 1")) return { rows: [] };
      return { rows: [{ first_seen_at: new Date("2024-12-31T22:00:00Z") }] };
    });
    const report = await runHealthChecks(client, now);
    expect(report.ok).toBe(false);
    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.poller.ok).toBe(false);
  });
});
