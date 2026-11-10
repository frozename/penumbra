/**
 * Measures paired capsule-ablation uplift: the capsule arm must be the
 * minimal arm plus exactly one component, so the comparison isolates that
 * component's effect on verified solve rate.
 *
 * The verdict is only a held-out uplift claim when evidence is "held_out";
 * a "dev_only" report is directional and must not be cited as confirmatory.
 */

import type { Verifier } from "./aggregate.js";
import type { Episode } from "./manifest.js";

import { canonicalJson } from "./canonical.js";
import {
  applyHoldoutGate,
  type CompareOptions,
  comparePaired,
  holdoutGate,
  ObservationalComparisonError,
  type PairedReport,
  type Recipe,
  type UnsealToken,
} from "./compare.js";

const CAPSULE_COMPONENT_KEY = "capsule";

type CapsuleUpliftRefusalReason =
  | "recipe_missing"
  | "recipe_ambiguous"
  | "not_single_component_ablation"
  | "pairing_drift"
  | "arm_unavailable"
  | "observational_episodes"
  | "holdout_sealed";

type CapsuleUpliftRefusal = {
  status: "refused";
  reason: CapsuleUpliftRefusalReason;
  detail: string;
};

type UpliftVerdict = "underpowered" | "improved" | "regressed" | "inconclusive";

type ArmCost = {
  n_episodes: number;
  context_tokens: {
    sum: number;
    median_per_episode: number | null;
    n_missing: number;
  };
  tool_permission_errors: number;
  environment_failures: number;
  tool_error_rate: number | null;
};

type CapsuleUpliftOptions = {
  recipes: readonly Recipe[];
  verifier: Verifier;
  resolveFixture: (ref: Episode["fixture_ref"]) => unknown;
  lock: unknown;
  unseal: UnsealToken | null;
  split: "dev" | "holdout";
  minFamilies: number;
  seed: number;
  B?: number;
};

type ComparisonArmReport = PairedReport["baseline"] & {
  n_episodes: number;
  tool_permission_errors: number;
  environment_failures: number;
  tool_error_rate: number | null;
};

type CapsuleComparison = Omit<PairedReport, "baseline" | "treatment"> & {
  baseline: ComparisonArmReport;
  treatment: ComparisonArmReport;
};

type CapsuleUpliftMeasured = {
  status: "measured";
  design: "controlled_paired_ablation";
  baseline_recipe_id: string;
  treatment_recipe_id: string;
  split: "dev" | "holdout";
  held_out: boolean;
  evidence: "held_out" | "dev_only";
  comparison: CapsuleComparison;
  verdict: UpliftVerdict;
  uplift: { delta: number | null; verdict: UpliftVerdict };
  cost: {
    baseline: ArmCost;
    treatment: ArmCost;
    context_token_delta: number | null;
    tool_error_rate_delta: number | null;
  };
};

type CapsuleUpliftReport = CapsuleUpliftRefusal | CapsuleUpliftMeasured;

type RecipePair = { minimal: Recipe; capsule: Recipe };

function refuse(reason: CapsuleUpliftRefusalReason, detail: string): CapsuleUpliftRefusal {
  return { status: "refused", reason, detail };
}

function selectRecipePair(recipes: readonly Recipe[]): RecipePair | CapsuleUpliftRefusal {
  const minimal = recipes.filter((recipe) => recipe.arm === "minimal");
  const capsule = recipes.filter((recipe) => recipe.arm === "capsule");
  const [minimalRecipe] = minimal;
  const [capsuleRecipe] = capsule;
  const found = `found ${String(minimal.length)} minimal and ${String(capsule.length)} capsule`;
  if (minimalRecipe === undefined || capsuleRecipe === undefined) {
    return refuse("recipe_missing", `expected one minimal and one capsule recipe, ${found}`);
  }
  if (minimal.length > 1 || capsule.length > 1) {
    return refuse("recipe_ambiguous", `expected one minimal and one capsule recipe, ${found}`);
  }
  return { minimal: minimalRecipe, capsule: capsuleRecipe };
}

function ablationKeyOffender(minimal: Recipe, capsule: Recipe): string | null {
  const minimalKeys = new Set(Object.keys(minimal.components));
  const capsuleKeys = new Set(Object.keys(capsule.components));
  const allKeys = [...new Set([...minimalKeys, ...capsuleKeys])].sort();
  for (const key of allKeys) {
    const expectedInCapsule = minimalKeys.has(key) || key === CAPSULE_COMPONENT_KEY;
    if (capsuleKeys.has(key) !== expectedInCapsule) {
      return key;
    }
  }
  if (!capsuleKeys.has(CAPSULE_COMPONENT_KEY)) {
    return CAPSULE_COMPONENT_KEY;
  }
  if (minimalKeys.has(CAPSULE_COMPONENT_KEY)) {
    return CAPSULE_COMPONENT_KEY;
  }
  for (const key of allKeys) {
    if (key === CAPSULE_COMPONENT_KEY && !minimalKeys.has(key)) {
      continue;
    }
    if (canonicalJson(minimal.components[key]) !== canonicalJson(capsule.components[key])) {
      return key;
    }
  }
  return null;
}

function pairingDriftField(minimal: Recipe, capsule: Recipe): "limits" | "seed" | null {
  if (canonicalJson(minimal.limits) !== canonicalJson(capsule.limits)) {
    return "limits";
  }
  if (canonicalJson(minimal.seed) !== canonicalJson(capsule.seed)) {
    return "seed";
  }
  return null;
}

function blockedOnValues(recipes: readonly Recipe[]): string[] {
  const blocked = new Set<string>();
  for (const recipe of recipes) {
    for (const component of Object.values(recipe.components)) {
      if (component.status === "pending_upstream") {
        blocked.add(component.blocked_on);
      }
    }
  }
  return [...blocked].sort();
}

function sortForSplit(episodes: readonly Episode[], split: "dev" | "holdout"): Episode[] {
  return episodes
    .filter((episode) => episode.split === split)
    .toSorted((lhs, rhs) =>
      lhs.episode_id < rhs.episode_id ? -1 : lhs.episode_id > rhs.episode_id ? 1 : 0,
    );
}

function compareOptions(opts: CapsuleUpliftOptions, pair: RecipePair): CompareOptions {
  return {
    verifier: opts.verifier,
    resolveFixture: opts.resolveFixture,
    lock: opts.lock,
    unseal: opts.unseal,
    minFamilies: opts.minFamilies,
    seed: opts.seed,
    B: opts.B,
    baseline: "minimal",
    treatment: "capsule",
    recipes: [pair.minimal, pair.capsule],
  };
}

async function pairedComparison(
  sorted: readonly Episode[],
  opts: CapsuleUpliftOptions,
  pair: RecipePair,
): Promise<PairedReport | CapsuleUpliftRefusal> {
  try {
    return await comparePaired(sorted, compareOptions(opts, pair));
  } catch (error) {
    if (error instanceof ObservationalComparisonError) {
      return refuse("observational_episodes", error.message);
    }
    throw error;
  }
}

function episodeTokenSum(episode: Episode): number | null {
  if (episode.attempts.length === 0) {
    return null;
  }
  let sum = 0;
  for (const attempt of episode.attempts) {
    const tokens = attempt.usage.tokens;
    if (tokens === null) {
      return null;
    }
    sum += tokens;
  }
  return sum;
}

function median(sorted: readonly number[]): number | null {
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) {
    return null;
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[mid - 1];
  if (lower === undefined) {
    return null;
  }
  return (lower + upper) / 2;
}

function armCost(episodes: readonly Episode[]): ArmCost {
  const tokenSums: number[] = [];
  let tokenSum = 0;
  let nMissing = 0;
  let toolPermissionErrors = 0;
  let environmentFailures = 0;
  for (const episode of episodes) {
    if (episode.failure_type === "tool_permission_error") {
      toolPermissionErrors += 1;
    }
    if (episode.observed_outcome.class === "environment_failure") {
      environmentFailures += 1;
    }
    const tokens = episodeTokenSum(episode);
    if (tokens === null) {
      nMissing += 1;
    } else {
      tokenSums.push(tokens);
      tokenSum += tokens;
    }
  }
  tokenSums.sort((lhs, rhs) => lhs - rhs);
  const nEpisodes = episodes.length;
  return {
    n_episodes: nEpisodes,
    context_tokens: {
      sum: tokenSum,
      median_per_episode: median(tokenSums),
      n_missing: nMissing,
    },
    tool_permission_errors: toolPermissionErrors,
    environment_failures: environmentFailures,
    tool_error_rate: nEpisodes === 0 ? null : toolPermissionErrors / nEpisodes,
  };
}

function costGroups(
  sorted: readonly Episode[],
  paired: PairedReport,
  opts: CapsuleUpliftOptions,
  pair: RecipePair,
): { baseline: Episode[]; treatment: Episode[] } {
  const armByRecipeId = new Map<string, "baseline" | "treatment">([
    [pair.minimal.recipe_id, "baseline"],
    [pair.capsule.recipe_id, "treatment"],
  ]);
  const { kept } = applyHoldoutGate(sorted, holdoutGate(opts.lock, opts.unseal));
  const excluded = new Set(paired.excluded.map((entry) => entry.episode_id));
  const baseline: Episode[] = [];
  const treatment: Episode[] = [];
  for (const episode of kept) {
    if (excluded.has(episode.episode_id) || episode.recipe_id === null) {
      continue;
    }
    const arm = armByRecipeId.get(episode.recipe_id);
    if (arm === "baseline") {
      baseline.push(episode);
    } else if (arm === "treatment") {
      treatment.push(episode);
    }
  }
  return { baseline, treatment };
}

function upliftVerdict(comparison: PairedReport): UpliftVerdict {
  if (comparison.underpowered) {
    return "underpowered";
  }
  const treatment = comparison.treatment.cluster_ci;
  const baseline = comparison.baseline.cluster_ci;
  if (treatment !== null && baseline !== null) {
    if (treatment.lo > baseline.hi) {
      return "improved";
    }
    if (treatment.hi < baseline.lo) {
      return "regressed";
    }
  }
  return "inconclusive";
}

function deltaOrNull(treatment: number | null, baseline: number | null): number | null {
  if (treatment === null || baseline === null) {
    return null;
  }
  return treatment - baseline;
}

function comparisonArm(arm: PairedReport["baseline"], cost: ArmCost): ComparisonArmReport {
  return {
    ...arm,
    n_episodes: cost.n_episodes,
    tool_permission_errors: cost.tool_permission_errors,
    environment_failures: cost.environment_failures,
    tool_error_rate: cost.tool_error_rate,
  };
}

function buildMeasured(
  opts: CapsuleUpliftOptions,
  pair: RecipePair,
  paired: PairedReport,
  sorted: readonly Episode[],
): CapsuleUpliftMeasured {
  const groups = costGroups(sorted, paired, opts, pair);
  const baselineCost = armCost(groups.baseline);
  const treatmentCost = armCost(groups.treatment);
  const heldOut = opts.split === "holdout";
  const verdict = upliftVerdict(paired);
  const delta = deltaOrNull(paired.treatment.rate, paired.baseline.rate);
  return {
    status: "measured",
    design: "controlled_paired_ablation",
    baseline_recipe_id: pair.minimal.recipe_id,
    treatment_recipe_id: pair.capsule.recipe_id,
    split: opts.split,
    held_out: heldOut,
    evidence: heldOut ? "held_out" : "dev_only",
    comparison: {
      ...paired,
      baseline: comparisonArm(paired.baseline, baselineCost),
      treatment: comparisonArm(paired.treatment, treatmentCost),
    },
    verdict,
    uplift: { delta, verdict },
    cost: {
      baseline: baselineCost,
      treatment: treatmentCost,
      context_token_delta: deltaOrNull(
        treatmentCost.context_tokens.median_per_episode,
        baselineCost.context_tokens.median_per_episode,
      ),
      tool_error_rate_delta: deltaOrNull(
        treatmentCost.tool_error_rate,
        baselineCost.tool_error_rate,
      ),
    },
  };
}

async function measureCapsuleUplift(
  episodes: readonly Episode[],
  opts: CapsuleUpliftOptions,
): Promise<CapsuleUpliftReport> {
  const selection = selectRecipePair(opts.recipes);
  if ("status" in selection) {
    return selection;
  }
  const offender = ablationKeyOffender(selection.minimal, selection.capsule);
  if (offender !== null) {
    return refuse(
      "not_single_component_ablation",
      `capsule components must equal the minimal components plus "${CAPSULE_COMPONENT_KEY}"; offending key: ${offender}`,
    );
  }
  const drift = pairingDriftField(selection.minimal, selection.capsule);
  if (drift !== null) {
    return refuse("pairing_drift", `minimal and capsule recipes drifted on ${drift}`);
  }
  const blocked = blockedOnValues([selection.minimal, selection.capsule]);
  if (blocked.length > 0) {
    return refuse(
      "arm_unavailable",
      `recipe components are not materialized; blocked on ${blocked.join(", ")}`,
    );
  }
  if (episodes.some((episode) => episode.design === "observational")) {
    return refuse(
      "observational_episodes",
      "paired capsule ablation requires controlled episodes only",
    );
  }
  const sorted = sortForSplit(episodes, opts.split);
  if (opts.split === "holdout" && !holdoutGate(opts.lock, opts.unseal).unsealed) {
    return refuse(
      "holdout_sealed",
      "holdout measurement requires a verified lock and unseal token",
    );
  }
  const paired = await pairedComparison(sorted, opts, selection);
  if ("status" in paired) {
    return paired;
  }
  return buildMeasured(opts, selection, paired, sorted);
}

export {
  type ArmCost,
  CAPSULE_COMPONENT_KEY,
  type CapsuleUpliftOptions,
  type CapsuleUpliftRefusal,
  type CapsuleUpliftRefusalReason,
  type CapsuleUpliftReport,
  measureCapsuleUplift,
  type UpliftVerdict,
};
