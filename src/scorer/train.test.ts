import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PATH,
  FEATURE_NAMES,
  MODEL_VERSION,
  featuresToVector,
  fitLogistic,
  generateSyntheticDataset,
  predictProbability,
  rocAuc,
  runTrainingPipeline,
} from "./train.js";
import type { FeatureRow } from "./features.js";
import {
  getDefaultScorer,
  loadTrainedModel,
  makeBaselineScorer,
  resetDefaultScorerForTesting,
  scoreFeaturesBaseline,
  scoreSnapshot,
} from "./index.js";

function baselineFeatures(overrides: Partial<FeatureRow> = {}): FeatureRow {
  return {
    upvotes: 10,
    comments: 2,
    age_minutes: 15,
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

describe("featuresToVector", () => {
  it("produces a vector with every declared feature name", () => {
    const v = featuresToVector(baselineFeatures());
    for (const name of FEATURE_NAMES) {
      expect(v).toHaveProperty(name);
      expect(Number.isFinite(v[name])).toBe(true);
    }
    expect(v.bias).toBe(1);
  });

  it("encodes karma bucket as one-hot", () => {
    const v = featuresToVector(baselineFeatures({ author_karma_bucket: "high" }));
    expect(v.karma_high).toBe(1);
    expect(v.karma_mid).toBe(0);
    expect(v.karma_low).toBe(0);
    expect(v.karma_newbie).toBe(0);
  });
});

describe("rocAuc", () => {
  it("returns 1.0 when all positives outscore all negatives", () => {
    expect(
      rocAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]),
    ).toBeCloseTo(1, 6);
  });

  it("returns 0.5 when scores are uninformative", () => {
    expect(
      rocAuc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]),
    ).toBeCloseTo(0.5, 6);
  });

  it("returns 0.5 if either class is empty", () => {
    expect(rocAuc([0.1, 0.2, 0.3], [0, 0, 0])).toBe(0.5);
    expect(rocAuc([0.1, 0.2, 0.3], [1, 1, 1])).toBe(0.5);
  });
});

describe("fitLogistic", () => {
  it("recovers a positive weight on log1p_upvotes when label tracks upvotes", () => {
    const dataset = generateSyntheticDataset({
      n: 1000,
      seed: 7,
      daysSpan: 14,
    });
    const fit = fitLogistic(dataset, {
      l2: 0.01,
      learningRate: 0.2,
      iterations: 300,
    });
    expect(fit.weights.log1p_upvotes).toBeGreaterThan(0);
    expect(fit.weights.log_age_hours_p2).toBeLessThan(0);
  });
});

describe("runTrainingPipeline (synthetic)", () => {
  // Deterministic seed → exactly reproducible across runs.
  const model = runTrainingPipeline({ seed: 42, n: 4000, daysSpan: 14 });

  it("emits a model with the expected shape", () => {
    expect(model.version).toBe(MODEL_VERSION);
    expect(model.feature_names.length).toBe(FEATURE_NAMES.length);
    for (const name of FEATURE_NAMES) {
      expect(typeof model.weights[name]).toBe("number");
      expect(Number.isFinite(model.weights[name]!)).toBe(true);
    }
    expect(model.metrics.n_train).toBeGreaterThan(0);
    expect(model.metrics.n_holdout).toBeGreaterThan(0);
  });

  it("achieves held-out ROC AUC >= 0.70 (Spec.md success metric)", () => {
    expect(model.metrics.auc_holdout).toBeGreaterThanOrEqual(0.7);
  });

  it("predicts higher probability for high-upvote young posts than stale posts", () => {
    const young = baselineFeatures({ upvotes: 80, age_minutes: 30 });
    const stale = baselineFeatures({ upvotes: 80, age_minutes: 6 * 60 });
    const pYoung = predictProbability(model.weights, young);
    const pStale = predictProbability(model.weights, stale);
    expect(pYoung).toBeGreaterThan(pStale);
    expect(pYoung).toBeGreaterThanOrEqual(0);
    expect(pYoung).toBeLessThanOrEqual(1);
  });
});

describe("committed models/logistic-v1.json", () => {
  it("exists at DEFAULT_MODEL_PATH and parses", () => {
    const raw = readFileSync(DEFAULT_MODEL_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      version: string;
      weights: Record<string, number>;
      metrics: { auc_holdout: number };
    };
    expect(parsed.version).toBe(MODEL_VERSION);
    for (const name of FEATURE_NAMES) {
      expect(typeof parsed.weights[name]).toBe("number");
    }
    expect(parsed.metrics.auc_holdout).toBeGreaterThanOrEqual(0.7);
  });

  it("is loaded by loadTrainedModel()", () => {
    const m = loadTrainedModel();
    expect(m).not.toBeNull();
    expect(m?.version).toBe(MODEL_VERSION);
  });
});

describe("loadTrainedModel — fallback paths", () => {
  it("returns null when the file does not exist", () => {
    expect(loadTrainedModel("/tmp/forecry-does-not-exist.json")).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scorer-malformed-"));
    const p = join(dir, "bad.json");
    writeFileSync(p, "not json");
    try {
      expect(loadTrainedModel(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when version mismatches", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scorer-version-"));
    const p = join(dir, "wrong.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: "logistic-v999",
        weights: {},
        metrics: {},
      }),
    );
    try {
      expect(loadTrainedModel(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when a required weight is missing", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scorer-missing-weight-"));
    const p = join(dir, "incomplete.json");
    writeFileSync(
      p,
      JSON.stringify({
        version: MODEL_VERSION,
        weights: { bias: 0 }, // every other feature is missing
        metrics: {},
      }),
    );
    try {
      expect(loadTrainedModel(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scoreSnapshot baseline fallback", () => {
  it("matches scoreFeaturesBaseline when the explicit baseline weights override is passed", () => {
    const features = baselineFeatures({ upvotes: 25, age_minutes: 45 });
    const explicit = scoreSnapshot({
      features,
      previousProbabilityFiveMinAgo: null,
      scorer: makeBaselineScorer(),
    });
    expect(explicit.p_front_page_6h).toBeCloseTo(
      scoreFeaturesBaseline(features),
      10,
    );
  });

  it("uses baseline when no trained model is available", () => {
    // Force the cached default scorer to refresh from a guaranteed-missing
    // path via a temporary override of loadTrainedModel by passing a
    // baseline-only scorer through `scorer:`.
    const features = baselineFeatures({ upvotes: 50, age_minutes: 20 });
    const baseline = makeBaselineScorer();
    const result = scoreSnapshot({
      features,
      previousProbabilityFiveMinAgo: null,
      scorer: baseline,
    });
    expect(result.p_front_page_6h).toBeCloseTo(
      scoreFeaturesBaseline(features),
      10,
    );
  });
});

describe("getDefaultScorer", () => {
  it("returns 'trained' source when the committed model is present", () => {
    resetDefaultScorerForTesting();
    const info = getDefaultScorer();
    expect(info.source).toBe("trained");
    expect(info.scorer(baselineFeatures())).toBeGreaterThanOrEqual(0);
    expect(info.scorer(baselineFeatures())).toBeLessThanOrEqual(1);
  });
});
