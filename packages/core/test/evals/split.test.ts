import { expect, test } from "bun:test";

import { handoffRefDigest } from "@src/evals/canonical.js";
import {
  familyIdForRoot,
  type FixturePublic,
  FixturePublicSchema,
  type HoldoutLock,
  type HoldoutLockEntry,
  HoldoutLockEntrySchema,
  HoldoutLockSchema,
} from "@src/evals/fixture.js";

type JsonObject = Record<string, unknown>;

interface LineageHit {
  family_id: string;
  split: string | null;
  fixture_ref: { family_id: string; variant_id: string } | null;
}

interface IndexEntry {
  family_id: string;
  split: string | null;
  variant_id: string;
  kind: string;
}

interface FamilyIndex {
  byHandoffDigest: Map<string, IndexEntry>;
  byTaskDigest: Map<string, IndexEntry>;
}

const SHA40 = "a".repeat(40);
const SHA40_B = "b".repeat(40);
const HEX64_A = "a".repeat(64);
const HEX64_B = "b".repeat(64);
const HEX64_C = "c".repeat(64);
const HEX64_D = "d".repeat(64);
const HEX64_E = "e".repeat(64);
const HEX64_F = "f".repeat(64);

const loadOptional = async (p: string): Promise<Record<string, unknown>> => {
  try {
    return (await import(p)) as Record<string, unknown>;
  } catch (e) {
    const message = (e as { message?: unknown } | null | undefined)?.message;
    if (typeof message === "string" && /Cannot find (?:module|package)/i.test(message)) {
      return {};
    }
    throw e;
  }
};

const split = await loadOptional("@src/evals/split.js");
const holdout = await loadOptional("@src/evals/holdout.js");
const mods: Record<string, unknown> = { ...holdout, ...split };

const fn = (mod: Record<string, unknown>, name: string): ((...args: unknown[]) => unknown) => {
  const member = mod[name];
  expect(typeof member).toBe("function");
  return member as (...args: unknown[]) => unknown;
};

const expectThrows = (
  thunk: () => unknown,
  mod: Record<string, unknown>,
  errName: string,
): void => {
  const ctor = mod[errName];
  expect(typeof ctor).toBe("function");
  expect(thunk).toThrow(ctor);
};

function pubFixture(overrides: JsonObject = {}): FixturePublic {
  return FixturePublicSchema.parse({
    schema_version: 1,
    family_id: "fam-379",
    variant_id: "v1",
    root: { kind: "issue", number: 379 },
    reconstructs: null,
    failure_type: "lost_evidence",
    split: "dev",
    synthetic: false,
    base_sha: SHA40,
    task_digest: HEX64_D,
    source_root_handoff_digests: [],
    expect_blocked: false,
    hidden_ref: { assertion_set_digest: HEX64_C },
    content_digest: HEX64_B,
    ...overrides,
  });
}

function lockEntry(overrides: JsonObject = {}): HoldoutLockEntry {
  return HoldoutLockEntrySchema.parse({
    family_id: "fam-390",
    variant_id: "a",
    root: { kind: "issue", number: 390 },
    failure_type: "lost_evidence",
    synthetic: false,
    expect_blocked: false,
    base_sha: SHA40,
    task_digest: HEX64_D,
    source_root_handoff_digests: [],
    content_digest: HEX64_E,
    assertion_set_digest: HEX64_F,
    ...overrides,
  });
}

function makeLock(entries: HoldoutLockEntry[], digest: unknown): HoldoutLock {
  return HoldoutLockSchema.parse({ schema_version: 1, entries, digest });
}

test("case 1: assignSplit is a pure function of (family, salt); an explicit assignment wins", () => {
  const assignSplit = fn(split, "assignSplit");
  const salt = "p2-split-salt";
  const families = Array.from({ length: 1050 }, (_, i) => `fam-auto-${String(i)}`);
  const originals = families.slice(0, 50);
  const before = new Map<string, unknown>(
    originals.map((f): [string, unknown] => [f, assignSplit(f, salt)]),
  );
  for (const f of families.slice(50)) {
    assignSplit(f, salt);
  }
  for (const f of originals) {
    expect(assignSplit(f, salt)).toBe(before.get(f));
  }
  const probe = originals[0]!;
  expect(assignSplit(probe, salt)).toBe(assignSplit(probe, salt));
  expect(assignSplit("fam-390", salt, { explicit: { "fam-390": "holdout" } })).toBe("holdout");
  const assigned = new Set<unknown>();
  for (const f of families) {
    assigned.add(assignSplit(f, salt));
  }
  expect(assigned.has("train")).toBe(true);
  expect(assigned.has("dev")).toBe(true);
  for (const v of assigned) {
    expect(v === "train" || v === "dev").toBe(true);
  }
});

test("case 2: unindexed lineages get deterministic fam-h-* ids from task digest or first handoff", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const emptyIndex = buildFamilyIndex([], []);
  const task = HEX64_D;
  const expectedTaskFam = `fam-h-t${task.slice(0, 12)}`;
  expect(familyIdForLineage({ handoff_ids: ["h1", "h2"], task_digest: task }, emptyIndex)).toEqual({
    family_id: expectedTaskFam,
    split: null,
    fixture_ref: null,
  });
  expect(familyIdForLineage({ handoff_ids: ["h9"], task_digest: task }, emptyIndex)).toEqual({
    family_id: expectedTaskFam,
    split: null,
    fixture_ref: null,
  });
  expect(familyIdForLineage({ handoff_ids: ["h1", "h2"], task_digest: null }, emptyIndex)).toEqual({
    family_id: `fam-h-${handoffRefDigest("h1").slice(0, 12)}`,
    split: null,
    fixture_ref: null,
  });
});

test("case 3: one family id appearing in two splits throws", () => {
  const assertNoFamilyLeak = fn(split, "assertNoFamilyLeak");
  expect(() =>
    assertNoFamilyLeak([
      { family_id: "fam-390", split: "dev", base_sha: SHA40, task_digest: HEX64_D },
      { family_id: "fam-390", split: "holdout", base_sha: SHA40_B, task_digest: HEX64_E },
    ]),
  ).toThrow();
  expect(() =>
    assertNoFamilyLeak([
      { family_id: "fam-390", split: "dev", base_sha: SHA40, task_digest: HEX64_D },
      { family_id: "fam-390", split: "dev", base_sha: SHA40_B, task_digest: HEX64_E },
    ]),
  ).not.toThrow();
});

test("case 4: a task_digest crossing splits throws whatever the base; within one split the (base, task_digest) pair dedups", () => {
  const assertNoFamilyLeak = fn(split, "assertNoFamilyLeak");
  const a = SHA40;
  const b = SHA40_B;
  const t = HEX64_D;
  expect(() =>
    assertNoFamilyLeak([
      { family_id: "fam-379", split: "dev", base_sha: a, task_digest: t },
      { family_id: "fam-op-x", split: "holdout", base_sha: b, task_digest: t },
    ]),
  ).toThrow();
  expect(() =>
    assertNoFamilyLeak([
      { family_id: "fam-379", split: "dev", base_sha: a, task_digest: t },
      { family_id: "fam-380", split: "dev", base_sha: b, task_digest: t },
    ]),
  ).not.toThrow();
  expect(() =>
    assertNoFamilyLeak([
      { family_id: "fam-379", split: "dev", base_sha: a, task_digest: t },
      { family_id: "fam-380", split: "dev", base_sha: a, task_digest: t },
    ]),
  ).toThrow();
});

test("case 5: a synthetic fixture and the real issue it reconstructs resolve to different families", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const synthetic = pubFixture({
    family_id: "fam-syn-xyz",
    root: { kind: "synthetic", id: "xyz" },
    synthetic: true,
    reconstructs: { kind: "issue", number: 390 },
    failure_type: null,
    task_digest: HEX64_E,
  });
  const real = pubFixture({
    family_id: "fam-390",
    root: { kind: "issue", number: 390 },
    task_digest: HEX64_D,
    source_root_handoff_digests: [handoffRefDigest("h-real-390")],
  });
  const index = buildFamilyIndex([synthetic, real], []);
  expect(familyIdForLineage({ handoff_ids: ["h-real-390"], task_digest: HEX64_D }, index)).toEqual({
    family_id: "fam-390",
    split: "dev",
    fixture_ref: { family_id: "fam-390", variant_id: "v1" },
  });
  const synFam = familyIdForRoot({ kind: "synthetic", id: "xyz" });
  expect(synFam).not.toBe("fam-390");
  expect(familyIdForLineage({ handoff_ids: [], task_digest: HEX64_E }, index)).toEqual({
    family_id: synFam,
    split: "dev",
    fixture_ref: { family_id: synFam, variant_id: "v1" },
  });
});

test("case 10: a lock hit on the round-2 root seals the whole lineage for tuning", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const selectForTuning = fn(split, "selectForTuning");
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const entry = lockEntry({
    family_id: "fam-777",
    root: { kind: "issue", number: 777 },
    source_root_handoff_digests: [handoffRefDigest("r2")],
  });
  const index = buildFamilyIndex([], [entry]);
  const res = familyIdForLineage(
    { handoff_ids: ["r1", "r2"], task_digest: HEX64_A },
    index,
  ) as LineageHit;
  expect(res).toEqual({ family_id: "fam-777", split: "holdout", fixture_ref: null });
  const entries = [entry];
  const lock = makeLock(entries, computeLockDigest(entries));
  expectThrows(
    () =>
      selectForTuning(
        [
          {
            family_id: res.family_id,
            split: res.split,
            task_refs: { issues: [], bundle_ids: [] },
          },
        ],
        { lock },
      ),
    mods,
    "HoldoutAccessError",
  );
});

test("case 11: selectForTuning throws on a holdout item instead of filtering it out", () => {
  const selectForTuning = fn(split, "selectForTuning");
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const lock = makeLock([], computeLockDigest([]));
  const devItem = {
    family_id: "fam-100",
    split: "dev",
    task_refs: { issues: [], bundle_ids: [] },
  };
  const holdoutItem = {
    family_id: "fam-999",
    split: "holdout",
    task_refs: { issues: [], bundle_ids: [] },
  };
  expectThrows(() => selectForTuning([devItem, holdoutItem], { lock }), mods, "HoldoutAccessError");
  const kept = selectForTuning([devItem], { lock });
  expect(Array.isArray(kept)).toBe(true);
  expect(kept).toEqual([devItem]);
});

test("case 13: handoff ids resolving to two distinct families throw FamilyConflictError", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const fixture = pubFixture({
    source_root_handoff_digests: [handoffRefDigest("a")],
  });
  const entry = lockEntry({
    family_id: "fam-999",
    root: { kind: "issue", number: 999 },
    task_digest: HEX64_E,
    source_root_handoff_digests: [handoffRefDigest("b")],
  });
  const index = buildFamilyIndex([fixture], [entry]);
  expectThrows(
    () => familyIdForLineage({ handoff_ids: ["a", "b"], task_digest: HEX64_F }, index),
    mods,
    "FamilyConflictError",
  );
});

test("case 14: a task_digest matching a lock entry inherits the lock family", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const entry = lockEntry({
    family_id: "fam-999",
    root: { kind: "issue", number: 999 },
    task_digest: HEX64_D,
  });
  const index = buildFamilyIndex([], [entry]);
  expect(familyIdForLineage({ handoff_ids: ["zz-nohit"], task_digest: HEX64_D }, index)).toEqual({
    family_id: "fam-999",
    split: "holdout",
    fixture_ref: null,
  });
});

test("case 15: task_refs intersecting a lock root gate tuning independently of family_id", () => {
  const selectForTuning = fn(split, "selectForTuning");
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const e390 = lockEntry();
  const e777 = lockEntry({ family_id: "fam-777", root: { kind: "issue", number: 777 } });
  const eCanary = lockEntry({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  const lock390 = makeLock([e390], computeLockDigest([e390]));
  const lock390777 = makeLock([e390, e777], computeLockDigest([e390, e777]));
  const lockCanary = makeLock([eCanary], computeLockDigest([eCanary]));
  const issueItem = {
    family_id: "fam-100",
    split: "dev",
    task_refs: { issues: [777], bundle_ids: [] },
  };
  expect(() => selectForTuning([issueItem], { lock: lock390 })).not.toThrow();
  expectThrows(
    () => selectForTuning([issueItem], { lock: lock390777 }),
    mods,
    "HoldoutAccessError",
  );
  const bundleItem = {
    family_id: "fam-100",
    split: "dev",
    task_refs: { issues: [], bundle_ids: ["canary"] },
  };
  expectThrows(
    () => selectForTuning([bundleItem], { lock: lockCanary }),
    mods,
    "HoldoutAccessError",
  );
  expect(() => selectForTuning([bundleItem], { lock: lock390 })).not.toThrow();
});

test("case 16: a public-fixture hit reports fixture_ref while a lock hit leaves it null", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const fixture = pubFixture({
    source_root_handoff_digests: [handoffRefDigest("pubh")],
  });
  const entry = lockEntry({
    family_id: "fam-999",
    root: { kind: "issue", number: 999 },
    task_digest: HEX64_E,
    source_root_handoff_digests: [handoffRefDigest("lockh")],
  });
  const index = buildFamilyIndex([fixture], [entry]) as FamilyIndex;
  expect(index.byHandoffDigest instanceof Map).toBe(true);
  expect(index.byTaskDigest instanceof Map).toBe(true);
  expect(index.byHandoffDigest.get(handoffRefDigest("pubh"))).toEqual({
    family_id: "fam-379",
    split: "dev",
    variant_id: "v1",
    kind: "public",
  });
  expect(index.byTaskDigest.get(HEX64_D)).toEqual({
    family_id: "fam-379",
    split: "dev",
    variant_id: "v1",
    kind: "public",
  });
  expect(index.byHandoffDigest.get(handoffRefDigest("lockh"))).toEqual({
    family_id: "fam-999",
    split: "holdout",
    variant_id: "a",
    kind: "lock",
  });
  expect(familyIdForLineage({ handoff_ids: ["pubh"], task_digest: HEX64_A }, index)).toEqual({
    family_id: "fam-379",
    split: "dev",
    fixture_ref: { family_id: "fam-379", variant_id: "v1" },
  });
  expect(familyIdForLineage({ handoff_ids: ["lockh"], task_digest: HEX64_A }, index)).toEqual({
    family_id: "fam-999",
    split: "holdout",
    fixture_ref: null,
  });
});

test("case 17: a task_digest shared across public families conflicts on lookup; a handoff hit takes precedence", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const sharedTask = HEX64_D;
  const f379 = pubFixture({
    task_digest: sharedTask,
    source_root_handoff_digests: [handoffRefDigest("p")],
  });
  const f380 = pubFixture({
    family_id: "fam-380",
    root: { kind: "issue", number: 380 },
    task_digest: sharedTask,
    source_root_handoff_digests: [handoffRefDigest("q")],
  });
  const index = buildFamilyIndex([f379, f380], []);
  expectThrows(
    () => familyIdForLineage({ handoff_ids: ["zz-nohit"], task_digest: sharedTask }, index),
    mods,
    "FamilyConflictError",
  );
  expect(familyIdForLineage({ handoff_ids: ["p"], task_digest: sharedTask }, index)).toEqual({
    family_id: "fam-379",
    split: "dev",
    fixture_ref: { family_id: "fam-379", variant_id: "v1" },
  });
  const sharedHandoff = handoffRefDigest("shared");
  const dup379 = pubFixture({
    task_digest: HEX64_E,
    source_root_handoff_digests: [sharedHandoff],
  });
  const dup380 = pubFixture({
    family_id: "fam-380",
    root: { kind: "issue", number: 380 },
    task_digest: HEX64_F,
    source_root_handoff_digests: [sharedHandoff],
  });
  expectThrows(() => buildFamilyIndex([dup379, dup380], []), mods, "FamilyConflictError");
});

test("case 71: selectForTuning seals a dev or train item whose family_id is in the lock, regardless of split or task_refs", () => {
  const selectForTuning = fn(split, "selectForTuning");
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const e390 = lockEntry();
  const lock = makeLock([e390], computeLockDigest([e390]));
  const devItem = {
    family_id: "fam-390",
    split: "dev",
    task_refs: { issues: [], bundle_ids: [] },
  };
  expectThrows(() => selectForTuning([devItem], { lock }), mods, "HoldoutAccessError");
  const trainItem = {
    family_id: "fam-390",
    split: "train",
    task_refs: { issues: [], bundle_ids: [] },
  };
  expectThrows(() => selectForTuning([trainItem], { lock }), mods, "HoldoutAccessError");
  const outsider = {
    family_id: "fam-100",
    split: "train",
    task_refs: { issues: [], bundle_ids: [] },
  };
  expect(selectForTuning([outsider], { lock })).toEqual([outsider]);
});

test("case 72: a shared digest claimed by a public fixture and a lock entry of the same family resolves to the lock entry", () => {
  const buildFamilyIndex = fn(split, "buildFamilyIndex");
  const familyIdForLineage = fn(split, "familyIdForLineage");
  const sharedTask = HEX64_D;
  const sharedHandoff = handoffRefDigest("shared-family");
  const fixture = pubFixture({
    task_digest: sharedTask,
    source_root_handoff_digests: [sharedHandoff],
  });
  const entry = lockEntry({
    family_id: "fam-379",
    root: { kind: "issue", number: 379 },
    task_digest: sharedTask,
    source_root_handoff_digests: [sharedHandoff],
  });
  const index = buildFamilyIndex([fixture], [entry]) as FamilyIndex;
  expect(index.byHandoffDigest.get(sharedHandoff)).toEqual({
    family_id: "fam-379",
    split: "holdout",
    variant_id: "a",
    kind: "lock",
  });
  expect(index.byTaskDigest.get(sharedTask)).toEqual({
    family_id: "fam-379",
    split: "holdout",
    variant_id: "a",
    kind: "lock",
  });
  expect(
    familyIdForLineage({ handoff_ids: ["shared-family"], task_digest: HEX64_A }, index),
  ).toEqual({ family_id: "fam-379", split: "holdout", fixture_ref: null });
  expect(familyIdForLineage({ handoff_ids: [], task_digest: sharedTask }, index)).toEqual({
    family_id: "fam-379",
    split: "holdout",
    fixture_ref: null,
  });
});
