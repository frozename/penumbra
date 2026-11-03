import { expect, test } from "bun:test";

import {
  assertionSetDigest,
  bundleContentDigest,
  familyIdForRoot,
  FixturePublicSchema,
  FixtureRootSchema,
  HiddenAssertionSchema,
  HoldoutBundleSchema,
  HoldoutLockEntrySchema,
  HoldoutLockSchema,
} from "@src/evals/fixture.js";

type JsonObject = Record<string, unknown>;

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

const SHA40 = "a".repeat(40);
const HEX64_C = "c".repeat(64);
const HEX64_D = "d".repeat(64);
const HEX64_E = "e".repeat(64);
const HEX64_F = "f".repeat(64);
const HEX64_9 = "9".repeat(64);

function parses(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

function rejects(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function omit(obj: JsonObject, key: string): JsonObject {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}

function fx(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    family_id: "fam-390",
    variant_id: "v1",
    root: { kind: "issue", number: 390 },
    synthetic: false,
    reconstructs: null,
    failure_type: "lost_evidence",
    split: "dev",
    source_root_handoff_digests: [],
    expect_blocked: false,
    hidden_ref: { assertion_set_digest: HEX64_E },
    content_digest: HEX64_C,
    base_sha: SHA40,
    task_digest: HEX64_D,
    ...overrides,
  };
}

function fxSynthetic(overrides: JsonObject = {}): JsonObject {
  return fx({
    family_id: "fam-syn-missed-commit",
    variant_id: "v1",
    root: { kind: "synthetic", id: "missed-commit" },
    synthetic: true,
    reconstructs: { kind: "issue", number: 379 },
    failure_type: null,
    ...overrides,
  });
}

function invariantAssertion(overrides: JsonObject = {}): JsonObject {
  return {
    id: "c1",
    kind: "invariant",
    property: "idempotent",
    module: "src/a.ts",
    export: "run",
    inputs: [{}],
    seed: 7,
    ...overrides,
  };
}

function bundle(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    family_id: "fam-390",
    variant_id: "a",
    repo_files: { "src/a.ts": "export const a = 1;\n" },
    assertions: [invariantAssertion()],
    patches: {
      good: "diff --git a/src/a.ts b/src/a.ts\nGOOD\n",
      bad: ["diff --git a/src/b.ts b/src/b.ts\nBAD\n"],
    },
    mutants: [],
    ...overrides,
  };
}

function lockEntry(overrides: JsonObject = {}): JsonObject {
  return {
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
  };
}

function lock(entries: JsonObject[]): JsonObject {
  return { schema_version: 1, entries, digest: HEX64_9 };
}

test("case 17: family_id derives from root; variants keep the root family", () => {
  rejects(FixturePublicSchema, fx({ family_id: "fam-invariant-violated" }));
  parses(FixturePublicSchema, fx({ variant_id: "lost-evidence" }));
  parses(FixturePublicSchema, fx({ variant_id: "invariant-violated" }));
  expect(familyIdForRoot({ kind: "operator_bundle", id: "kapitsa-fixture-contract" })).toBe(
    "fam-op-kapitsa-fixture-contract",
  );
  expect(familyIdForRoot({ kind: "synthetic", id: "contract-validator" })).toBe(
    "fam-syn-contract-validator",
  );
  rejects(FixtureRootSchema, { kind: "synthetic", id: "390" });
});

test("case 18: synthetic flag, reconstructs, failure_type and digest rules", () => {
  rejects(FixturePublicSchema, fx({ synthetic: true }));
  rejects(
    FixturePublicSchema,
    fx({ root: { kind: "synthetic", id: "missed-commit" }, family_id: "fam-syn-missed-commit" }),
  );
  rejects(FixturePublicSchema, fx({ reconstructs: { kind: "issue", number: 379 } }));
  rejects(FixturePublicSchema, fxSynthetic({ reconstructs: { kind: "synthetic", id: "other" } }));
  rejects(FixturePublicSchema, fx({ failure_type: null }));
  rejects(FixturePublicSchema, fxSynthetic({ source_root_handoff_digests: [HEX64_E] }));
  parses(FixturePublicSchema, fxSynthetic());
});

test("case 19: FixturePublic is strict and carries required contract fields", () => {
  for (const key of ["assertions", "patches", "hidden", "repo_files", "fixture_id"]) {
    rejects(FixturePublicSchema, fx({ [key]: [] }));
  }
  rejects(FixturePublicSchema, fx({ fixture_id: "fixture-1" }));
  rejects(FixturePublicSchema, fx({ base_sha: undefined }));
  rejects(FixturePublicSchema, fx({ task_digest: undefined }));
  for (const key of ["schema_version", "split", "expect_blocked", "hidden_ref", "content_digest"]) {
    rejects(FixturePublicSchema, omit(fx(), key));
  }
  parses(FixturePublicSchema, fx({ hidden_ref: { assertion_set_digest: HEX64_E } }));
  rejects(FixturePublicSchema, fx({ hidden_ref: null }));
  rejects(FixturePublicSchema, fx({ hidden_ref: { assertion_set_digest: "xyz" } }));
});

test("case 20: bundle input/assertion/patch guards", () => {
  parses(HoldoutBundleSchema, bundle());
  rejects(HiddenAssertionSchema, { kind: "command", argv: ["bun", "test"] });
  rejects(
    HoldoutBundleSchema,
    bundle({ assertions: [{ kind: "command", argv: ["bun", "test"] }] }),
  );
  rejects(HoldoutBundleSchema, bundle({ inputs: [] }));
  rejects(
    HoldoutBundleSchema,
    bundle({ assertions: [invariantAssertion({ property: "attempt_reset" })] }),
  );
  rejects(
    HoldoutBundleSchema,
    bundle({ assertions: [invariantAssertion({ property: "no_new_exports" })] }),
  );
  rejects(HoldoutBundleSchema, bundle({ assertions: [invariantAssertion({ inputs: [] })] }));
  rejects(HoldoutBundleSchema, bundle({ assertions: [omit(invariantAssertion(), "seed")] }));
  rejects(HoldoutBundleSchema, bundle({ assertions: [omit(invariantAssertion(), "export")] }));
  rejects(HoldoutBundleSchema, bundle({ assertions: [invariantAssertion({ id: "a1" })] }));
  for (const m of ["../x.ts", "/abs.ts", ".git/config"]) {
    rejects(HoldoutBundleSchema, bundle({ assertions: [invariantAssertion({ module: m })] }));
  }
  rejects(HoldoutBundleSchema, bundle({ assertions: [] }));
  rejects(HoldoutBundleSchema, bundle({ patches: { good: "d", bad: [] } }));
  rejects(HoldoutBundleSchema, bundle({ patches: { good: "", bad: ["d"] } }));
  rejects(
    HoldoutBundleSchema,
    bundle({ patches: { good: [{ id: "p1", diff: "d" }], bad: ["d"] } }),
  );
  rejects(
    HoldoutBundleSchema,
    bundle({
      assertions: [invariantAssertion(), { id: "c1", kind: "file_absent", path: "src/x.ts" }],
    }),
  );
});

test("case 20b: HiddenAssertionSchema binds ids to c-format and invariant to a callable", () => {
  parses(HiddenAssertionSchema, {
    id: "c1",
    kind: "probe",
    module: "src/a.ts",
    export: "run",
    input: {},
    expect: { ok: true },
  });
  parses(HiddenAssertionSchema, { id: "c2", kind: "file_absent", path: "src/x.ts" });
  parses(HiddenAssertionSchema, {
    id: "c3",
    kind: "file_matches",
    path: "src/a.ts",
    pattern: "export",
  });
  parses(HiddenAssertionSchema, invariantAssertion({ id: "c0" }));
  parses(HiddenAssertionSchema, invariantAssertion({ id: "c9999" }));
  rejects(HiddenAssertionSchema, invariantAssertion({ id: "a1" }));
  rejects(HiddenAssertionSchema, invariantAssertion({ id: "attempt_reset_probe" }));
  rejects(HiddenAssertionSchema, invariantAssertion({ id: "c10000" }));
  rejects(HiddenAssertionSchema, invariantAssertion({ property: "whatever" }));
  rejects(HiddenAssertionSchema, omit(invariantAssertion(), "module"));
  rejects(HiddenAssertionSchema, invariantAssertion({ inputs: [] }));
  rejects(HiddenAssertionSchema, invariantAssertion({ expect: { ok: true } }));
});

test("case 21: holdout lock entries carry digests only, family must match root", () => {
  rejects(HoldoutLockSchema, lock([lockEntry({ assertions: [] })]));
  rejects(HoldoutLockSchema, lock([lockEntry({ repo_files: { "a.ts": "x" } })]));
  rejects(HoldoutLockSchema, lock([lockEntry({ content_digest: "xyz" })]));
  rejects(HoldoutLockSchema, lock([lockEntry({ family_id: "fam-391" })]));
  rejects(
    HoldoutLockSchema,
    lock([lockEntry({ root: { kind: "synthetic", id: "s01" }, family_id: "fam-syn-s01" })]),
  );
  parses(HoldoutLockSchema, lock([lockEntry()]));
});

test("case 21b: lock entries and the lock digest are required", () => {
  for (const key of [
    "base_sha",
    "task_digest",
    "assertion_set_digest",
    "failure_type",
    "variant_id",
    "source_root_handoff_digests",
  ]) {
    rejects(HoldoutLockEntrySchema, omit(lockEntry(), key));
  }
  rejects(HoldoutLockEntrySchema, lockEntry({ schema_version: 1 }));
  rejects(HoldoutLockEntrySchema, lockEntry({ source_repo: "frozename/penumbra" }));
  parses(HoldoutLockEntrySchema, lockEntry({ failure_type: null }));
  rejects(HoldoutLockEntrySchema, lockEntry({ task_digest: "xyz" }));
  rejects(HoldoutLockSchema, omit(lock([lockEntry()]), "digest"));
  rejects(HoldoutLockSchema, omit(lock([lockEntry()]), "schema_version"));
  rejects(HoldoutLockSchema, { entries: [], digest: "xyz" });
});

test("case 22: assertionSetDigest order-insensitive; bundleContentDigest content-bound", () => {
  const c1 = {
    id: "c1",
    kind: "invariant",
    property: "idempotent",
    module: "src/a.ts",
    export: "run",
    inputs: [{}],
    seed: 7,
  };
  const c2 = { id: "c2", kind: "file_absent", path: "src/x.ts" };
  const c1Reordered = {
    seed: 7,
    inputs: [{}],
    export: "run",
    module: "src/a.ts",
    property: "idempotent",
    kind: "invariant",
    id: "c1",
  };
  expect(assertionSetDigest({ assertions: [c1, c2] })).toBe(
    assertionSetDigest({ assertions: [c1Reordered, c2] }),
  );
  expect(assertionSetDigest({ assertions: [c1, c2] })).toBe(
    assertionSetDigest({ assertions: [c2, c1] }),
  );
  const c1Seed8 = { ...c1, seed: 8 };
  expect(assertionSetDigest({ assertions: [c1, c2] })).not.toBe(
    assertionSetDigest({ assertions: [c1Seed8, c2] }),
  );
  const probe = {
    id: "c3",
    kind: "probe",
    module: "src/a.ts",
    export: "run",
    input: { n: 1 },
    expect: { ok: true },
  };
  const probeExpectFlipped = { ...probe, expect: { ok: false } };
  expect(assertionSetDigest({ assertions: [c1, c2, probe] })).not.toBe(
    assertionSetDigest({ assertions: [c1, c2, probeExpectFlipped] }),
  );
  const b = bundle();
  expect(bundleContentDigest(b)).not.toBe(
    bundleContentDigest(bundle({ patches: { good: "GOOD", bad: ["OTHER"] } })),
  );
  expect(bundleContentDigest(b)).not.toBe(
    bundleContentDigest(bundle({ repo_files: { "src/a.ts": "export const a = 2;\n" } })),
  );
});

test("case 26f: bundle is exactly the plan shape with a required mutants list", () => {
  parses(HoldoutBundleSchema, bundle());
  for (const key of [
    "schema_version",
    "family_id",
    "variant_id",
    "repo_files",
    "assertions",
    "patches",
    "mutants",
  ]) {
    rejects(HoldoutBundleSchema, omit(bundle(), key));
  }
  for (const key of [
    "root",
    "source_repo",
    "synthetic",
    "base_sha",
    "task_digest",
    "bundle_id",
    "expect_blocked",
    "source_root_handoff_digests",
  ]) {
    rejects(HoldoutBundleSchema, { ...bundle(), [key]: "x" });
  }
  rejects(HoldoutBundleSchema, bundle({ mutants: "m1" }));
  rejects(HoldoutBundleSchema, bundle({ mutants: [1] }));
  parses(HoldoutBundleSchema, bundle({ mutants: ["m1", "m2"] }));
});

test("case 31: lock entry expect_blocked is a required strict boolean", () => {
  rejects(HoldoutLockEntrySchema, lockEntry({ expect_blocked: undefined }));
  rejects(HoldoutLockEntrySchema, lockEntry({ expect_blocked: "yes" }));
  parses(HoldoutLockEntrySchema, lockEntry({ expect_blocked: true }));
  parses(HoldoutLockEntrySchema, lockEntry({ expect_blocked: false }));
});

test("case 32: bundle repo_files non-empty map of safe relative paths to strings", () => {
  rejects(HoldoutBundleSchema, bundle({ repo_files: {} }));
  for (const key of ["../x.ts", "/abs.ts", ".git/config"]) {
    rejects(HoldoutBundleSchema, bundle({ repo_files: { [key]: "x" } }));
  }
  rejects(HoldoutBundleSchema, bundle({ repo_files: { "src/a.ts": 1 } }));
  parses(HoldoutBundleSchema, bundle({ repo_files: { "src/a.ts": "export const a = 1;\n" } }));
});

test("case 56: probe export and file_matches pattern accept the empty string", () => {
  parses(HiddenAssertionSchema, {
    id: "c4",
    kind: "probe",
    module: "src/a.ts",
    export: "",
    input: {},
    expect: {},
  });
  parses(HiddenAssertionSchema, {
    id: "c5",
    kind: "file_matches",
    path: "src/a.ts",
    pattern: "",
  });
});

test("case 57: invariant export accepts the empty string", () => {
  parses(HiddenAssertionSchema, invariantAssertion({ export: "" }));
});

test("case 58: bundle accepts assertions with empty export and pattern fields", () => {
  parses(
    HoldoutBundleSchema,
    bundle({
      assertions: [
        invariantAssertion({ export: "" }),
        { id: "c2", kind: "file_matches", path: "src/a.ts", pattern: "" },
      ],
    }),
  );
});

test("case P5a: bundle patches.bad rejects the empty array", () => {
  rejects(HoldoutBundleSchema, bundle({ patches: { good: "d", bad: [] } }));
});

test("case P5b: bundle patches.bad accepts an empty-string patch entry", () => {
  parses(HoldoutBundleSchema, bundle({ patches: { good: "d", bad: [""] } }));
});

test("case 50: plan-exact bundle parses; assertion digest sorts by id", () => {
  parses(HoldoutBundleSchema, bundle({ mutants: ["m1"] }));
  rejects(HoldoutBundleSchema, omit(bundle({ mutants: ["m1"] }), "mutants"));
  const c1 = { id: "c1", kind: "file_absent", path: "src/x.ts" };
  const c2 = { id: "c2", kind: "file_absent", path: "src/y.ts" };
  expect(assertionSetDigest({ assertions: [c1, c2] })).toBe(
    assertionSetDigest({ assertions: [c2, c1] }),
  );
});
