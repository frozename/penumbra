import type { FixturePublic, HoldoutLock, HoldoutLockEntry } from "./fixture.js";

import { handoffRefDigest, sha256Hex } from "./canonical.js";

export type Split = "train" | "dev" | "holdout";

export class FamilyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyConflictError";
  }
}

export class FamilyLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FamilyLeakError";
  }
}

export class HoldoutAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoutAccessError";
  }
}

export function assignSplit(
  family_id: string,
  salt: string,
  opts: { explicit?: Readonly<Record<string, Split>>; devPercent?: number } = {},
): Split {
  const explicit = opts.explicit?.[family_id];
  if (explicit !== undefined) return explicit;
  const bucket = parseInt(sha256Hex(`${salt}\n${family_id}`).slice(0, 8), 16) % 100;
  return bucket < (opts.devPercent ?? 20) ? "dev" : "train";
}

export type FamilyIndexEntry = {
  family_id: string;
  split: Split;
  variant_id: string;
  kind: "public" | "lock";
};

type TaskIndexValue = FamilyIndexEntry | FamilyIndexEntry[];

export type FamilyIndex = {
  byHandoffDigest: Map<string, FamilyIndexEntry>;
  byTaskDigest: Map<string, TaskIndexValue>;
};

function toHits(value: TaskIndexValue): FamilyIndexEntry[] {
  return Array.isArray(value) ? value : [value];
}

function preferLock(existing: FamilyIndexEntry, incoming: FamilyIndexEntry): FamilyIndexEntry {
  if (existing.kind === "public" && incoming.kind === "lock") return incoming;
  return existing;
}

function mergeHandoffEntry(
  existing: FamilyIndexEntry | undefined,
  incoming: FamilyIndexEntry,
): FamilyIndexEntry {
  if (existing === undefined) return incoming;
  if (existing.family_id !== incoming.family_id) {
    throw new FamilyConflictError(
      `handoff digest claimed by families ${existing.family_id} and ${incoming.family_id}`,
    );
  }
  return preferLock(existing, incoming);
}

function mergeTaskHits(
  existing: TaskIndexValue | undefined,
  incoming: FamilyIndexEntry,
): TaskIndexValue {
  if (existing === undefined) return incoming;
  const hits = toHits(existing);
  if (!hits.some((hit) => hit.family_id === incoming.family_id)) {
    return [...hits, incoming];
  }
  const kept = hits.map((hit) =>
    hit.family_id === incoming.family_id ? preferLock(hit, incoming) : hit,
  );
  const only = kept.length === 1 ? kept[0] : undefined;
  return only ?? kept;
}

export function buildFamilyIndex(
  fixtures: readonly FixturePublic[],
  lockEntries: readonly HoldoutLockEntry[],
): FamilyIndex {
  const byHandoffDigest = new Map<string, FamilyIndexEntry>();
  const byTaskDigest = new Map<string, TaskIndexValue>();
  const add = (
    entry: FamilyIndexEntry,
    task_digest: string,
    handoffDigests: readonly string[],
  ): void => {
    for (const digest of handoffDigests) {
      byHandoffDigest.set(digest, mergeHandoffEntry(byHandoffDigest.get(digest), entry));
    }
    byTaskDigest.set(task_digest, mergeTaskHits(byTaskDigest.get(task_digest), entry));
  };
  for (const fixture of fixtures) {
    add(
      {
        family_id: fixture.family_id,
        split: fixture.split,
        variant_id: fixture.variant_id,
        kind: "public",
      },
      fixture.task_digest,
      fixture.source_root_handoff_digests,
    );
  }
  for (const entry of lockEntries) {
    add(
      {
        family_id: entry.family_id,
        split: "holdout",
        variant_id: entry.variant_id,
        kind: "lock",
      },
      entry.task_digest,
      entry.source_root_handoff_digests,
    );
  }
  return { byHandoffDigest, byTaskDigest };
}

export type LineageInput = {
  handoff_ids: readonly string[];
  task_digest: string | null;
};

export type LineageResolution = {
  family_id: string;
  split: Split | null;
  fixture_ref: { family_id: string; variant_id: string } | null;
};

function collectLineageHits(lineage: LineageInput, index: FamilyIndex): FamilyIndexEntry[] {
  const hits: FamilyIndexEntry[] = [];
  for (const handoffId of lineage.handoff_ids) {
    const hit = index.byHandoffDigest.get(handoffRefDigest(handoffId));
    if (hit !== undefined) hits.push(hit);
  }
  if (hits.length > 0 || lineage.task_digest === null) return hits;
  const value = index.byTaskDigest.get(lineage.task_digest);
  return value === undefined ? [] : toHits(value);
}

function unresolvedLineage(
  task_digest: string | null,
  firstHandoff: string | undefined,
): LineageResolution {
  if (task_digest !== null) {
    return {
      family_id: `fam-h-t${task_digest.slice(0, 12)}`,
      split: null,
      fixture_ref: null,
    };
  }
  if (firstHandoff === undefined) {
    throw new FamilyConflictError("lineage requires at least one handoff id or a task digest");
  }
  return {
    family_id: `fam-h-${handoffRefDigest(firstHandoff).slice(0, 12)}`,
    split: null,
    fixture_ref: null,
  };
}

export function familyIdForLineage(lineage: LineageInput, index: FamilyIndex): LineageResolution {
  const hits = collectLineageHits(lineage, index);
  const [first] = hits;
  if (first === undefined) {
    return unresolvedLineage(lineage.task_digest, lineage.handoff_ids[0]);
  }
  const families = new Set(hits.map((hit) => hit.family_id));
  if (families.size > 1) {
    throw new FamilyConflictError(
      `lineage resolves to conflicting families: ${[...families].sort().join(", ")}`,
    );
  }
  const publicHit = hits.find((hit) => hit.kind === "public");
  return {
    family_id: first.family_id,
    split: first.split,
    fixture_ref: publicHit
      ? { family_id: publicHit.family_id, variant_id: publicHit.variant_id }
      : null,
  };
}

export type LeakCheckItem = {
  family_id: string;
  split: Split;
  base_sha: string | null;
  task_digest: string | null;
};

function noteFamilySplit(familySplits: Map<string, Split>, item: LeakCheckItem): void {
  const previous = familySplits.get(item.family_id);
  if (previous !== undefined && previous !== item.split) {
    throw new FamilyLeakError(
      `family ${item.family_id} appears in splits ${previous} and ${item.split}`,
    );
  }
  familySplits.set(item.family_id, item.split);
}

function noteTaskSplit(taskSplits: Map<string, Split>, item: LeakCheckItem): void {
  if (item.task_digest === null) return;
  const previous = taskSplits.get(item.task_digest);
  if (previous !== undefined && previous !== item.split) {
    throw new FamilyLeakError(
      `task digest ${item.task_digest} appears in splits ${previous} and ${item.split}`,
    );
  }
  taskSplits.set(item.task_digest, item.split);
}

function notePairOwnership(pairFamilies: Map<string, string>, item: LeakCheckItem): void {
  if (item.base_sha === null || item.task_digest === null) return;
  const pairKey = `${item.base_sha}\u0000${item.task_digest}`;
  const previous = pairFamilies.get(pairKey);
  if (previous !== undefined && previous !== item.family_id) {
    throw new FamilyLeakError(
      `pair (base ${item.base_sha}, task ${item.task_digest}) shared by families ${previous} and ${item.family_id}`,
    );
  }
  pairFamilies.set(pairKey, item.family_id);
}

export function assertNoFamilyLeak(items: readonly LeakCheckItem[]): void {
  const familySplits = new Map<string, Split>();
  const taskSplits = new Map<string, Split>();
  const pairFamilies = new Map<string, string>();
  for (const item of items) {
    noteFamilySplit(familySplits, item);
    noteTaskSplit(taskSplits, item);
    notePairOwnership(pairFamilies, item);
  }
}

type TunableItem = {
  family_id: string;
  split: Split;
  task_refs: { issues: readonly number[]; bundle_ids: readonly string[] };
};

export function selectForTuning<T extends TunableItem>(
  items: readonly T[],
  opts: { lock: HoldoutLock },
): T[] {
  const lockFamilies = new Set<string>();
  const lockIssues = new Set<number>();
  const lockBundles = new Set<string>();
  for (const entry of opts.lock.entries) {
    lockFamilies.add(entry.family_id);
    if (entry.root.kind === "issue") lockIssues.add(entry.root.number);
    if (entry.root.kind === "operator_bundle") lockBundles.add(entry.root.id);
  }
  for (const item of items) {
    const sealed =
      item.split === "holdout" ||
      lockFamilies.has(item.family_id) ||
      item.task_refs.issues.some((issue) => lockIssues.has(issue)) ||
      item.task_refs.bundle_ids.some((bundleId) => lockBundles.has(bundleId));
    if (sealed) {
      throw new HoldoutAccessError(`item family ${item.family_id} is sealed for tuning`);
    }
  }
  return [...items];
}
