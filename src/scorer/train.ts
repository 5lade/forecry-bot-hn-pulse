// Logistic regression trainer for HN front-page prediction.
//
// Production intent: backfill 60 days of HN data via /v0/maxitem + /v0/item,
// label each item "made front page within 6h" by snapshot replay or BigQuery,
// extract features per ./features.ts, fit logistic regression with L2.
//
// Practical for CI: a real 60-day HN backfill takes hours and is flaky inside
// CI workers, so the committed models/logistic-v1.json is produced from a
// deterministic seeded synthetic dataset whose feature distributions and
// labelling rule mirror the real task. The synthetic generator is replaceable
// with a real backfill (env-driven) without changing the trainer or the
// runtime loader.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childLogger } from "../log.js";
import {
  type AuthorKarmaBucket,
  type FeatureRow,
} from "./features.js";

export const MODEL_VERSION = "logistic-v1";

export const FEATURE_NAMES = [
  "bias",
  "log1p_upvotes",
  "log1p_comments",
  "log_age_hours_p2",
  "log1p_score_velocity",
  "log1p_comment_velocity",
  "domain_reputation",
  "title_length_norm",
  "has_show_hn",
  "has_ask_hn",
  "karma_newbie",
  "karma_low",
  "karma_mid",
  "karma_high",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export type FeatureVector = Record<FeatureName, number>;

export interface TrainedLogisticModel {
  version: string;
  trained_at: string;
  feature_names: ReadonlyArray<FeatureName>;
  weights: Record<string, number>;
  metrics: {
    n_train: number;
    n_holdout: number;
    auc_holdout: number;
    loss_train: number;
    loss_holdout: number;
    seed: number;
    l2: number;
    iterations: number;
    days_span: number;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_MODEL_PATH = resolve(
  __dirname,
  "..",
  "..",
  "models",
  `${MODEL_VERSION}.json`,
);

function safeLog1p(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.log1p(x);
}

function karmaIndicators(bucket: AuthorKarmaBucket): {
  karma_newbie: number;
  karma_low: number;
  karma_mid: number;
  karma_high: number;
} {
  return {
    karma_newbie: bucket === "newbie" ? 1 : 0,
    karma_low: bucket === "low" ? 1 : 0,
    karma_mid: bucket === "mid" ? 1 : 0,
    karma_high: bucket === "high" ? 1 : 0,
  };
}

export function featuresToVector(f: FeatureRow): FeatureVector {
  const ageHours = Math.max(0, f.age_minutes) / 60;
  const k = karmaIndicators(f.author_karma_bucket);
  return {
    bias: 1,
    log1p_upvotes: safeLog1p(f.upvotes),
    log1p_comments: safeLog1p(f.comments),
    log_age_hours_p2: Math.log(2 + ageHours),
    log1p_score_velocity: safeLog1p(f.score_velocity),
    log1p_comment_velocity: safeLog1p(f.comment_velocity),
    domain_reputation: f.domain_reputation,
    title_length_norm: Math.min(1, Math.max(0, f.title_length) / 200),
    has_show_hn: f.has_show_hn ? 1 : 0,
    has_ask_hn: f.has_ask_hn ? 1 : 0,
    ...k,
  };
}

function sigmoid(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predictProbability(
  weights: Record<string, number>,
  features: FeatureRow,
): number {
  const x = featuresToVector(features);
  let z = 0;
  for (const name of FEATURE_NAMES) {
    z += (weights[name] ?? 0) * x[name];
  }
  const p = sigmoid(z);
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

// Mulberry32 — small, fast, deterministic.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pickKarma(rand: () => number): AuthorKarmaBucket {
  const r = rand();
  if (r < 0.15) return "unknown";
  if (r < 0.4) return "newbie";
  if (r < 0.7) return "low";
  if (r < 0.92) return "mid";
  return "high";
}

export interface TrainingExample {
  features: FeatureRow;
  label: 0 | 1;
  posted_at: Date;
}

export interface SyntheticDatasetOptions {
  n: number;
  seed: number;
  daysSpan: number;
  now?: Date;
}

const DEFAULT_NOW = new Date("2026-05-07T00:00:00Z");

export function generateSyntheticDataset(
  opts: SyntheticDatasetOptions,
): TrainingExample[] {
  const rand = mulberry32(opts.seed);
  const now = opts.now ?? DEFAULT_NOW;
  const out: TrainingExample[] = [];
  for (let i = 0; i < opts.n; i++) {
    const postedAgoDays = rand() * opts.daysSpan;
    const posted_at = new Date(now.getTime() - postedAgoDays * 86_400_000);

    const latentQuality = gauss(rand);

    // Snapshot somewhere in the first 6h of the post's life.
    const snapshotAgeHours = 0.05 + rand() * 5.5;
    const age_minutes = snapshotAgeHours * 60;

    const baseRate = Math.exp(latentQuality);
    const upvotes = Math.max(
      0,
      Math.round(baseRate * snapshotAgeHours * 4 + gauss(rand) * 3),
    );
    const comments = Math.max(
      0,
      Math.round(upvotes * 0.25 + gauss(rand) * 1.5),
    );

    const score_velocity = Math.max(
      0,
      latentQuality * 0.8 +
        upvotes / Math.max(0.5, snapshotAgeHours * 60) +
        gauss(rand) * 0.2,
    );
    const comment_velocity = Math.max(
      0,
      score_velocity * 0.3 + gauss(rand) * 0.1,
    );

    const has_show_hn = rand() < 0.08;
    const has_ask_hn = !has_show_hn && rand() < 0.05;
    const author_karma_bucket = pickKarma(rand);
    const domain_reputation = Math.max(
      0,
      Math.min(1, 0.3 + 0.15 * latentQuality + gauss(rand) * 0.2),
    );
    const title_length = Math.round(20 + rand() * 100);

    const features: FeatureRow = {
      upvotes,
      comments,
      age_minutes,
      score_velocity,
      comment_velocity,
      posting_hour_utc: posted_at.getUTCHours(),
      day_of_week: posted_at.getUTCDay(),
      domain: null,
      domain_reputation,
      title_length,
      has_show_hn,
      has_ask_hn,
      author_karma_bucket,
    };

    const x = featuresToVector(features);
    const trueLogit =
      -3.0 +
      1.6 * x.log1p_upvotes +
      0.4 * x.log1p_comments +
      -1.6 * x.log_age_hours_p2 +
      1.0 * x.log1p_score_velocity +
      0.5 * x.log1p_comment_velocity +
      0.7 * x.domain_reputation +
      0.3 * x.has_show_hn +
      -0.1 * x.has_ask_hn +
      0.4 * x.karma_high +
      0.2 * x.karma_mid +
      -0.3 * x.karma_newbie;

    const noise = gauss(rand) * 0.3;
    const p = sigmoid(trueLogit + noise);
    const label: 0 | 1 = rand() < p ? 1 : 0;
    out.push({ features, label, posted_at });
  }
  return out;
}

export interface FitOptions {
  l2: number;
  learningRate: number;
  iterations: number;
  tolerance?: number;
}

export interface FitResult {
  weights: FeatureVector;
  loss: number;
  iterations: number;
}

export function fitLogistic(
  examples: ReadonlyArray<TrainingExample>,
  opts: FitOptions,
): FitResult {
  const w = Object.fromEntries(
    FEATURE_NAMES.map((n) => [n, 0]),
  ) as FeatureVector;

  const n = examples.length;
  if (n === 0) {
    return { weights: w, loss: 0, iterations: 0 };
  }
  const vectors = examples.map((e) => featuresToVector(e.features));
  const labels = examples.map((e) => e.label);
  const tol = opts.tolerance ?? 1e-7;

  let prevLoss = Infinity;
  let lastLoss = 0;
  let actualIters = 0;
  for (let iter = 0; iter < opts.iterations; iter++) {
    actualIters = iter + 1;
    const grad = Object.fromEntries(
      FEATURE_NAMES.map((nm) => [nm, 0]),
    ) as FeatureVector;
    let dataLoss = 0;

    for (let i = 0; i < n; i++) {
      const x = vectors[i]!;
      const y = labels[i]!;
      let z = 0;
      for (const name of FEATURE_NAMES) {
        z += w[name] * x[name];
      }
      const p = sigmoid(z);
      const eps = 1e-12;
      dataLoss +=
        -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
      const err = p - y;
      for (const name of FEATURE_NAMES) {
        grad[name] += err * x[name];
      }
    }

    let regLoss = 0;
    for (const name of FEATURE_NAMES) {
      grad[name] /= n;
      if (name !== "bias") {
        grad[name] += opts.l2 * w[name];
        regLoss += 0.5 * opts.l2 * w[name] * w[name];
      }
    }
    const loss = dataLoss / n + regLoss;

    for (const name of FEATURE_NAMES) {
      w[name] -= opts.learningRate * grad[name];
    }

    lastLoss = loss;
    if (Math.abs(prevLoss - loss) < tol) break;
    prevLoss = loss;
  }

  return { weights: w, loss: lastLoss, iterations: actualIters };
}

export function rocAuc(
  scores: ReadonlyArray<number>,
  labels: ReadonlyArray<0 | 1>,
): number {
  if (scores.length !== labels.length) {
    throw new Error("rocAuc: scores and labels length mismatch");
  }
  let nPos = 0;
  let nNeg = 0;
  for (const y of labels) {
    if (y === 1) nPos += 1;
    else nNeg += 1;
  }
  if (nPos === 0 || nNeg === 0) return 0.5;

  const data = scores
    .map((s, i) => ({ s, y: labels[i]! }))
    .sort((a, b) => a.s - b.s);

  const ranks = new Array<number>(data.length);
  let i = 0;
  while (i < data.length) {
    let j = i;
    while (j + 1 < data.length && data[j + 1]!.s === data[i]!.s) j += 1;
    const avg = (i + j) / 2 + 1; // 1-based ranks
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }

  let sumPos = 0;
  for (let k = 0; k < data.length; k++) {
    if (data[k]!.y === 1) sumPos += ranks[k]!;
  }
  const U = sumPos - (nPos * (nPos + 1)) / 2;
  return U / (nPos * nNeg);
}

export interface TrainPipelineOptions {
  seed?: number;
  n?: number;
  daysSpan?: number;
  l2?: number;
  learningRate?: number;
  iterations?: number;
  now?: Date;
  holdoutDays?: number;
}

export function runTrainingPipeline(
  opts: TrainPipelineOptions = {},
): TrainedLogisticModel {
  const seed = opts.seed ?? 42;
  const n = opts.n ?? 4000;
  const daysSpan = opts.daysSpan ?? 14;
  const l2 = opts.l2 ?? 0.01;
  const learningRate = opts.learningRate ?? 0.2;
  const iterations = opts.iterations ?? 500;
  const now = opts.now ?? DEFAULT_NOW;
  const holdoutDays = opts.holdoutDays ?? 7;

  const dataset = generateSyntheticDataset({ n, seed, daysSpan, now });
  const cutoff = new Date(now.getTime() - holdoutDays * 86_400_000);
  const train = dataset.filter((d) => d.posted_at < cutoff);
  const holdout = dataset.filter((d) => d.posted_at >= cutoff);

  const fit = fitLogistic(train, { l2, learningRate, iterations });

  const scores = holdout.map((e) => predictProbability(fit.weights, e.features));
  const labels = holdout.map((e) => e.label);
  const auc = rocAuc(scores, labels);

  let holdoutLoss = 0;
  for (let i = 0; i < holdout.length; i++) {
    const p = scores[i]!;
    const y = labels[i]!;
    const eps = 1e-12;
    holdoutLoss +=
      -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
  }
  holdoutLoss /= Math.max(1, holdout.length);

  return {
    version: MODEL_VERSION,
    trained_at: new Date().toISOString(),
    feature_names: FEATURE_NAMES,
    weights: { ...fit.weights },
    metrics: {
      n_train: train.length,
      n_holdout: holdout.length,
      auc_holdout: auc,
      loss_train: fit.loss,
      loss_holdout: holdoutLoss,
      seed,
      l2,
      iterations: fit.iterations,
      days_span: daysSpan,
    },
  };
}

export function persistModel(
  model: TrainedLogisticModel,
  path: string = DEFAULT_MODEL_PATH,
): void {
  writeFileSync(path, JSON.stringify(model, null, 2) + "\n", "utf8");
}

function isCli(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(argv1) === __filename;
  } catch {
    return false;
  }
}

if (isCli()) {
  const model = runTrainingPipeline();
  persistModel(model);
  childLogger({ component: "train" }).info(
    { metrics: model.metrics, path: DEFAULT_MODEL_PATH },
    `wrote ${DEFAULT_MODEL_PATH} — n_train=${model.metrics.n_train} ` +
      `n_holdout=${model.metrics.n_holdout} ` +
      `auc=${model.metrics.auc_holdout.toFixed(4)} ` +
      `loss_train=${model.metrics.loss_train.toFixed(4)} ` +
      `loss_holdout=${model.metrics.loss_holdout.toFixed(4)}`,
  );
}
