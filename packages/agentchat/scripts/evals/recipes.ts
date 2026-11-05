import type { Recipe } from "@penumbra/core/evals/compare";

import { canonicalJson, sha256Hex } from "@penumbra/core/evals/canonical";
import { RecipeSchema } from "@penumbra/core/evals/manifest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class RecipeIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecipeIntegrityError";
  }
}

export const DEFAULT_RECIPES_DIR = fileURLToPath(new URL("./recipes/", import.meta.url));

export const RECIPE_FILES = ["minimal", "capsule", "bounded_repair", "verified_memory"] as const;

// compare.ts keys pairs on PAIR_KEYS, which includes limits and seed, so a
// per-arm drift there silently splits pairs into mismatch:limits exclusions.
function requireIdenticalPairing(recipes: readonly Recipe[]): void {
  const baseline = recipes[0];
  if (baseline === undefined) {
    return;
  }
  const limits = canonicalJson(baseline.limits);
  const seed = canonicalJson(baseline.seed);
  for (const recipe of recipes) {
    if (canonicalJson(recipe.limits) !== limits) {
      throw new RecipeIntegrityError(
        `recipe ${recipe.recipe_id} limits diverge from ${baseline.recipe_id}`,
      );
    }
    if (canonicalJson(recipe.seed) !== seed) {
      throw new RecipeIntegrityError(
        `recipe ${recipe.recipe_id} seed diverges from ${baseline.recipe_id}`,
      );
    }
  }
}

function readRecipeText(dir: string, name: string): string {
  try {
    return readFileSync(join(dir, `${name}.json`), "utf8");
  } catch (err) {
    throw new RecipeIntegrityError(`cannot read recipe ${name}.json`, { cause: err });
  }
}

function parseRecipe(name: string, text: string): Recipe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RecipeIntegrityError(`recipe ${name}.json is not valid JSON`, { cause: err });
  }
  const result = RecipeSchema.safeParse(parsed);
  if (!result.success) {
    throw new RecipeIntegrityError(`recipe ${name}.json fails the recipe schema`, {
      cause: result.error,
    });
  }
  return result.data;
}

function verifyMaterialized(dir: string, name: string, key: string, declaredSha: string): void {
  if (!/^[a-z0-9_]+$/.test(key)) {
    throw new RecipeIntegrityError(`recipe ${name}: invalid component key ${key}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(dir, "components", `${key}.txt`));
  } catch (err) {
    throw new RecipeIntegrityError(`recipe ${name}: unreadable component ${key}`, { cause: err });
  }
  const actual = sha256Hex(bytes);
  if (actual !== declaredSha) {
    throw new RecipeIntegrityError(
      `recipe ${name}: component ${key} sha256 mismatch: declared ${declaredSha}, computed ${actual}`,
    );
  }
}

function verifyComponents(dir: string, name: string, recipe: Recipe): void {
  for (const [key, component] of Object.entries(recipe.components)) {
    if (component.status === "materialized") {
      verifyMaterialized(dir, name, key, component.sha256);
    }
  }
}

function loadRecipeFile(dir: string, name: string): Recipe {
  const recipe = parseRecipe(name, readRecipeText(dir, name));
  if (recipe.arm !== name) {
    throw new RecipeIntegrityError(`recipe ${name}.json declares arm ${recipe.arm}`);
  }
  verifyComponents(dir, name, recipe);
  return recipe;
}

export function loadRecipes(dir: string = DEFAULT_RECIPES_DIR): Recipe[] {
  const recipes = RECIPE_FILES.map((name) => loadRecipeFile(dir, name));
  requireIdenticalPairing(recipes);
  return recipes;
}
