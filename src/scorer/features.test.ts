import { afterEach, describe, expect, it } from "vitest";
import {
  authorKarmaBucket,
  clearDomainReputationCache,
  DEFAULT_DOMAIN_REPUTATION,
  extractFeatures,
  getDomainReputation,
  setDomainReputation,
  type FeatureItemInput,
  type FeatureSnapshotInput,
} from "./features.js";

const POSTED_AT = new Date("2026-05-07T13:00:00Z");
const TAKEN_AT = new Date("2026-05-07T13:30:00Z");
const PREV_TAKEN_AT = new Date("2026-05-07T13:25:00Z");

function makeItem(overrides: Partial<FeatureItemInput> = {}): FeatureItemInput {
  return {
    posted_at: POSTED_AT,
    url: "https://example.com/post",
    title: "An ordinary submission",
    by: "alice",
    author_karma: 250,
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<FeatureSnapshotInput> = {},
): FeatureSnapshotInput {
  return {
    taken_at: TAKEN_AT,
    score: 12,
    comments: 3,
    ...overrides,
  };
}

afterEach(() => {
  clearDomainReputationCache();
});

describe("extractFeatures", () => {
  it("populates raw counts from the current snapshot", () => {
    const f = extractFeatures(
      makeItem(),
      makeSnapshot({ score: 42, comments: 7 }),
    );
    expect(f.upvotes).toBe(42);
    expect(f.comments).toBe(7);
  });

  it("treats null score and comments as zero", () => {
    const f = extractFeatures(
      makeItem(),
      makeSnapshot({ score: null, comments: null }),
    );
    expect(f.upvotes).toBe(0);
    expect(f.comments).toBe(0);
  });

  it("computes age_minutes between posted_at and current snapshot", () => {
    const f = extractFeatures(makeItem(), makeSnapshot());
    expect(f.age_minutes).toBe(30);
  });

  it("clamps age_minutes to >= 0 when taken_at precedes posted_at", () => {
    const f = extractFeatures(
      makeItem({ posted_at: new Date("2026-05-07T14:00:00Z") }),
      makeSnapshot({ taken_at: new Date("2026-05-07T13:00:00Z") }),
    );
    expect(f.age_minutes).toBe(0);
  });

  it("computes per-minute score and comment velocity vs previous snapshot", () => {
    const f = extractFeatures(
      makeItem(),
      makeSnapshot({ score: 20, comments: 8 }),
      { taken_at: PREV_TAKEN_AT, score: 10, comments: 3 },
    );
    expect(f.score_velocity).toBe(2);
    expect(f.comment_velocity).toBe(1);
  });

  it("returns velocity=0 when previous snapshot is missing", () => {
    const f = extractFeatures(makeItem(), makeSnapshot({ score: 99 }));
    expect(f.score_velocity).toBe(0);
    expect(f.comment_velocity).toBe(0);
  });

  it("returns velocity=0 when previous snapshot is explicitly null", () => {
    const f = extractFeatures(makeItem(), makeSnapshot({ score: 99 }), null);
    expect(f.score_velocity).toBe(0);
    expect(f.comment_velocity).toBe(0);
  });

  it("treats null counts in either snapshot as zero for velocity", () => {
    const f = extractFeatures(
      makeItem(),
      makeSnapshot({ score: 5, comments: 4 }),
      { taken_at: PREV_TAKEN_AT, score: null, comments: null },
    );
    expect(f.score_velocity).toBe(1);
    expect(f.comment_velocity).toBe(0.8);
  });

  it("returns velocity=0 when delta-t is zero or negative", () => {
    const f = extractFeatures(
      makeItem(),
      makeSnapshot({ score: 5, comments: 5 }),
      { taken_at: TAKEN_AT, score: 1, comments: 1 },
    );
    expect(f.score_velocity).toBe(0);
    expect(f.comment_velocity).toBe(0);
  });

  it("derives posting_hour_utc and day_of_week from posted_at", () => {
    const f = extractFeatures(
      makeItem({ posted_at: new Date("2026-05-08T07:15:00Z") }),
      makeSnapshot({ taken_at: new Date("2026-05-08T07:30:00Z") }),
    );
    expect(f.posting_hour_utc).toBe(7);
    expect(f.day_of_week).toBe(5);
  });

  it("extracts domain from the item URL", () => {
    const f = extractFeatures(
      makeItem({ url: "https://blog.example.org/path?x=1" }),
      makeSnapshot(),
    );
    expect(f.domain).toBe("blog.example.org");
  });

  it("returns null domain for missing or malformed URLs", () => {
    expect(extractFeatures(makeItem({ url: null }), makeSnapshot()).domain)
      .toBeNull();
    expect(
      extractFeatures(makeItem({ url: "not a url" }), makeSnapshot()).domain,
    ).toBeNull();
  });

  it("looks up domain_reputation via the cache, defaulting to 0", () => {
    setDomainReputation("blog.example.org", 0.85);
    const f = extractFeatures(
      makeItem({ url: "https://blog.example.org/x" }),
      makeSnapshot(),
    );
    expect(f.domain_reputation).toBeCloseTo(0.85);

    const unknown = extractFeatures(
      makeItem({ url: "https://nowhere.test/" }),
      makeSnapshot(),
    );
    expect(unknown.domain_reputation).toBe(DEFAULT_DOMAIN_REPUTATION);
    expect(unknown.domain_reputation).toBe(0);
  });

  it("uses default reputation when domain is null", () => {
    const f = extractFeatures(makeItem({ url: null }), makeSnapshot());
    expect(f.domain_reputation).toBe(0);
  });

  it("computes title_length as the character count", () => {
    const f = extractFeatures(
      makeItem({ title: "Hello, world" }),
      makeSnapshot(),
    );
    expect(f.title_length).toBe(12);
  });

  it("treats null title as length 0", () => {
    const f = extractFeatures(makeItem({ title: null }), makeSnapshot());
    expect(f.title_length).toBe(0);
    expect(f.has_show_hn).toBe(false);
    expect(f.has_ask_hn).toBe(false);
  });

  it("detects has_show_hn case-insensitively as a title prefix", () => {
    expect(
      extractFeatures(
        makeItem({ title: "Show HN: My side project" }),
        makeSnapshot(),
      ).has_show_hn,
    ).toBe(true);
    expect(
      extractFeatures(
        makeItem({ title: "show hn: lowercase variant" }),
        makeSnapshot(),
      ).has_show_hn,
    ).toBe(true);
    expect(
      extractFeatures(
        makeItem({ title: "SHOW HN: shouty caps" }),
        makeSnapshot(),
      ).has_show_hn,
    ).toBe(true);
    expect(
      extractFeatures(
        makeItem({ title: "Showing how to build X" }),
        makeSnapshot(),
      ).has_show_hn,
    ).toBe(false);
    expect(
      extractFeatures(
        makeItem({ title: "Notes on Show HN: regret" }),
        makeSnapshot(),
      ).has_show_hn,
    ).toBe(false);
  });

  it("detects has_ask_hn case-insensitively as a title prefix", () => {
    expect(
      extractFeatures(
        makeItem({ title: "Ask HN: How do you sleep?" }),
        makeSnapshot(),
      ).has_ask_hn,
    ).toBe(true);
    expect(
      extractFeatures(
        makeItem({ title: "ask hn: lowercase" }),
        makeSnapshot(),
      ).has_ask_hn,
    ).toBe(true);
    expect(
      extractFeatures(
        makeItem({ title: "ASK HN: caps" }),
        makeSnapshot(),
      ).has_ask_hn,
    ).toBe(true);
    expect(
      extractFeatures(
        makeItem({ title: "Asking the community" }),
        makeSnapshot(),
      ).has_ask_hn,
    ).toBe(false);
    expect(
      extractFeatures(
        makeItem({ title: "Should I Ask HN: about this?" }),
        makeSnapshot(),
      ).has_ask_hn,
    ).toBe(false);
  });

  it("buckets author karma into the expected tiers", () => {
    expect(extractFeatures(makeItem({ author_karma: null }), makeSnapshot())
      .author_karma_bucket).toBe("unknown");
    expect(extractFeatures(makeItem({ author_karma: undefined }), makeSnapshot())
      .author_karma_bucket).toBe("unknown");
    expect(extractFeatures(makeItem({ author_karma: 0 }), makeSnapshot())
      .author_karma_bucket).toBe("newbie");
    expect(extractFeatures(makeItem({ author_karma: 99 }), makeSnapshot())
      .author_karma_bucket).toBe("newbie");
    expect(extractFeatures(makeItem({ author_karma: 100 }), makeSnapshot())
      .author_karma_bucket).toBe("low");
    expect(extractFeatures(makeItem({ author_karma: 999 }), makeSnapshot())
      .author_karma_bucket).toBe("low");
    expect(extractFeatures(makeItem({ author_karma: 1000 }), makeSnapshot())
      .author_karma_bucket).toBe("mid");
    expect(extractFeatures(makeItem({ author_karma: 9999 }), makeSnapshot())
      .author_karma_bucket).toBe("mid");
    expect(extractFeatures(makeItem({ author_karma: 10000 }), makeSnapshot())
      .author_karma_bucket).toBe("high");
  });

  it("is pure and deterministic — repeated calls return equal rows", () => {
    const item = makeItem();
    const snap = makeSnapshot();
    const prev = { taken_at: PREV_TAKEN_AT, score: 5, comments: 1 };
    const a = extractFeatures(item, snap, prev);
    const b = extractFeatures(item, snap, prev);
    expect(a).toEqual(b);
  });
});

describe("authorKarmaBucket", () => {
  it("classifies known thresholds", () => {
    expect(authorKarmaBucket(undefined)).toBe("unknown");
    expect(authorKarmaBucket(null)).toBe("unknown");
    expect(authorKarmaBucket(NaN)).toBe("unknown");
    expect(authorKarmaBucket(50)).toBe("newbie");
    expect(authorKarmaBucket(500)).toBe("low");
    expect(authorKarmaBucket(5000)).toBe("mid");
    expect(authorKarmaBucket(50000)).toBe("high");
  });
});

describe("domain reputation cache", () => {
  afterEach(() => {
    clearDomainReputationCache();
  });

  it("returns the default for unset domains", () => {
    expect(getDomainReputation("anywhere.test")).toBe(DEFAULT_DOMAIN_REPUTATION);
  });

  it("returns set values and clears on demand", () => {
    setDomainReputation("good.test", 0.9);
    expect(getDomainReputation("good.test")).toBeCloseTo(0.9);
    clearDomainReputationCache();
    expect(getDomainReputation("good.test")).toBe(DEFAULT_DOMAIN_REPUTATION);
  });

  it("returns the default for null domain", () => {
    expect(getDomainReputation(null)).toBe(DEFAULT_DOMAIN_REPUTATION);
  });
});
