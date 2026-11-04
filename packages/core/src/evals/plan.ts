import { canonicalJson } from "./canonical.js";
import {
  applyHoldoutGate,
  holdoutGate,
  type HoldoutStatus,
  type Recipe,
  type UnsealToken,
} from "./compare.js";
import { RecipeArmSchema } from "./manifest.js";
import { mulberry32 } from "./stats.js";

type PlanFixture = {
  family_id: string;
  variant_id: string;
  split: "train" | "dev" | "holdout";
};

type PlanOptions = {
  fixtures: readonly PlanFixture[];
  recipes: readonly Recipe[];
  lock: unknown;
  unseal: UnsealToken | null;
  seed: number;
  repeats: number;
  dispatcher?: unknown;
};

type ScheduleItem = {
  block: number;
  fixture_ref: { family_id: string; variant_id: string };
  family_id: string;
  variant_id: string;
  split: "train" | "dev" | "holdout";
  repeat: number;
  arm: Recipe["arm"];
  recipe_id: string;
  seed: number | null;
};

type UnavailableRecipe = { recipe_id: string; arm: Recipe["arm"]; blocked_on: string[] };

type RunPlan = {
  dry_run: true;
  seed: number;
  holdout: HoldoutStatus;
  arms: Recipe["arm"][];
  schedule: ScheduleItem[];
  recipe_unavailable: number;
  unavailable_recipes: UnavailableRecipe[];
};

function pendingBlockedOn(recipe: Recipe): string[] | null {
  const blocked: string[] = [];
  for (const component of Object.values(recipe.components)) {
    if (component.status === "pending_upstream") {
      blocked.push(component.blocked_on);
    }
  }
  return blocked.length === 0 ? null : [...new Set(blocked)].sort();
}

function partitionRecipes(recipes: readonly Recipe[]): {
  available: Recipe[];
  unavailable: UnavailableRecipe[];
} {
  const unavailable: UnavailableRecipe[] = [];
  const available: Recipe[] = [];
  for (const recipe of recipes) {
    const blockedOn = pendingBlockedOn(recipe);
    if (blockedOn === null) {
      available.push(recipe);
    } else {
      unavailable.push({ recipe_id: recipe.recipe_id, arm: recipe.arm, blocked_on: blockedOn });
    }
  }
  unavailable.sort((lhs, rhs) => (lhs.recipe_id < rhs.recipe_id ? -1 : 1));
  available.sort((lhs, rhs) => (lhs.recipe_id < rhs.recipe_id ? -1 : 1));
  const armsSeen = new Set<Recipe["arm"]>();
  for (const recipe of available) {
    if (armsSeen.has(recipe.arm)) {
      throw new RangeError(`two available recipes share arm ${recipe.arm}`);
    }
    armsSeen.add(recipe.arm);
  }
  return { available, unavailable };
}

function compareFixtureRef(lhs: PlanFixture, rhs: PlanFixture): number {
  if (lhs.family_id !== rhs.family_id) {
    return lhs.family_id < rhs.family_id ? -1 : 1;
  }
  if (lhs.variant_id !== rhs.variant_id) {
    return lhs.variant_id < rhs.variant_id ? -1 : 1;
  }
  return 0;
}

function shuffleBlock(order: readonly Recipe[], rng: () => number): Recipe[] {
  const shuffled = [...order];
  for (let i = shuffled.length - 1; i >= 1; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const kept = shuffled[i];
    const swapWith = shuffled[j];
    if (kept === undefined || swapWith === undefined) {
      continue;
    }
    shuffled[i] = swapWith;
    shuffled[j] = kept;
  }
  return shuffled;
}

function buildSchedule(
  fixtures: readonly PlanFixture[],
  available: readonly Recipe[],
  repeats: number,
  seed: number,
): ScheduleItem[] {
  const rng = mulberry32(seed);
  const schedule: ScheduleItem[] = [];
  let block = 0;
  for (const fixture of fixtures) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const recipe of shuffleBlock(available, rng)) {
        schedule.push({
          block,
          fixture_ref: { family_id: fixture.family_id, variant_id: fixture.variant_id },
          family_id: fixture.family_id,
          variant_id: fixture.variant_id,
          split: fixture.split,
          repeat,
          arm: recipe.arm,
          recipe_id: recipe.recipe_id,
          seed: recipe.seed.value,
        });
      }
      block += 1;
    }
  }
  return schedule;
}

function planPairedRun(opts: PlanOptions): RunPlan {
  if (!Number.isInteger(opts.repeats) || opts.repeats < 1) {
    throw new RangeError("repeats must be an integer >= 1");
  }
  const gate = holdoutGate(opts.lock, opts.unseal);
  const { available, unavailable } = partitionRecipes(opts.recipes);
  const armsSeen = new Set<Recipe["arm"]>();
  for (const recipe of available) {
    armsSeen.add(recipe.arm);
  }

  const lockFixtures: PlanFixture[] = gate.entries
    .filter((entry) => !entry.synthetic)
    .map((entry) => ({
      family_id: entry.family_id,
      variant_id: entry.variant_id,
      split: "holdout" as const,
    }));
  const { status: holdout, kept } = applyHoldoutGate([...opts.fixtures, ...lockFixtures], gate);
  const deduped = new Map<string, PlanFixture>();
  for (const fixture of kept) {
    const key = canonicalJson([fixture.family_id, fixture.variant_id]);
    if (!deduped.has(key)) {
      deduped.set(key, fixture);
    }
  }
  const scheduled = [...deduped.values()].sort(compareFixtureRef);

  return {
    dry_run: true,
    seed: opts.seed,
    holdout,
    arms: RecipeArmSchema.options.filter((arm) => armsSeen.has(arm)),
    schedule: buildSchedule(scheduled, available, opts.repeats, opts.seed),
    recipe_unavailable: unavailable.length,
    unavailable_recipes: unavailable,
  };
}

export { type PlanFixture, type PlanOptions, planPairedRun, type RunPlan, type ScheduleItem };
