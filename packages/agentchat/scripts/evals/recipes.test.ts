import type { Recipe } from "@penumbra/core/evals/compare";

import { canonicalJson, recipeHash, sha256Hex } from "@penumbra/core/evals/canonical";
import { PAIR_KEYS } from "@penumbra/core/evals/compare";
import { RecipeArmSchema, RecipeSchema } from "@penumbra/core/evals/manifest";
import { planPairedRun } from "@penumbra/core/evals/plan";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Component = Recipe["components"][string];

type RecipesModule = {
  loadRecipes: (dir?: string) => Recipe[];
  RecipeIntegrityError: abstract new (...args: never[]) => Error;
  DEFAULT_RECIPES_DIR: string;
};

const MOD_URL = new URL("./recipes.ts", import.meta.url).href;

async function load(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(MOD_URL)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let mod: Record<string, unknown> | null = null;

beforeAll(async () => {
  mod = await load();
});

const api = (): RecipesModule => mod as unknown as RecipesModule;

const DATA_DIR = fileURLToPath(new URL("./recipes/", import.meta.url));

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function comp(key: string): string {
  return join(DATA_DIR, "components", `${key}.txt`);
}

function copyData(): string {
  const tmp = mkdtempSync(join(tmpdir(), "recipes-"));
  cpSync(DATA_DIR, tmp, { recursive: true });
  tmpDirs.push(tmp);
  return tmp;
}

function readJson(dir: string, arm: string): Recipe {
  return JSON.parse(readFileSync(join(dir, `${arm}.json`), "utf8")) as Recipe;
}

function writeJson(dir: string, arm: string, value: unknown): void {
  writeFileSync(join(dir, `${arm}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function expectIntegrity(fn: () => unknown): void {
  let threw = false;
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    threw = true;
    thrown = err;
  }
  expect(threw).toBe(true);
  expect(thrown).toBeInstanceOf(api().RecipeIntegrityError);
}

function recipeFor(recipes: readonly Recipe[], arm: Recipe["arm"]): Recipe {
  const found = recipes.find((r) => r.arm === arm);
  if (found === undefined) {
    throw new Error(`missing recipe for arm ${arm}`);
  }
  return found;
}

function componentEntry(recipe: Recipe, key: string): Component {
  const entry = recipe.components[key];
  if (entry === undefined) {
    throw new Error(`missing component ${key}`);
  }
  return entry;
}

function renamedComponentKey(recipe: Recipe, from: string, to: string): Recipe {
  const entry = componentEntry(recipe, from);
  const components: Record<string, Component> = {};
  for (const [key, value] of Object.entries(recipe.components)) {
    components[key === from ? to : key] = value;
  }
  return { ...recipe, components };
}

function pending(r: Recipe): { key: string; blocked_on: string }[] {
  const out: { key: string; blocked_on: string }[] = [];
  for (const [key, component] of Object.entries(r.components)) {
    if (component.status === "pending_upstream") {
      out.push({ key, blocked_on: component.blocked_on });
    }
  }
  return out;
}

function flipFirstByte(path: string): void {
  const buf = readFileSync(path);
  buf.set([(buf.at(0) ?? 0) ^ 1]);
  writeFileSync(path, buf);
}

test("all 4 load", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const recipes = api().loadRecipes();
  expect(recipes).toHaveLength(4);
  expect(recipes.map((r) => r.arm)).toEqual([...RecipeArmSchema.options]);
  expect(recipes.map((r) => r.recipe_id)).toEqual([
    "minimal-v1",
    "capsule-v1",
    "bounded_repair-v1",
    "verified_memory-v1",
  ]);
  for (const r of recipes) {
    expect(RecipeSchema.safeParse(r).success).toBe(true);
  }
  expect(resolve(api().DEFAULT_RECIPES_DIR)).toBe(resolve(DATA_DIR));
  for (const arm of RecipeArmSchema.options) {
    const raw = readFileSync(join(DATA_DIR, `${arm}.json`), "utf8");
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw) as unknown, null, 2)}\n`);
  }
});

test("component sha equals the bytes' hash; a one-byte edit fails", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  for (const recipe of api().loadRecipes()) {
    for (const [key, component] of Object.entries(recipe.components)) {
      if (component.status === "materialized") {
        expect(sha256Hex(readFileSync(comp(key)))).toBe(component.sha256);
      }
    }
  }
  const sysTmp = copyData();
  flipFirstByte(join(sysTmp, "components", "system_prompt.txt"));
  expectIntegrity(() => api().loadRecipes(sysTmp));
  const policyTmp = copyData();
  flipFirstByte(join(policyTmp, "components", "repair_policy.txt"));
  expectIntegrity(() => api().loadRecipes(policyTmp));
});

test("blocked_on is #392/#393/#394", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const recipes = api().loadRecipes();
  expect(pending(recipeFor(recipes, "minimal"))).toEqual([]);
  expect(pending(recipeFor(recipes, "capsule"))).toEqual([{ key: "capsule", blocked_on: "#392" }]);
  const bounded = recipeFor(recipes, "bounded_repair");
  expect(pending(bounded)).toEqual([{ key: "repair_loop", blocked_on: "#393" }]);
  expect(bounded.components["repair_policy"]?.status).toBe("materialized");
  expect(pending(recipeFor(recipes, "verified_memory"))).toEqual([
    { key: "verified_memory", blocked_on: "#394" },
  ]);
});

test("recipeHash stable", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const first = api().loadRecipes();
  const second = api().loadRecipes();
  const firstHashes = new Map(first.map((r) => [r.recipe_id, recipeHash(r)]));
  for (const r of second) {
    expect(firstHashes.get(r.recipe_id)).toBe(recipeHash(r));
    expect(recipeHash(r)).toMatch(/^[0-9a-f]{64}$/);
  }
  expect(new Set(first.map((r) => recipeHash(r))).size).toBe(4);
  for (const arm of RecipeArmSchema.options) {
    const raw = readFileSync(join(DATA_DIR, `${arm}.json`), "utf8");
    const recipe = recipeFor(first, arm);
    expect(recipeHash(recipe)).toBe(recipeHash(JSON.parse(raw) as unknown));
  }
  const tmp = copyData();
  const minimal = readJson(tmp, "minimal");
  writeJson(tmp, "minimal", { ...minimal, notes: "x" });
  const reloaded = api().loadRecipes(tmp);
  expect(recipeHash(recipeFor(reloaded, "minimal"))).toBe(recipeHash(recipeFor(first, "minimal")));
});

test("planPairedRun schedules only minimal while repair/capsule/memory are pending", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const p = planPairedRun({
    fixtures: [{ family_id: "fam-syn-a", variant_id: "v1", split: "dev" }],
    recipes: api().loadRecipes(),
    lock: null,
    unseal: null,
    seed: 7,
    repeats: 1,
  });
  expect(p.recipe_unavailable).toBe(3);
  expect(p.unavailable_recipes).toEqual([
    { recipe_id: "bounded_repair-v1", arm: "bounded_repair", blocked_on: ["#393"] },
    { recipe_id: "capsule-v1", arm: "capsule", blocked_on: ["#392"] },
    { recipe_id: "verified_memory-v1", arm: "verified_memory", blocked_on: ["#394"] },
  ]);
  expect(p.arms).toEqual(["minimal"]);
  expect(p.schedule.map((s) => s.arm)).toEqual(["minimal"]);
});

test("minimal vs bounded_repair are not split by mismatch:limits or mismatch:seed", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  expect(PAIR_KEYS).toContain("limits");
  expect(PAIR_KEYS).toContain("seed");
  const recipes = api().loadRecipes();
  expect(new Set(recipes.map((r) => canonicalJson(r.limits))).size).toBe(1);
  expect(new Set(recipes.map((r) => canonicalJson(r.seed))).size).toBe(1);
  for (const r of recipes) {
    for (const key of Object.keys(r.limits)) {
      expect(key).not.toMatch(/repair/i);
    }
  }
  expect(readFileSync(comp("repair_policy"), "utf8")).toContain("repair_rounds: 2");
  const minimal = recipeFor(recipes, "minimal");
  expect(Object.keys(minimal.components)).not.toContain("repair_policy");
  expect(Object.keys(minimal.components)).not.toContain("repair_loop");
});

test("loader rejects divergent limits", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tmp = copyData();
  const bounded = readJson(tmp, "bounded_repair");
  writeJson(tmp, "bounded_repair", {
    ...bounded,
    limits: { ...bounded.limits, max_repair_rounds: 2 },
  });
  expectIntegrity(() => api().loadRecipes(tmp));
});

test("loader rejects divergent seed", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tmp = copyData();
  const capsule = readJson(tmp, "capsule");
  writeJson(tmp, "capsule", { ...capsule, seed: { value: 7, supported: true } });
  expectIntegrity(() => api().loadRecipes(tmp));
});

test("loader rejects bad component keys", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const dashTmp = copyData();
  writeJson(
    dashTmp,
    "minimal",
    renamedComponentKey(readJson(dashTmp, "minimal"), "system_prompt", "system-prompt"),
  );
  cpSync(
    join(dashTmp, "components", "system_prompt.txt"),
    join(dashTmp, "components", "system-prompt.txt"),
  );
  expectIntegrity(() => api().loadRecipes(dashTmp));
  const travTmp = copyData();
  writeJson(
    travTmp,
    "minimal",
    renamedComponentKey(
      readJson(travTmp, "minimal"),
      "system_prompt",
      "../components/system_prompt",
    ),
  );
  expectIntegrity(() => api().loadRecipes(travTmp));
});

test("loader rejects arm/file mismatch", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tmp = copyData();
  const capsule = readJson(tmp, "capsule");
  writeJson(tmp, "capsule", { ...capsule, arm: "minimal" });
  expectIntegrity(() => api().loadRecipes(tmp));
});

test("missing component file is RecipeIntegrityError", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tmp = copyData();
  unlinkSync(join(tmp, "components", "system_prompt.txt"));
  expectIntegrity(() => api().loadRecipes(tmp));
});

test("schema violation is RecipeIntegrityError", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tmp = copyData();
  const minimal = readJson(tmp, "minimal");
  writeJson(tmp, "minimal", { ...minimal, bogus: 1 });
  expectIntegrity(() => api().loadRecipes(tmp));
});
