import { readFileSync } from "node:fs";
import {
  getMostRecentSnapshotBefore,
  getSnapshotAtOrBefore,
  insertSnapshot,
  type ItemsQueryClient,
  type SnapshotLookupRow,
} from "../db/items.js";
import { childLogger } from "../log.js";
import {
  DEFAULT_BASELINE_WEIGHTS,
  scoreFeaturesBaseline,
  type BaselineWeights,
} from "./baseline.js";
import {
  extractFeatures,
  type FeatureItemInput,
  type FeatureRow,
  type FeatureSnapshotInput,
} from "./features.js";
import {
  DEFAULT_MODEL_PATH,
  FEATURE_NAMES,
  MODEL_VERSION,
  predictProbability,
  type TrainedLogisticModel,
} from "./train.js";

export {
  DEFAULT_BASELINE_WEIGHTS,
  scoreFeaturesBaseline,
  type BaselineWeights,
};

export const FIVE_MIN_MS = 5 * 60_000;

export type ScoringFn = (features: FeatureRow) => number;

export function makeBaselineScorer(
  weights: BaselineWeights = DEFAULT_BASELINE_WEIGHTS,
): ScoringFn {
  return (features) => scoreFeaturesBaseline(features, weights);
}

export function makeTrainedScorer(model: TrainedLogisticModel): ScoringFn {
  const weights = model.weights;
  return (features) => predictProbability(weights, features);
}

export function loadTrainedModel(
  path: string = DEFAULT_MODEL_PATH,
): TrainedLogisticModel | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== MODEL_VERSION) return null;
  const weights = obj.weights;
  if (!weights || typeof weights !== "object") return null;
  const w = weights as Record<string, unknown>;
  for (const name of FEATURE_NAMES) {
    const v = w[name];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  return parsed as TrainedLogisticModel;
}

let cachedDefaultScorer: ScoringFn | null = null;
let cachedDefaultSource: "trained" | "baseline" | null = null;

export interface DefaultScorerInfo {
  scorer: ScoringFn;
  source: "trained" | "baseline";
}

export function getDefaultScorer(): DefaultScorerInfo {
  if (cachedDefaultScorer == null || cachedDefaultSource == null) {
    const model = loadTrainedModel();
    if (model) {
      cachedDefaultScorer = makeTrainedScorer(model);
      cachedDefaultSource = "trained";
    } else {
      cachedDefaultScorer = makeBaselineScorer();
      cachedDefaultSource = "baseline";
    }
  }
  return { scorer: cachedDefaultScorer, source: cachedDefaultSource };
}

export function resetDefaultScorerForTesting(): void {
  cachedDefaultScorer = null;
  cachedDefaultSource = null;
}

export interface ScoreSnapshotArgs {
  features: FeatureRow;
  previousProbabilityFiveMinAgo: number | null;
  /**
   * If provided, score with the supplied baseline weights instead of the
   * default scorer (trained model when available, baseline otherwise).
   * Tests pass this to assert baseline behavior; the runtime path leaves it
   * undefined so the trained model takes effect.
   */
  weights?: BaselineWeights;
  /** Inject a custom scoring function (overrides weights). */
  scorer?: ScoringFn;
}

export interface ScoreSnapshotResult {
  p_front_page_6h: number;
  delta_p_5min: number;
}

export function scoreSnapshot(args: ScoreSnapshotArgs): ScoreSnapshotResult {
  let p: number;
  if (args.scorer) {
    p = args.scorer(args.features);
  } else if (args.weights) {
    p = scoreFeaturesBaseline(args.features, args.weights);
  } else {
    p = getDefaultScorer().scorer(args.features);
  }
  if (!Number.isFinite(p)) p = 0;
  if (p < 0) p = 0;
  if (p > 1) p = 1;
  const prev = args.previousProbabilityFiveMinAgo;
  const delta = prev == null || !Number.isFinite(prev) ? 0 : p - prev;
  return { p_front_page_6h: p, delta_p_5min: delta };
}

export interface ScoreAndInsertInput {
  item_id: number;
  posted_at: Date;
  url?: string | null;
  title?: string | null;
  by?: string | null;
  author_karma?: number | null;
  domain?: string | null;
  taken_at: Date;
  rank: number | null;
  score: number | null;
  comments: number | null;
}

export interface ScoreAndInsertResult extends ScoreSnapshotResult {
  features: FeatureRow;
  score_velocity: number;
  comment_velocity: number;
}

export interface SnapshotInsertedInfo {
  itemId: number;
  itemBy: string | null;
  itemDomain: string | null;
  pFrontPage6h: number;
  deltaP5min: number;
  isFirstSnapshot: boolean;
}

export type SnapshotInsertedHook = (
  info: SnapshotInsertedInfo,
) => Promise<void> | void;

export interface ScoreAndInsertOptions {
  weights?: BaselineWeights;
  onSnapshotInserted?: SnapshotInsertedHook;
}

function isOptionsArg(
  v: BaselineWeights | ScoreAndInsertOptions | undefined,
): v is ScoreAndInsertOptions {
  if (!v || typeof v !== "object") return false;
  return "weights" in v || "onSnapshotInserted" in v;
}

export async function scoreAndInsertSnapshot(
  client: ItemsQueryClient,
  input: ScoreAndInsertInput,
  weightsOrOptions?: BaselineWeights | ScoreAndInsertOptions,
): Promise<ScoreAndInsertResult> {
  const opts: ScoreAndInsertOptions = isOptionsArg(weightsOrOptions)
    ? weightsOrOptions
    : { weights: weightsOrOptions as BaselineWeights | undefined };
  const weights = opts.weights;

  const previous: SnapshotLookupRow | null =
    await getMostRecentSnapshotBefore(client, input.item_id, input.taken_at);

  const fiveMinCutoff = new Date(input.taken_at.getTime() - FIVE_MIN_MS);
  const fiveMinAgo: SnapshotLookupRow | null = await getSnapshotAtOrBefore(
    client,
    input.item_id,
    fiveMinCutoff,
  );

  const featureItem: FeatureItemInput = {
    posted_at: input.posted_at,
    url: input.url ?? null,
    title: input.title ?? null,
    by: input.by ?? null,
    author_karma: input.author_karma ?? null,
  };
  const currentSnap: FeatureSnapshotInput = {
    taken_at: input.taken_at,
    score: input.score,
    comments: input.comments,
  };
  const previousSnap: FeatureSnapshotInput | null = previous
    ? {
        taken_at: previous.taken_at,
        score: previous.score,
        comments: previous.comments,
      }
    : null;

  const features = extractFeatures(featureItem, currentSnap, previousSnap);
  const { p_front_page_6h, delta_p_5min } = scoreSnapshot({
    features,
    previousProbabilityFiveMinAgo: fiveMinAgo?.p_front_page_6h ?? null,
    weights,
  });

  await insertSnapshot(client, {
    item_id: input.item_id,
    taken_at: input.taken_at,
    rank: input.rank,
    score: input.score,
    comments: input.comments,
    score_velocity: features.score_velocity,
    comment_velocity: features.comment_velocity,
    p_front_page_6h,
    delta_p_5min,
  });

  childLogger({ component: "scorer", item_id: input.item_id }).debug(
    {
      taken_at: input.taken_at,
      p_front_page_6h,
      delta_p_5min,
      score: input.score,
      comments: input.comments,
    },
    "snapshot inserted",
  );

  if (opts.onSnapshotInserted) {
    await opts.onSnapshotInserted({
      itemId: input.item_id,
      itemBy: input.by ?? null,
      itemDomain: input.domain ?? null,
      pFrontPage6h: p_front_page_6h,
      deltaP5min: delta_p_5min,
      isFirstSnapshot: previous == null,
    });
  }

  return {
    features,
    p_front_page_6h,
    delta_p_5min,
    score_velocity: features.score_velocity,
    comment_velocity: features.comment_velocity,
  };
}
