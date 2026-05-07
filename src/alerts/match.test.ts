import { describe, expect, it } from "vitest";
import type { WatchWithUser } from "../db/watches.js";
import {
  ACCELERATION_DELTA_THRESHOLD,
  matchAlerts,
  type SnapshotMatchInput,
} from "./match.js";

function watch(overrides: Partial<WatchWithUser> = {}): WatchWithUser {
  return {
    id: "w-1",
    user_id: "u-1",
    watch_type: "item",
    watch_value: "42",
    user_tier: "pulse",
    user_threshold_pct: 60,
    ...overrides,
  };
}

function snap(overrides: Partial<SnapshotMatchInput> = {}): SnapshotMatchInput {
  return {
    itemId: 42,
    itemBy: "alice",
    itemDomain: "example.com",
    pFrontPage6h: 0.5,
    deltaP5min: 0.05,
    isFirstSnapshot: false,
    ...overrides,
  };
}

describe("matchAlerts — threshold", () => {
  it("fires threshold for an item watch when probability >= user threshold", () => {
    const out = matchAlerts(
      snap({ pFrontPage6h: 0.7 }),
      [watch({ user_tier: "pulse", user_threshold_pct: 60 })],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.alert_type).toBe("threshold");
    expect(out[0]?.payload.threshold_pct).toBe(60);
  });

  it("does not fire threshold when probability is below user threshold", () => {
    const out = matchAlerts(
      snap({ pFrontPage6h: 0.55 }),
      [watch({ user_tier: "pulse", user_threshold_pct: 60 })],
    );
    expect(out.filter((a) => a.alert_type === "threshold")).toHaveLength(0);
  });

  it("free tier is gated to >= 80% even if user_threshold_pct is lower", () => {
    const w = watch({ user_tier: "free", user_threshold_pct: 50 });
    const below = matchAlerts(snap({ pFrontPage6h: 0.7 }), [w]);
    const above = matchAlerts(snap({ pFrontPage6h: 0.81 }), [w]);
    expect(below.filter((a) => a.alert_type === "threshold")).toHaveLength(0);
    expect(above.filter((a) => a.alert_type === "threshold")).toHaveLength(1);
    expect(above[0]?.payload.threshold_pct).toBe(80);
  });

  it("matches by domain when watch_type is domain", () => {
    const out = matchAlerts(
      snap({ pFrontPage6h: 0.9, itemDomain: "blog.example" }),
      [
        watch({
          watch_type: "domain",
          watch_value: "blog.example",
          user_tier: "pulse",
          user_threshold_pct: 60,
        }),
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.alert_type).toBe("threshold");
  });
});

describe("matchAlerts — acceleration", () => {
  it("fires acceleration when delta_p_5min > 0.15 (paid tier)", () => {
    const out = matchAlerts(
      snap({
        pFrontPage6h: 0.2,
        deltaP5min: ACCELERATION_DELTA_THRESHOLD + 0.001,
      }),
      [watch({ user_tier: "pulse" })],
    );
    expect(out.some((a) => a.alert_type === "acceleration")).toBe(true);
  });

  it("does not fire acceleration at exactly the threshold", () => {
    const out = matchAlerts(
      snap({ pFrontPage6h: 0.2, deltaP5min: ACCELERATION_DELTA_THRESHOLD }),
      [watch({ user_tier: "pulse" })],
    );
    expect(out.some((a) => a.alert_type === "acceleration")).toBe(false);
  });

  it("does not fire acceleration for free tier even with a big delta", () => {
    const out = matchAlerts(
      snap({ pFrontPage6h: 0.2, deltaP5min: 0.5 }),
      [watch({ user_tier: "free", user_threshold_pct: 60 })],
    );
    expect(out.some((a) => a.alert_type === "acceleration")).toBe(false);
  });
});

describe("matchAlerts — submitted", () => {
  it("fires submitted only on first snapshot for a submitter watch", () => {
    const w = watch({
      watch_type: "submitter",
      watch_value: "alice",
    });
    const first = matchAlerts(
      snap({ itemBy: "alice", isFirstSnapshot: true, pFrontPage6h: 0.1 }),
      [w],
    );
    const later = matchAlerts(
      snap({ itemBy: "alice", isFirstSnapshot: false, pFrontPage6h: 0.1 }),
      [w],
    );
    expect(first.some((a) => a.alert_type === "submitted")).toBe(true);
    expect(later.some((a) => a.alert_type === "submitted")).toBe(false);
  });

  it("does not fire submitted for non-submitter watches", () => {
    const out = matchAlerts(
      snap({ itemBy: "alice", isFirstSnapshot: true }),
      [watch({ watch_type: "item", watch_value: "42" })],
    );
    expect(out.some((a) => a.alert_type === "submitted")).toBe(false);
  });
});

describe("matchAlerts — non-matching watches", () => {
  it("ignores watches that do not match the item", () => {
    const out = matchAlerts(
      snap({ itemId: 42, pFrontPage6h: 0.99 }),
      [watch({ watch_type: "item", watch_value: "999" })],
    );
    expect(out).toHaveLength(0);
  });

  it("emits at most one alert per (user, alert_type) when multiple watches match", () => {
    const out = matchAlerts(
      snap({
        itemId: 42,
        itemBy: "alice",
        itemDomain: "example.com",
        pFrontPage6h: 0.99,
      }),
      [
        watch({ id: "w-1", watch_type: "item", watch_value: "42" }),
        watch({
          id: "w-2",
          watch_type: "domain",
          watch_value: "example.com",
        }),
      ],
    );
    const thresholds = out.filter((a) => a.alert_type === "threshold");
    expect(thresholds).toHaveLength(1);
  });
});
