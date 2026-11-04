import { z } from "zod";

import type { HoldoutLockEntry } from "./fixture.js";
import type { Episode, RecipeSchema } from "./manifest.js";

import { type ClassifiedEpisode, classifyEpisode, type Verifier } from "./aggregate.js";
import { canonicalJson } from "./canonical.js";
import { unsealHoldout, verifyHoldoutLock } from "./holdout.js";
import { clusterBootstrap, type Interval, wilson } from "./stats.js";

type Recipe = z.infer<typeof RecipeSchema>;

const DEFAULT_BOOTSTRAP_REPLICATES = 2000;

const PAIR_KEYS = [
  "fixture_ref",
  "base_sha",
  "dependency_lock_sha256",
  "effective_model",
  "tools_sha",
  "limits",
  "seed",
] as const;

class ObservationalComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationalComparisonError";
  }
}

type RecipeArm = Recipe["arm"];

type UnsealToken = ReturnType<typeof unsealHoldout>;

type HoldoutStatus = "none" | "sealed" | "unsealed";

type GateItem = {
  split: string;
  family_id: string;
  task_refs?: { issues: readonly number[]; bundle_ids: readonly string[] };
};

type HoldoutGate = {
  unsealed: boolean;
  realEntries: number;
  entries: readonly HoldoutLockEntry[];
  isSealed(item: GateItem): boolean;
};

type SealedLookup = {
  lockFamilies: Set<string>;
  lockIssues: Set<number>;
  lockBundles: Set<string>;
};

function sealedLookup(entries: readonly HoldoutLockEntry[]): SealedLookup {
  const lockFamilies = new Set<string>();
  const lockIssues = new Set<number>();
  const lockBundles = new Set<string>();
  for (const entry of entries) {
    lockFamilies.add(entry.family_id);
    if (entry.root.kind === "issue") lockIssues.add(entry.root.number);
    if (entry.root.kind === "operator_bundle") lockBundles.add(entry.root.id);
  }
  return { lockFamilies, lockIssues, lockBundles };
}

function holdoutGate(lock: unknown, token: UnsealToken | null): HoldoutGate {
  if (lock === null) {
    return {
      unsealed: false,
      realEntries: 0,
      entries: [],
      isSealed: (item) => item.split === "holdout",
    };
  }
  const verified = verifyHoldoutLock(lock);
  const { lockFamilies, lockIssues, lockBundles } = sealedLookup(verified.entries);
  const unsealed = token !== null && token.lock_digest === verified.digest;
  const realEntries = verified.entries.filter((entry) => !entry.synthetic).length;
  return {
    unsealed,
    realEntries,
    entries: verified.entries,
    isSealed: (item) =>
      item.split === "holdout" ||
      lockFamilies.has(item.family_id) ||
      (item.task_refs?.issues.some((issue) => lockIssues.has(issue)) ?? false) ||
      (item.task_refs?.bundle_ids.some((bundleId) => lockBundles.has(bundleId)) ?? false),
  };
}

function applyHoldoutGate<T extends GateItem>(
  items: readonly T[],
  gate: HoldoutGate,
): { status: HoldoutStatus; kept: T[] } {
  if (gate.unsealed) {
    return { status: "unsealed", kept: [...items] };
  }
  if (items.some((item) => gate.isSealed(item)) || gate.realEntries > 0) {
    return { status: "sealed", kept: items.filter((item) => !gate.isSealed(item)) };
  }
  return { status: "none", kept: [...items] };
}

type FixtureResolver = (ref: Episode["fixture_ref"]) => unknown;

type CompareOptions = {
  baseline: RecipeArm;
  treatment: RecipeArm;
  recipes: readonly Recipe[];
  verifier: Verifier;
  resolveFixture: FixtureResolver;
  lock: unknown;
  unseal: UnsealToken | null;
  minFamilies: number;
  seed: number;
  B?: number;
};

type Exclusion = { episode_id: string; reason: string };

type ArmReport = {
  s: number;
  n: number;
  n_unknown: number;
  n_excluded: number;
  rate: number | null;
  wilson: Interval | null;
  cluster_ci: Interval | null;
};

type PairedReport = {
  n_pairs: number;
  n_families: number;
  underpowered: boolean;
  baseline: ArmReport;
  treatment: ArmReport;
  discordant: { baseline_only: number; treatment_only: number };
  excluded: Exclusion[];
  holdout: HoldoutStatus;
};

type KeyedEpisode = { episode: Episode; recipe: Recipe; key: string[] };

function resolveEpisode(
  ep: Episode,
  byId: Map<string, Recipe>,
  baseline: RecipeArm,
  treatment: RecipeArm,
): KeyedEpisode | { reason: string } {
  const recipe = ep.recipe_id === null ? undefined : byId.get(ep.recipe_id);
  if (recipe === undefined) {
    return { reason: "recipe_unresolved" };
  }
  if (recipe.arm !== baseline && recipe.arm !== treatment) {
    return { reason: "arm_not_compared" };
  }
  const effective = ep.model_identity.effective;
  if (effective.provenance !== "acp_selected" && effective.provenance !== "qualified_artifact") {
    return { reason: "effective_model_unattested" };
  }
  const baseSha = ep.repo.base_sha;
  if (baseSha === null) {
    return { reason: "missing:base_sha" };
  }
  const dependencyLock = ep.repo.dependency_lock_sha256;
  if (dependencyLock === null) {
    return { reason: "missing:dependency_lock_sha256" };
  }
  const toolsSha = ep.harness_build.sha;
  if (toolsSha === null) {
    return { reason: "missing:tools_sha" };
  }
  const model = effective.value;
  if (model === null) {
    return { reason: "effective_model_unattested" };
  }
  return {
    episode: ep,
    recipe,
    key: [
      canonicalJson(ep.fixture_ref),
      baseSha,
      dependencyLock,
      model,
      toolsSha,
      canonicalJson(recipe.limits),
      canonicalJson(recipe.seed),
    ],
  };
}

function resolveEpisodes(
  episodes: readonly Episode[],
  opts: CompareOptions,
): { keyed: KeyedEpisode[]; excluded: Exclusion[] } {
  const byId = new Map<string, Recipe>();
  for (const recipe of opts.recipes) {
    byId.set(recipe.recipe_id, recipe);
  }
  const excluded: Exclusion[] = [];
  const keyed: KeyedEpisode[] = [];
  for (const episode of episodes) {
    const resolved = resolveEpisode(episode, byId, opts.baseline, opts.treatment);
    if ("reason" in resolved) {
      excluded.push({ episode_id: episode.episode_id, reason: resolved.reason });
    } else {
      keyed.push(resolved);
    }
  }
  return { keyed, excluded };
}

type Unit = { arm: RecipeArm; key: string[]; episodes: Episode[] };

function groupUnits(
  keyed: readonly KeyedEpisode[],
  baseline: RecipeArm,
): { baseline: Map<string, Unit>; treatment: Map<string, Unit> } {
  const units = new Map<string, Unit>();
  for (const item of keyed) {
    const unitId = `${item.recipe.arm}\u0000${item.key.join("\u0000")}`;
    const existing = units.get(unitId);
    if (existing === undefined) {
      units.set(unitId, { arm: item.recipe.arm, key: item.key, episodes: [item.episode] });
    } else {
      existing.episodes.push(item.episode);
    }
  }
  const baselineUnits = new Map<string, Unit>();
  const treatmentUnits = new Map<string, Unit>();
  for (const unit of units.values()) {
    const joined = unit.key.join("\u0000");
    if (unit.arm === baseline) {
      baselineUnits.set(joined, unit);
    } else {
      treatmentUnits.set(joined, unit);
    }
  }
  return { baseline: baselineUnits, treatment: treatmentUnits };
}

function unitFamily(unit: Unit): string {
  const first = unit.episodes[0];
  const ref = first?.fixture_ref ?? null;
  return ref?.family_id ?? first?.family_id ?? "";
}

function prefixLength(lhs: readonly string[], rhs: readonly string[]): number {
  let length = 0;
  while (length < lhs.length && length < rhs.length && lhs[length] === rhs[length]) {
    length += 1;
  }
  return length;
}

function counterpartReason(unit: Unit, pool: readonly Unit[]): string {
  if (pool.length === 0) {
    return "no_partner";
  }
  const sorted = [...pool].sort((lhs, rhs) => {
    const left = canonicalJson(lhs.key);
    const right = canonicalJson(rhs.key);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  let bestMatch = -1;
  for (const candidate of sorted) {
    const match = prefixLength(unit.key, candidate.key);
    if (match > bestMatch) {
      bestMatch = match;
    }
  }
  const differingKey = PAIR_KEYS[bestMatch];
  return differingKey === undefined ? "no_partner" : `mismatch:${differingKey}`;
}

type Pair = { baseline: Unit; treatment: Unit };

function pushUnpairedExclusions(
  units: readonly Unit[],
  pool: readonly Unit[],
  excluded: Exclusion[],
): void {
  for (const unit of units) {
    const reason = counterpartReason(unit, pool);
    for (const episode of unit.episodes) {
      excluded.push({ episode_id: episode.episode_id, reason });
    }
  }
}

function pairUnits(
  baselineUnits: Map<string, Unit>,
  treatmentUnits: Map<string, Unit>,
  excluded: Exclusion[],
): Pair[] {
  const pairs: Pair[] = [];
  const unpairedBaseline: Unit[] = [];
  const unpairedTreatment: Unit[] = [];
  for (const [joined, unit] of baselineUnits) {
    const partner = treatmentUnits.get(joined);
    if (partner === undefined) {
      unpairedBaseline.push(unit);
    } else {
      pairs.push({ baseline: unit, treatment: partner });
    }
  }
  for (const [joined, unit] of treatmentUnits) {
    if (!baselineUnits.has(joined)) {
      unpairedTreatment.push(unit);
    }
  }
  pushUnpairedExclusions(unpairedBaseline, unpairedTreatment, excluded);
  pushUnpairedExclusions(unpairedTreatment, unpairedBaseline, excluded);
  return pairs;
}

type UnitOutcome = ClassifiedEpisode["kind"];

async function collapseOutcome(
  unit: Unit,
  opts: { verifier: Verifier; resolveFixture: FixtureResolver },
): Promise<UnitOutcome> {
  let outcome: UnitOutcome | null = null;
  for (const episode of unit.episodes) {
    const { kind } = await classifyEpisode(episode, opts);
    if (outcome === null || outcome === kind) {
      outcome = kind;
      continue;
    }
    const solveOrFailure = new Set<UnitOutcome>(["solve", "model_failure"]);
    outcome = solveOrFailure.has(outcome) && solveOrFailure.has(kind) ? "model_failure" : "unknown";
  }
  return outcome ?? "unknown";
}

type ScoredPair = { familyId: string; baseline: UnitOutcome; treatment: UnitOutcome };

async function scorePairs(
  pairs: readonly Pair[],
  opts: { verifier: Verifier; resolveFixture: FixtureResolver },
): Promise<ScoredPair[]> {
  const scored: ScoredPair[] = [];
  for (const pair of pairs) {
    scored.push({
      familyId: unitFamily(pair.baseline),
      baseline: await collapseOutcome(pair.baseline, opts),
      treatment: await collapseOutcome(pair.treatment, opts),
    });
  }
  return scored;
}

type FamilyTally = { s: number; n: number };

type ArmAgg = {
  s: number;
  n: number;
  nUnknown: number;
  nExcluded: number;
  families: Map<string, FamilyTally>;
};

function newArmAgg(): ArmAgg {
  return { s: 0, n: 0, nUnknown: 0, nExcluded: 0, families: new Map() };
}

function familyTally(families: Map<string, FamilyTally>, familyId: string): FamilyTally {
  const existing = families.get(familyId);
  if (existing !== undefined) {
    return existing;
  }
  const created: FamilyTally = { s: 0, n: 0 };
  families.set(familyId, created);
  return created;
}

function accumulateOutcome(agg: ArmAgg, familyId: string, outcome: UnitOutcome): void {
  if (outcome === "solve") {
    agg.s += 1;
    agg.n += 1;
    const family = familyTally(agg.families, familyId);
    family.s += 1;
    family.n += 1;
    return;
  }
  if (outcome === "model_failure") {
    agg.n += 1;
    familyTally(agg.families, familyId).n += 1;
    return;
  }
  if (outcome === "unknown") {
    agg.nUnknown += 1;
    return;
  }
  agg.nExcluded += 1;
}

function finalizeArm(agg: ArmAgg, underpowered: boolean, seed: number, B: number): ArmReport {
  const clusters = [...agg.families.values()].map((family) => ({ s: family.s, n: family.n }));
  return {
    s: agg.s,
    n: agg.n,
    n_unknown: agg.nUnknown,
    n_excluded: agg.nExcluded,
    rate: agg.n === 0 ? null : agg.s / agg.n,
    wilson: wilson(agg.s, agg.n),
    cluster_ci: underpowered ? null : clusterBootstrap(clusters, { seed, B }),
  };
}

function compareExclusions(lhs: Exclusion, rhs: Exclusion): number {
  if (lhs.episode_id !== rhs.episode_id) {
    return lhs.episode_id < rhs.episode_id ? -1 : 1;
  }
  if (lhs.reason !== rhs.reason) {
    return lhs.reason < rhs.reason ? -1 : 1;
  }
  return 0;
}

async function comparePaired(
  episodes: readonly Episode[],
  opts: CompareOptions,
): Promise<PairedReport> {
  if (opts.baseline === opts.treatment) {
    throw new RangeError("baseline and treatment arms must differ");
  }
  if (episodes.some((episode) => episode.design === "observational")) {
    throw new ObservationalComparisonError("paired comparison requires controlled episodes only");
  }
  const gate = holdoutGate(opts.lock, opts.unseal);
  const { status: holdout, kept } = applyHoldoutGate(episodes, gate);
  const { keyed, excluded } = resolveEpisodes(kept, opts);
  const groups = groupUnits(keyed, opts.baseline);
  const pairs = pairUnits(groups.baseline, groups.treatment, excluded);
  const scored = await scorePairs(pairs, {
    verifier: opts.verifier,
    resolveFixture: opts.resolveFixture,
  });

  const baselineAgg = newArmAgg();
  const treatmentAgg = newArmAgg();
  let baselineOnly = 0;
  let treatmentOnly = 0;
  for (const pair of scored) {
    accumulateOutcome(baselineAgg, pair.familyId, pair.baseline);
    accumulateOutcome(treatmentAgg, pair.familyId, pair.treatment);
    if (pair.baseline === "solve" && pair.treatment === "model_failure") {
      baselineOnly += 1;
    } else if (pair.baseline === "model_failure" && pair.treatment === "solve") {
      treatmentOnly += 1;
    }
  }

  const nFamilies = new Set(scored.map((pair) => pair.familyId)).size;
  const underpowered = nFamilies < opts.minFamilies;
  const B = opts.B ?? DEFAULT_BOOTSTRAP_REPLICATES;
  excluded.sort(compareExclusions);
  return {
    n_pairs: scored.length,
    n_families: nFamilies,
    underpowered,
    baseline: finalizeArm(baselineAgg, underpowered, opts.seed, B),
    treatment: finalizeArm(treatmentAgg, underpowered, opts.seed, B),
    discordant: { baseline_only: baselineOnly, treatment_only: treatmentOnly },
    excluded,
    holdout,
  };
}

export {
  applyHoldoutGate,
  type ArmReport,
  type CompareOptions,
  comparePaired,
  type Exclusion,
  type GateItem,
  type HoldoutGate,
  holdoutGate,
  type HoldoutStatus,
  type KeyedEpisode,
  ObservationalComparisonError,
  PAIR_KEYS,
  type PairedReport,
  type Recipe,
  type RecipeArm,
  type UnsealToken,
};
