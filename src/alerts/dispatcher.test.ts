import { describe, expect, it, vi } from "vitest";
import type { ItemsQueryClient } from "../db/items.js";
import {
  DEFAULT_DEDUP_WINDOW_MS,
  dispatchAlertsForSnapshot,
  type SnapshotForDispatch,
} from "./dispatcher.js";
import { InMemoryAlertSender, type AlertEnvelope } from "./sender.js";

interface QueryCall {
  text: string;
  params?: ReadonlyArray<unknown>;
}

interface FakeWatchRow {
  id: string;
  user_id: string;
  watch_type: string;
  watch_value: string;
  user_tier: string;
  user_threshold_pct: number;
}

interface FakeAlertRow {
  id: string;
  user_id: string;
  item_id: number;
  alert_type: string;
  matched_at: Date;
  delivered_at: Date | null;
  payload: unknown;
}

interface FakeDb {
  watches: FakeWatchRow[];
  alerts: FakeAlertRow[];
  client: ItemsQueryClient;
  calls: QueryCall[];
}

function makeDb(initial: { watches?: FakeWatchRow[] } = {}): FakeDb {
  const watches = [...(initial.watches ?? [])];
  const alerts: FakeAlertRow[] = [];
  const calls: QueryCall[] = [];

  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      const sql = text.trim();

      if (/^SELECT[\s\S]*FROM watches/i.test(sql)) {
        const watchType = sql.match(
          /watch_type\s*=\s*'(item|domain|submitter)'/i,
        )?.[1];
        const watchValue = String(params?.[0] ?? "");
        const rows = watches
          .filter((w) => w.watch_type === watchType && w.watch_value === watchValue)
          .map((w) => ({ ...w }));
        return { rows: rows as unknown as T[] };
      }

      if (/^SELECT[\s\S]*FROM alerts/i.test(sql)) {
        const userId = String(params?.[0]);
        const itemId = Number(params?.[1]);
        const alertType = String(params?.[2]);
        const cutoff = params?.[3] as Date;
        const matched = alerts.find(
          (a) =>
            a.user_id === userId &&
            a.item_id === itemId &&
            a.alert_type === alertType &&
            a.matched_at >= cutoff,
        );
        return {
          rows: matched ? ([{ exists: true }] as unknown as T[]) : ([] as T[]),
        };
      }

      if (/^INSERT INTO alerts/i.test(sql)) {
        alerts.push({
          id: String(params?.[0]),
          user_id: String(params?.[1]),
          item_id: Number(params?.[2]),
          alert_type: String(params?.[3]),
          matched_at: params?.[4] as Date,
          delivered_at: null,
          payload: params?.[5],
        });
        return { rows: [] as T[] };
      }

      if (/^UPDATE alerts SET delivered_at/i.test(sql)) {
        const id = String(params?.[0]);
        const deliveredAt = params?.[1] as Date;
        const row = alerts.find((a) => a.id === id);
        if (row) row.delivered_at = deliveredAt;
        return { rows: [] as T[] };
      }

      return { rows: [] as T[] };
    },
  };

  return { watches, alerts, client, calls };
}

function snap(overrides: Partial<SnapshotForDispatch> = {}): SnapshotForDispatch {
  return {
    itemId: 42,
    itemBy: "alice",
    itemDomain: "example.com",
    pFrontPage6h: 0.7,
    deltaP5min: 0.05,
    isFirstSnapshot: false,
    ...overrides,
  };
}

describe("dispatchAlertsForSnapshot — happy path", () => {
  it("synthetic watch + matching snapshot results in exactly one alerts row, with delivered_at populated", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "item",
          watch_value: "42",
          user_tier: "pulse",
          user_threshold_pct: 60,
        },
      ],
    });
    const sender = new InMemoryAlertSender();
    const t0 = Date.now();
    let n = 0;
    const now = vi.fn(() => new Date(t0 + n++ * 100));

    const result = await dispatchAlertsForSnapshot(
      {
        client: db.client,
        sender,
        now,
        generateId: (() => {
          let i = 0;
          return () => `alert-${++i}`;
        })(),
      },
      snap({ pFrontPage6h: 0.9 }),
    );

    expect(result.matched).toHaveLength(1);
    expect(result.inserted).toHaveLength(1);
    expect(result.delivered).toHaveLength(1);

    expect(db.alerts).toHaveLength(1);
    const row = db.alerts[0]!;
    expect(row.alert_type).toBe("threshold");
    expect(row.user_id).toBe("u-1");
    expect(row.item_id).toBe(42);
    expect(row.matched_at).toBeInstanceOf(Date);
    expect(row.delivered_at).toBeInstanceOf(Date);

    // delivered_at populated within 5s of matched_at — well within in this stubbed path.
    const lagMs =
      (row.delivered_at as Date).getTime() - row.matched_at.getTime();
    expect(lagMs).toBeGreaterThanOrEqual(0);
    expect(lagMs).toBeLessThan(5_000);

    expect(sender.delivered).toHaveLength(1);
    const env = sender.delivered[0]! as AlertEnvelope;
    expect(env.alert_id).toBe("alert-1");
    expect(env.alert_type).toBe("threshold");
  });
});

describe("dispatchAlertsForSnapshot — dedup window", () => {
  it("suppresses a second alert for the same (user, item, alert_type) within 30 minutes", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "item",
          watch_value: "42",
          user_tier: "pulse",
          user_threshold_pct: 60,
        },
      ],
    });
    const sender = new InMemoryAlertSender();
    const base = new Date("2025-06-01T00:00:00Z").getTime();

    // First dispatch
    await dispatchAlertsForSnapshot(
      {
        client: db.client,
        sender,
        now: () => new Date(base),
        generateId: () => "alert-A",
      },
      snap({ pFrontPage6h: 0.9 }),
    );
    expect(db.alerts).toHaveLength(1);

    // Second dispatch 10 minutes later — must be suppressed.
    const second = await dispatchAlertsForSnapshot(
      {
        client: db.client,
        sender,
        now: () => new Date(base + 10 * 60_000),
        generateId: () => "alert-B",
      },
      snap({ pFrontPage6h: 0.95 }),
    );
    expect(second.suppressedByDedup).toHaveLength(1);
    expect(db.alerts).toHaveLength(1);

    // Third dispatch 31 minutes after the first — outside the window, must fire.
    const third = await dispatchAlertsForSnapshot(
      {
        client: db.client,
        sender,
        now: () => new Date(base + 31 * 60_000),
        generateId: () => "alert-C",
      },
      snap({ pFrontPage6h: 0.95 }),
    );
    expect(third.inserted).toHaveLength(1);
    expect(db.alerts).toHaveLength(2);
  });

  it("does not dedup across different alert_types for the same item/user", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "submitter",
          watch_value: "alice",
          user_tier: "pulse",
          user_threshold_pct: 60,
        },
      ],
    });
    const sender = new InMemoryAlertSender();
    let i = 0;
    await dispatchAlertsForSnapshot(
      {
        client: db.client,
        sender,
        now: () => new Date("2025-06-01T00:00:00Z"),
        generateId: () => `a-${++i}`,
      },
      snap({
        pFrontPage6h: 0.9,
        deltaP5min: 0.5,
        isFirstSnapshot: true,
      }),
    );
    const types = new Set(db.alerts.map((a) => a.alert_type));
    expect(types.has("threshold")).toBe(true);
    expect(types.has("acceleration")).toBe(true);
    expect(types.has("submitted")).toBe(true);
  });
});

describe("dispatchAlertsForSnapshot — alert types coverage", () => {
  it("emits a 'threshold' alert when probability crosses user threshold", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "domain",
          watch_value: "example.com",
          user_tier: "pulse",
          user_threshold_pct: 60,
        },
      ],
    });
    const out = await dispatchAlertsForSnapshot(
      { client: db.client, sender: new InMemoryAlertSender() },
      snap({ pFrontPage6h: 0.7 }),
    );
    expect(out.inserted.map((a) => a.alert_type)).toEqual(["threshold"]);
  });

  it("emits an 'acceleration' alert when delta_p_5min > 0.15", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "item",
          watch_value: "42",
          user_tier: "pulse",
          user_threshold_pct: 60,
        },
      ],
    });
    const out = await dispatchAlertsForSnapshot(
      { client: db.client, sender: new InMemoryAlertSender() },
      snap({ pFrontPage6h: 0.2, deltaP5min: 0.2 }),
    );
    expect(out.inserted.map((a) => a.alert_type)).toEqual(["acceleration"]);
  });

  it("emits a 'submitted' alert on the first snapshot when watching a submitter", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "submitter",
          watch_value: "alice",
          user_tier: "pulse",
          user_threshold_pct: 60,
        },
      ],
    });
    const out = await dispatchAlertsForSnapshot(
      { client: db.client, sender: new InMemoryAlertSender() },
      snap({
        pFrontPage6h: 0.1,
        deltaP5min: 0.0,
        isFirstSnapshot: true,
      }),
    );
    expect(out.inserted.map((a) => a.alert_type)).toEqual(["submitted"]);
  });

  it("free tier only gets threshold alerts when probability >= 80%", async () => {
    const db = makeDb({
      watches: [
        {
          id: "w-1",
          user_id: "u-1",
          watch_type: "item",
          watch_value: "42",
          user_tier: "free",
          user_threshold_pct: 60,
        },
      ],
    });
    const below = await dispatchAlertsForSnapshot(
      { client: db.client, sender: new InMemoryAlertSender() },
      snap({ pFrontPage6h: 0.7, deltaP5min: 0.5 }),
    );
    expect(below.inserted).toHaveLength(0);

    const above = await dispatchAlertsForSnapshot(
      { client: db.client, sender: new InMemoryAlertSender() },
      snap({ pFrontPage6h: 0.85, deltaP5min: 0.5 }),
    );
    expect(above.inserted.map((a) => a.alert_type)).toEqual(["threshold"]);
  });
});

describe("dispatchAlertsForSnapshot — no watches", () => {
  it("emits nothing when no watches match", async () => {
    const db = makeDb();
    const out = await dispatchAlertsForSnapshot(
      { client: db.client, sender: new InMemoryAlertSender() },
      snap({ pFrontPage6h: 0.99 }),
    );
    expect(out.matched).toHaveLength(0);
    expect(out.inserted).toHaveLength(0);
    expect(db.alerts).toHaveLength(0);
  });
});

describe("DEFAULT_DEDUP_WINDOW_MS", () => {
  it("is 30 minutes", () => {
    expect(DEFAULT_DEDUP_WINDOW_MS).toBe(30 * 60 * 1000);
  });
});
