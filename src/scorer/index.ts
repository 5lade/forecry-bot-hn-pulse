import {
  getMostRecentSnapshotBefore,
  getSnapshotAtOrBefore,
  insertSnapshot,
  type ItemsQueryClient,
  type SnapshotLookupRow,
} from "../db/items.js";
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

export {
  DEFAULT_BASELINE_WEIGHTS,
  scoreFeaturesBaseline,
  type BaselineWeights,
};

export const FIVE_MIN_MS = 5 * 60_000;

export interface ScoreSnapshotArgs {
  features: FeatureRow;
  previousProbabilityFiveMinAgo: number | null;
  weights?: BaselineWeights;
}

export interface ScoreSnapshotResult {
  p_front_page_6h: number;
  delta_p_5min: number;
}

export function scoreSnapshot(args: ScoreSnapshotArgs): ScoreSnapshotResult {
  const p = scoreFeaturesBaseline(args.features, args.weights);
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

export async function scoreAndInsertSnapshot(
  client: ItemsQueryClient,
  input: ScoreAndInsertInput,
  weights: BaselineWeights = DEFAULT_BASELINE_WEIGHTS,
): Promise<ScoreAndInsertResult> {
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

  return {
    features,
    p_front_page_6h,
    delta_p_5min,
    score_velocity: features.score_velocity,
    comment_velocity: features.comment_velocity,
  };
}
