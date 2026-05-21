export interface RetireFactors {
  recall_freq_penalty: number;
  judge_vagueness_score: number;
  neighbour_density_penalty: number;
  age_factor: number;
}

export interface RetireScore {
  composite: number;
  factors_agree_count: number;
  should_auto_retire: boolean;
}

export interface VaguenessJudge {
  judge(args: { body: string; kind: string }): Promise<{ confidence: number; verdict: string }>;
}

// Weights for the composite retire score.
// Vagueness is weighted highest because it most directly signals stale content.
const W_RECALL = 0.25;
const W_VAGUENESS = 0.55;
const W_DENSITY = 0.15;
const W_AGE = 0.05;

// A factor "agrees" when its score is >= this cutoff, independently
// signalling the memory should be retired.
const FACTOR_AGREE_CUTOFF = 0.7;

export async function computeRetireScore(
  factors: RetireFactors,
  _judgePool: VaguenessJudge,
  threshold = 0.85,
): Promise<RetireScore> {
  const composite =
    W_RECALL * factors.recall_freq_penalty +
    W_VAGUENESS * factors.judge_vagueness_score +
    W_DENSITY * factors.neighbour_density_penalty +
    W_AGE * factors.age_factor;

  const factorsAgreeCount = [
    factors.recall_freq_penalty,
    factors.judge_vagueness_score,
    factors.neighbour_density_penalty,
    factors.age_factor,
  ].filter((v) => v >= FACTOR_AGREE_CUTOFF).length;

  return {
    composite,
    factors_agree_count: factorsAgreeCount,
    should_auto_retire: composite >= threshold && factorsAgreeCount >= 3,
  };
}
