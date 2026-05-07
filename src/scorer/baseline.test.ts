import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASELINE_WEIGHTS,
  scoreFeaturesBaseline,
} from "./baseline.js";
import type { FeatureRow } from "./features.js";

function makeFeatures(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return {
    upvotes: 0,
    comments: 0,
    age_minutes: 0,
    score_velocity: 0,
    comment_velocity: 0,
    posting_hour_utc: 12,
    day_of_week: 3,
    domain: null,
    domain_reputation: 0,
    title_length: 30,
    has_show_hn: false,
    has_ask_hn: false,
    author_karma_bucket: "unknown",
    ...overrides,
  };
}

describe("scoreFeaturesBaseline", () => {
  it("returns a probability in [0, 1] for a brand-new submission", () => {
    const p = scoreFeaturesBaseline(makeFeatures());
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("returns a probability in [0, 1] for a wide range of inputs", () => {
    const cases: Array<Partial<FeatureRow>> = [
      { upvotes: 0, age_minutes: 0 },
      { upvotes: 1, age_minutes: 1 },
      { upvotes: 50, age_minutes: 30, score_velocity: 2, comments: 12 },
      { upvotes: 500, age_minutes: 360, comments: 200 },
      { upvotes: 1, age_minutes: 360 },
      { upvotes: 9999, age_minutes: 1 },
      { upvotes: 0, age_minutes: 100, score_velocity: 0 },
      {
        upvotes: 30,
        age_minutes: 45,
        comments: 5,
        domain_reputation: 0.95,
        author_karma_bucket: "high",
        has_show_hn: true,
      },
    ];
    for (const c of cases) {
      const p = scoreFeaturesBaseline(makeFeatures(c));
      expect(p, JSON.stringify(c)).toBeGreaterThanOrEqual(0);
      expect(p, JSON.stringify(c)).toBeLessThanOrEqual(1);
      expect(Number.isFinite(p)).toBe(true);
    }
  });

  it("applies the published HN ranking weight ~1.8 on log(upvotes)", () => {
    expect(DEFAULT_BASELINE_WEIGHTS.log1p_upvotes).toBeCloseTo(1.8, 5);
  });

  it("applies a strong age penalty (negative coefficient on log age)", () => {
    expect(DEFAULT_BASELINE_WEIGHTS.age_log_hours).toBeLessThan(-1);
  });

  it("higher upvotes increases probability with everything else fixed", () => {
    const low = scoreFeaturesBaseline(
      makeFeatures({ upvotes: 1, age_minutes: 30 }),
    );
    const high = scoreFeaturesBaseline(
      makeFeatures({ upvotes: 80, age_minutes: 30 }),
    );
    expect(high).toBeGreaterThan(low);
  });

  it("older posts score lower than younger posts at equal upvotes", () => {
    const fresh = scoreFeaturesBaseline(
      makeFeatures({ upvotes: 25, age_minutes: 30 }),
    );
    const stale = scoreFeaturesBaseline(
      makeFeatures({ upvotes: 25, age_minutes: 6 * 60 }),
    );
    expect(fresh).toBeGreaterThan(stale);
  });

  it("score velocity adds signal", () => {
    const flat = scoreFeaturesBaseline(
      makeFeatures({ upvotes: 10, age_minutes: 20, score_velocity: 0 }),
    );
    const climbing = scoreFeaturesBaseline(
      makeFeatures({ upvotes: 10, age_minutes: 20, score_velocity: 5 }),
    );
    expect(climbing).toBeGreaterThan(flat);
  });

  it("clamps invalid sigmoid inputs to a probability in [0,1]", () => {
    const p = scoreFeaturesBaseline(
      makeFeatures({
        upvotes: Number.POSITIVE_INFINITY,
        age_minutes: 0,
      }),
    );
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it("is deterministic (same input → same output)", () => {
    const f = makeFeatures({ upvotes: 17, age_minutes: 22 });
    expect(scoreFeaturesBaseline(f)).toBe(scoreFeaturesBaseline(f));
  });
});
