import type { AuthorKarmaBucket, FeatureRow } from "./features.js";

export interface BaselineWeights {
  bias: number;
  log1p_upvotes: number;
  age_log_hours: number;
  log1p_score_velocity: number;
  log1p_comments: number;
  log1p_comment_velocity: number;
  domain_reputation: number;
  show_hn: number;
  ask_hn: number;
  karma_newbie: number;
  karma_low: number;
  karma_mid: number;
  karma_high: number;
}

// HN's ranking algorithm is roughly (P-1) / (T+2)^G with G ≈ 1.8.
// The published exponent is ~1.8 → coefficient on log(upvotes), and a
// matching strong negative on log(age+2h) for the age penalty. Velocity,
// comments, domain rep and karma supply secondary signal until the real
// model lands in p1-004.
export const DEFAULT_BASELINE_WEIGHTS: BaselineWeights = {
  bias: -3.5,
  log1p_upvotes: 1.8,
  age_log_hours: -1.8,
  log1p_score_velocity: 1.0,
  log1p_comments: 0.4,
  log1p_comment_velocity: 0.6,
  domain_reputation: 0.8,
  show_hn: 0.3,
  ask_hn: 0.1,
  karma_newbie: -0.2,
  karma_low: 0.0,
  karma_mid: 0.2,
  karma_high: 0.4,
};

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function safeLog1p(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.log1p(x);
}

function karmaBoost(bucket: AuthorKarmaBucket, w: BaselineWeights): number {
  switch (bucket) {
    case "newbie":
      return w.karma_newbie;
    case "low":
      return w.karma_low;
    case "mid":
      return w.karma_mid;
    case "high":
      return w.karma_high;
    case "unknown":
    default:
      return 0;
  }
}

export function scoreFeaturesBaseline(
  features: FeatureRow,
  weights: BaselineWeights = DEFAULT_BASELINE_WEIGHTS,
): number {
  const ageHours = Math.max(0, features.age_minutes) / 60;
  const z =
    weights.bias +
    weights.log1p_upvotes * safeLog1p(features.upvotes) +
    weights.age_log_hours * Math.log(2 + ageHours) +
    weights.log1p_score_velocity * safeLog1p(features.score_velocity) +
    weights.log1p_comments * safeLog1p(features.comments) +
    weights.log1p_comment_velocity * safeLog1p(features.comment_velocity) +
    weights.domain_reputation * features.domain_reputation +
    (features.has_show_hn ? weights.show_hn : 0) +
    (features.has_ask_hn ? weights.ask_hn : 0) +
    karmaBoost(features.author_karma_bucket, weights);
  return clamp01(sigmoid(z));
}
