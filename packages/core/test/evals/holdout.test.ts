import { expect, test } from "bun:test";

import {
  type FixturePublic,
  FixturePublicSchema,
  type HoldoutLock,
  type HoldoutLockEntry,
  HoldoutLockEntrySchema,
  HoldoutLockSchema,
} from "@src/evals/fixture.js";

type JsonObject = Record<string, unknown>;

interface UnsealToken {
  lock_digest: string;
  analysis_plan_sha256: string;
  max_unseals: number;
}

interface ClosureEvidence {
  state: "OPEN" | "CLOSED";
  closing_commits: { sha: string; is_ancestor_of_head: boolean }[];
}

interface FixEvidence {
  issue_closure: ClosureEvidence | null;
  patch_id_hits: number;
  added_line_hits: number;
  head_sha: string;
}

const SHA40 = "a".repeat(40);
const SHA40_B = "b".repeat(40);
const SHA_CLOSING = "6bfebba9f" + "0".repeat(31);
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
const mods: Record<string, unknown> = { ...split, ...holdout };

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

function evidence(overrides: Partial<FixEvidence> = {}): FixEvidence {
  return {
    issue_closure: null,
    patch_id_hits: 0,
    added_line_hits: 0,
    head_sha: SHA40,
    ...overrides,
  };
}

test("case 6: verifyHoldoutLock binds the digest to the entries; computeLockDigest is order-insensitive", () => {
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const verifyHoldoutLock = fn(holdout, "verifyHoldoutLock");
  const e390 = lockEntry();
  const e777 = lockEntry({ family_id: "fam-777", root: { kind: "issue", number: 777 } });
  const eCanary = lockEntry({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  const entries = [e390, e777];
  const digest = computeLockDigest(entries);
  expect(() => verifyHoldoutLock({ schema_version: 1, entries, digest })).not.toThrow();
  const edited = entries.map((entry, i) =>
    i === 0 ? { ...entry, content_digest: HEX64_B } : entry,
  );
  expect(() => verifyHoldoutLock({ schema_version: 1, entries: edited, digest })).toThrow();
  expect(() =>
    verifyHoldoutLock({ schema_version: 1, entries: [...entries, eCanary], digest }),
  ).toThrow();
  expect(() =>
    verifyHoldoutLock({ schema_version: 1, entries: entries.slice(0, 1), digest }),
  ).toThrow();
  const badEntry = { ...e390, extra_field: 1 };
  expect(() =>
    verifyHoldoutLock({
      schema_version: 1,
      entries: [badEntry],
      digest: computeLockDigest([badEntry]),
    }),
  ).toThrow();
  expect(computeLockDigest([...entries].reverse())).toBe(digest);
});

test("case 7: unsealHoldout binds the lock digest to the issued token", () => {
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const unsealHoldout = fn(holdout, "unsealHoldout");
  const e390 = lockEntry();
  const e777 = lockEntry({ family_id: "fam-777", root: { kind: "issue", number: 777 } });
  const lock1 = makeLock([e390], computeLockDigest([e390]));
  const lock2 = makeLock([e777], computeLockDigest([e777]));
  const token1 = unsealHoldout(lock1, { sha256: HEX64_D, max_unseals: 3 }) as UnsealToken;
  expect(token1).toEqual({
    lock_digest: lock1.digest,
    analysis_plan_sha256: HEX64_D,
    max_unseals: 3,
  });
  const token2 = unsealHoldout(lock2, { sha256: HEX64_D, max_unseals: 3 }) as UnsealToken;
  expect(token2.lock_digest).toBe(lock2.digest);
  expect(token2.lock_digest).not.toBe(token1.lock_digest);
});

test("case 8: a public fixture whose root or reconstructs equals a non-synthetic lock root throws", () => {
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const assertHoldoutReservation = fn(holdout, "assertHoldoutReservation");
  const entry = lockEntry({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  const lock = makeLock([entry], computeLockDigest([entry]));
  const reconstructing = pubFixture({
    family_id: "fam-syn-xyz",
    root: { kind: "synthetic", id: "xyz" },
    synthetic: true,
    reconstructs: { kind: "operator_bundle", id: "canary" },
    failure_type: null,
  });
  expect(() => assertHoldoutReservation(lock, [reconstructing])).toThrow();
  const real = pubFixture({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  expect(() => assertHoldoutReservation(lock, [real])).toThrow();
  const unrelated = pubFixture();
  expect(() => assertHoldoutReservation(lock, [unrelated])).not.toThrow();
});

test("case 8b: root comparison requires matching kind, not just matching id", () => {
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const assertHoldoutReservation = fn(holdout, "assertHoldoutReservation");
  const entry = lockEntry({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  const lock = makeLock([entry], computeLockDigest([entry]));
  const syntheticCanary = pubFixture({
    family_id: "fam-syn-canary",
    root: { kind: "synthetic", id: "canary" },
    synthetic: true,
    reconstructs: null,
    failure_type: null,
  });
  expect(() => assertHoldoutReservation(lock, [syntheticCanary])).not.toThrow();
  const operatorCanary = pubFixture({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  expect(() => assertHoldoutReservation(lock, [operatorCanary])).toThrow();
});

test("case 9: assertNoPublicFix fails on reachable fixes, unknown closures, digest hits and head drift", () => {
  const assertNoPublicFix = fn(holdout, "assertNoPublicFix");
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const e390 = lockEntry();
  const eCanary = lockEntry({
    family_id: "fam-op-canary",
    root: { kind: "operator_bundle", id: "canary" },
  });
  const eAlpha = lockEntry({
    family_id: "fam-op-alpha",
    root: { kind: "operator_bundle", id: "alpha" },
  });
  const lock390 = makeLock([e390], computeLockDigest([e390]));
  const lockCanary = makeLock([eCanary], computeLockDigest([eCanary]));
  const closedAncestor = evidence({
    issue_closure: {
      state: "CLOSED",
      closing_commits: [{ sha: SHA_CLOSING, is_ancestor_of_head: true }],
    },
  });
  expectThrows(
    () => assertNoPublicFix(lock390, { "fam-390/a": closedAncestor }),
    mods,
    "PublicFixError",
  );
  expectThrows(
    () => assertNoPublicFix(lock390, { "fam-390/a": evidence() }),
    mods,
    "PublicFixError",
  );
  const closedNoCommits = evidence({
    issue_closure: { state: "CLOSED", closing_commits: [] },
  });
  expectThrows(
    () => assertNoPublicFix(lock390, { "fam-390/a": closedNoCommits }),
    mods,
    "PublicFixError",
  );
  expectThrows(() => assertNoPublicFix(lock390, {}), mods, "PublicFixError");
  const openClean = evidence({
    issue_closure: { state: "OPEN", closing_commits: [] },
  });
  expect(() => assertNoPublicFix(lock390, { "fam-390/a": openClean })).not.toThrow();
  const closedUnreachable = evidence({
    issue_closure: {
      state: "CLOSED",
      closing_commits: [{ sha: SHA_CLOSING, is_ancestor_of_head: false }],
    },
  });
  expect(() => assertNoPublicFix(lock390, { "fam-390/a": closedUnreachable })).not.toThrow();
  expectThrows(
    () => assertNoPublicFix(lockCanary, { "fam-op-canary/a": evidence({ patch_id_hits: 1 }) }),
    mods,
    "PublicFixError",
  );
  expectThrows(
    () => assertNoPublicFix(lockCanary, { "fam-op-canary/a": evidence({ added_line_hits: 1 }) }),
    mods,
    "PublicFixError",
  );
  expectThrows(() => assertNoPublicFix(lockCanary, {}), mods, "PublicFixError");
  expect(() => assertNoPublicFix(lockCanary, { "fam-op-canary/a": evidence() })).not.toThrow();
  const two = [eCanary, eAlpha];
  const lockTwo = makeLock(two, computeLockDigest(two));
  const drifting = {
    "fam-op-canary/a": evidence({ head_sha: SHA40 }),
    "fam-op-alpha/a": evidence({ head_sha: SHA40_B }),
  };
  expectThrows(() => assertNoPublicFix(lockTwo, drifting), mods, "PublicFixError");
  const aligned = {
    "fam-op-canary/a": evidence({ head_sha: SHA40_B }),
    "fam-op-alpha/a": evidence({ head_sha: SHA40_B }),
  };
  expect(() => assertNoPublicFix(lockTwo, aligned)).not.toThrow();
});

test("case 12: type_novel reports whether a lock failure type is novel without gating reservation", () => {
  const computeLockDigest = fn(holdout, "computeLockDigest");
  const assertHoldoutReservation = fn(holdout, "assertHoldoutReservation");
  const eLost = lockEntry({
    family_id: "fam-555",
    root: { kind: "issue", number: 555 },
    failure_type: "lost_evidence",
  });
  const eMissed = lockEntry({
    family_id: "fam-555",
    root: { kind: "issue", number: 555 },
    failure_type: "missed_commit",
  });
  const publicFixture = pubFixture();
  const lockLost = makeLock([eLost], computeLockDigest([eLost]));
  const lockMissed = makeLock([eMissed], computeLockDigest([eMissed]));
  expect(assertHoldoutReservation(lockLost, [publicFixture])).toEqual({ type_novel: false });
  expect(assertHoldoutReservation(lockMissed, [publicFixture])).toEqual({ type_novel: true });
});
