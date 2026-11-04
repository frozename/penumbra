import { beforeAll, expect, mock, test } from "bun:test";

import { computeLockDigest, unsealHoldout, verifyHoldoutLock } from "@src/evals/holdout.js";
import { RecipeSchema } from "@src/evals/manifest.js";

type JsonObject = Record<string, unknown>;

// Input and output shapes are declared locally: plan.ts does not exist at the
// base, so no value or type may be imported from it.
type FixtureInput = { family_id: string; variant_id: string; split: string };
type ScheduleItem = {
  block: number;
  family_id: string;
  variant_id: string;
  repeat: number;
  arm: string;
  recipe_id: string;
};
type UnavailableRecipe = { recipe_id: string; arm: string; blocked_on: string[] };
type PlanReport = {
  dry_run: boolean;
  holdout: "none" | "sealed" | "unsealed";
  schedule: ScheduleItem[];
  recipe_unavailable: number;
  unavailable_recipes: UnavailableRecipe[];
};
type RootLike =
  | { kind: "issue"; number: number }
  | { kind: "operator_bundle"; id: string }
  | { kind: "synthetic"; id: string };
type LockEntry = {
  family_id: string;
  variant_id: string;
  root: RootLike;
  failure_type: null;
  synthetic: boolean;
  expect_blocked: boolean;
  base_sha: string;
  task_digest: string;
  source_root_handoff_digests: string[];
  content_digest: string;
  assertion_set_digest: string;
};
type Lock = { schema_version: 1; entries: LockEntry[]; digest: string };
type PlanOpts = {
  fixtures: readonly FixtureInput[];
  recipes: readonly JsonObject[];
  lock: unknown;
  unseal: unknown;
  seed: number;
  repeats: number;
  dispatcher?: { dispatch: (...args: unknown[]) => unknown };
};
type PlanFn = (opts: PlanOpts) => PlanReport;

const MOD_URL = new URL("../../src/evals/plan.ts", import.meta.url).href;

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

const planPairedRun = (): PlanFn => mod?.["planPairedRun"] as PlanFn;

const BASE_SHA = "b".repeat(40);
const TASK_DIGEST = "2".repeat(64);
const CONTENT_DIGEST = "3".repeat(64);
const ASSERTION_DIGEST = "4".repeat(64);
const COMPONENT_SHA = "7".repeat(64);

function makeRecipe(overrides: JsonObject = {}): JsonObject {
  const recipe: JsonObject = {
    recipe_id: "minimal-v1",
    arm: "minimal",
    components: { base: { status: "materialized", sha256: COMPONENT_SHA } },
    limits: { max_rounds: 3 },
    seed: { value: 7, supported: true },
    ...overrides,
  };
  const parsed = RecipeSchema.safeParse(recipe);
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues));
  }
  expect(parsed.success).toBe(true);
  return recipe;
}

const MINIMAL = makeRecipe();
const BOUNDED = makeRecipe({ recipe_id: "bounded_repair-v1", arm: "bounded_repair" });

function lockEntry(root: RootLike): LockEntry {
  const familyId =
    root.kind === "issue"
      ? `fam-${String(root.number)}`
      : root.kind === "operator_bundle"
        ? `fam-op-${root.id}`
        : `fam-syn-${root.id}`;
  return {
    family_id: familyId,
    variant_id: "v1",
    root,
    failure_type: null,
    synthetic: root.kind === "synthetic",
    expect_blocked: false,
    base_sha: BASE_SHA,
    task_digest: TASK_DIGEST,
    source_root_handoff_digests: [],
    content_digest: CONTENT_DIGEST,
    assertion_set_digest: ASSERTION_DIGEST,
  };
}

function makeLock(entries: LockEntry[]): Lock {
  const lock: Lock = { schema_version: 1, entries, digest: computeLockDigest(entries) };
  expect(() => verifyHoldoutLock(lock)).not.toThrow();
  return lock;
}

const ENTRY777 = lockEntry({ kind: "issue", number: 777 });
const LOCK777 = makeLock([ENTRY777]);
const TOKEN = unsealHoldout(LOCK777, { sha256: "0".repeat(64), max_unseals: 1 });

function baseOpts(overrides: Partial<PlanOpts> = {}): PlanOpts {
  return {
    fixtures: [],
    recipes: [MINIMAL, BOUNDED],
    lock: null,
    unseal: null,
    seed: 7,
    repeats: 1,
    ...overrides,
  };
}

function thrownName(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.name : null;
  }
}

test("6: same seed gives the same schedule, balanced per block", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const fixtures: FixtureInput[] = Array.from({ length: 20 }, (_, i) => ({
    family_id: `fam-syn-f${String(i).padStart(2, "0")}`,
    variant_id: "v1",
    split: "dev",
  }));
  const first = planPairedRun()(baseOpts({ fixtures }));
  const second = planPairedRun()(baseOpts({ fixtures }));
  expect(first).toEqual(second);
  const schedule = first.schedule;
  expect(schedule).toHaveLength(40);
  const armTotals: Record<string, number> = {};
  const blockFirsts: string[] = [];
  const blocks = Array.from({ length: schedule.length / 2 }, (_, i) =>
    schedule.slice(i * 2, i * 2 + 2),
  );
  for (const pair of blocks) {
    expect(pair.map((item) => item.arm).sort()).toEqual(["bounded_repair", "minimal"]);
    expect(pair[0]?.family_id).toBe(pair[1]?.family_id);
    expect(pair[0]?.variant_id).toBe(pair[1]?.variant_id);
    const firstArm = pair[0]?.arm;
    if (firstArm !== undefined) {
      blockFirsts.push(firstArm);
    }
    for (const item of pair) {
      armTotals[item.arm] = (armTotals[item.arm] ?? 0) + 1;
    }
  }
  expect(blocks).toHaveLength(20);
  expect(armTotals["minimal"]).toBe(20);
  expect(armTotals["bounded_repair"]).toBe(20);
  expect([...new Set(blockFirsts)].sort()).toEqual(["bounded_repair", "minimal"]);
  const seeded8 = planPairedRun()(baseOpts({ fixtures, seed: 8 }));
  expect(seeded8.schedule).not.toEqual(first.schedule);
});

test("7: pending_upstream recipes are reported unavailable, not scheduled", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const fixtures: FixtureInput[] = [{ family_id: "fam-syn-a", variant_id: "v1", split: "dev" }];
  const recipes = [
    makeRecipe(),
    makeRecipe({ recipe_id: "bounded_repair-v1", arm: "bounded_repair" }),
    makeRecipe({
      recipe_id: "capsule-v1",
      arm: "capsule",
      components: { capsule: { status: "pending_upstream", blocked_on: "#392" } },
    }),
    makeRecipe({
      recipe_id: "verified_memory-v1",
      arm: "verified_memory",
      components: { verified_memory: { status: "pending_upstream", blocked_on: "#394" } },
    }),
  ];
  const res = planPairedRun()(baseOpts({ fixtures, recipes }));
  const arms = [...new Set(res.schedule.map((item) => item.arm))].sort();
  expect(arms).toEqual(["bounded_repair", "minimal"]);
  expect(res.recipe_unavailable).toBe(2);
  expect(res.unavailable_recipes).toEqual([
    { recipe_id: "capsule-v1", arm: "capsule", blocked_on: ["#392"] },
    { recipe_id: "verified_memory-v1", arm: "verified_memory", blocked_on: ["#394"] },
  ]);
});

test("8b: the holdout stays sealed without a token, across label lies", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const fixtures: FixtureInput[] = [
    { family_id: "fam-syn-a", variant_id: "v1", split: "dev" },
    { family_id: "fam-777", variant_id: "v9", split: "dev" },
  ];
  const sealed = planPairedRun()(baseOpts({ fixtures, lock: LOCK777, unseal: null }));
  expect(sealed.schedule.length).toBeGreaterThan(0);
  expect(sealed.schedule.every((item) => item.family_id !== "fam-777")).toBe(true);
  expect(sealed.holdout).toBe("sealed");
  const unsealed = planPairedRun()(baseOpts({ fixtures, lock: LOCK777, unseal: TOKEN }));
  expect(unsealed.holdout).toBe("unsealed");
  expect(unsealed.schedule.some((item) => item.family_id === "fam-777")).toBe(true);
  expect(
    unsealed.schedule.some((item) => item.family_id === "fam-777" && item.variant_id === "v1"),
  ).toBe(true);
  const nullLock = planPairedRun()(
    baseOpts({
      fixtures: [
        { family_id: "fam-syn-a", variant_id: "v1", split: "dev" },
        { family_id: "fam-syn-z", variant_id: "v1", split: "holdout" },
      ],
      lock: null,
      unseal: null,
    }),
  );
  expect(nullLock.schedule.every((item) => item.family_id !== "fam-syn-z")).toBe(true);
  expect(nullLock.holdout).toBe("sealed");
});

test("9: the dispatcher spy is never called and the result is synchronous", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const dispatch = mock(() => undefined);
  const res = planPairedRun()(
    baseOpts({
      fixtures: [{ family_id: "fam-syn-a", variant_id: "v1", split: "dev" }],
      dispatcher: { dispatch },
    }),
  );
  const then = (res as unknown as { then?: unknown }).then;
  expect(typeof then).not.toBe("function");
  expect(res.dry_run).toBe(true);
  expect(res.schedule.length).toBeGreaterThan(0);
  expect(dispatch.mock.calls.length).toBe(0);
});

test("10: an empty or synthetic-only holdout reports none, not an error", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const fixtures: FixtureInput[] = [{ family_id: "fam-syn-a", variant_id: "v1", split: "dev" }];
  const empty = planPairedRun()(baseOpts({ fixtures, lock: makeLock([]), unseal: null }));
  expect(empty.holdout).toBe("none");
  const syntheticOnly = planPairedRun()(
    baseOpts({
      fixtures,
      lock: makeLock([lockEntry({ kind: "synthetic", id: "syn-a" })]),
      unseal: null,
    }),
  );
  expect(syntheticOnly.holdout).toBe("none");
});

test("10b-plan: a tampered lock fails closed", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const tampered: JsonObject = {
    schema_version: 1,
    entries: [{ ...ENTRY777, synthetic: true }],
    digest: LOCK777.digest,
  };
  const name = thrownName(() =>
    planPairedRun()(
      baseOpts({
        fixtures: [{ family_id: "fam-syn-a", variant_id: "v1", split: "dev" }],
        lock: tampered,
        unseal: null,
      }),
    ),
  );
  expect(name).toBe("HoldoutLockError");
});

test("11: repeats > 1 honours the repeat count and stays deterministic for the seed", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const fixtures: FixtureInput[] = [
    { family_id: "fam-syn-f00", variant_id: "v1", split: "dev" },
    { family_id: "fam-syn-f01", variant_id: "v1", split: "dev" },
  ];
  const first = planPairedRun()(baseOpts({ fixtures, repeats: 3 }));
  const second = planPairedRun()(baseOpts({ fixtures, repeats: 3 }));
  expect(first).toEqual(second);
  expect(first.schedule).toHaveLength(12);
  const byBlock = new Map<number, ScheduleItem[]>();
  for (const item of first.schedule) {
    const list = byBlock.get(item.block) ?? [];
    list.push(item);
    byBlock.set(item.block, list);
  }
  expect([...byBlock.keys()].sort((lhs, rhs) => lhs - rhs)).toEqual([0, 1, 2, 3, 4, 5]);
  for (const [block, items] of byBlock) {
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.arm).sort()).toEqual(["bounded_repair", "minimal"]);
    expect(items.every((item) => item.repeat === (block % 3) + 1)).toBe(true);
    const expectedFamily = fixtures[Math.floor(block / 3)]?.family_id;
    expect(items.every((item) => item.family_id === expectedFamily)).toBe(true);
  }
  const counts = new Map<string, number>();
  for (const item of first.schedule) {
    const key = `${item.family_id}:${item.arm}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  expect([...counts.values()].sort()).toEqual([3, 3, 3, 3]);
});

test("12: duplicate fixtures collapse to one scheduled fixture per repeat", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const dup = planPairedRun()(
    baseOpts({
      fixtures: [
        { family_id: "fam-syn-a", variant_id: "v1", split: "dev" },
        { family_id: "fam-syn-a", variant_id: "v1", split: "dev" },
        { family_id: "fam-syn-b", variant_id: "v1", split: "dev" },
      ],
      repeats: 2,
    }),
  );
  expect(dup.schedule).toHaveLength(8);
  const blockFixture = new Map<number, string>();
  const perBlockCount = new Map<number, number>();
  for (const item of dup.schedule) {
    const fixtureKey = `${item.family_id}/${item.variant_id}`;
    const seen = blockFixture.get(item.block);
    if (seen === undefined) {
      blockFixture.set(item.block, fixtureKey);
    } else {
      expect(seen).toBe(fixtureKey);
    }
    perBlockCount.set(item.block, (perBlockCount.get(item.block) ?? 0) + 1);
  }
  expect(blockFixture.size).toBe(4);
  expect([...perBlockCount.values()].sort()).toEqual([2, 2, 2, 2]);
  expect(new Set(blockFixture.values()).size).toBe(2);
  const overlap = planPairedRun()(
    baseOpts({
      fixtures: [
        { family_id: "fam-syn-a", variant_id: "v1", split: "dev" },
        { family_id: "fam-777", variant_id: "v1", split: "dev" },
      ],
      lock: LOCK777,
      unseal: TOKEN,
    }),
  );
  expect(overlap.holdout).toBe("unsealed");
  const locked = overlap.schedule.filter((item) => item.family_id === "fam-777");
  expect(locked).toHaveLength(2);
  expect(new Set(locked.map((item) => item.block)).size).toBe(1);
});

test("12b: a real-entry lock without a token seals the plan even with dev-only fixtures", () => {
  expect(mod).not.toBeNull();
  if (!mod) {
    return;
  }
  const sealed = planPairedRun()(
    baseOpts({
      fixtures: [{ family_id: "fam-syn-a", variant_id: "v1", split: "dev" }],
      lock: LOCK777,
      unseal: null,
    }),
  );
  expect(sealed.holdout).toBe("sealed");
  expect(sealed.schedule.every((item) => item.family_id === "fam-syn-a")).toBe(true);
  expect(sealed.schedule).toHaveLength(2);
});
