import { expect, test } from "bun:test";

type JsonObject = Record<string, unknown>;

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean };
}

interface FixtureModule {
  FixturePublicSchema: SchemaLike;
  FixtureRootSchema: SchemaLike;
  HoldoutBundleSchema: SchemaLike;
  HoldoutLockEntrySchema: SchemaLike;
  HoldoutLockSchema: SchemaLike;
  assertionSetDigest: (assertions: readonly JsonObject[]) => string;
  bundleContentDigest: (bundle: JsonObject) => string;
  canonicalRoot: (fixture: { reconstructs: unknown; root: unknown }) => unknown;
  canonicalRootKey: (fixture: { reconstructs: unknown; root: unknown }) => string;
  familyIdForRoot: (root: unknown) => string;
}

const SHA40 = "a".repeat(40);
const HEX64_D = "d".repeat(64);
const HEX64_E = "e".repeat(64);

// The evals module does not exist yet. Keeping the specifier non-literal
// leaves the import unresolved for tsc (no TS2307), and `.catch` keeps a
// missing module a failed assertion, never a load error.
const EVALS_MODULE = ["@src", "evals", "fixture.js"].join("/");
function parses(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

function rejects(schema: SchemaLike, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function fx(overrides: JsonObject = {}): JsonObject {
  return {
    fixture_id: "fx-390-v1",
    family_id: "fam-390",
    variant_id: "v1",
    root: { kind: "issue", number: 390 },
    synthetic: false,
    reconstructs: null,
    failure_type: "lost_evidence",
    source_root_handoff_digests: [],
    base_sha: SHA40,
    task_digest: HEX64_D,
    ...overrides,
  };
}

function fxSynthetic(overrides: JsonObject = {}): JsonObject {
  return fx({
    fixture_id: "fx-syn-1",
    family_id: "fam-syn-missed-commit",
    variant_id: "v1",
    root: { kind: "synthetic", id: "missed-commit" },
    synthetic: true,
    reconstructs: { kind: "issue", number: 379 },
    failure_type: null,
    ...overrides,
  });
}

function bundle(overrides: JsonObject = {}): JsonObject {
  return {
    bundle_id: "hb-390-a",
    family_id: "fam-390",
    source_repo: "frozename/penumbra",
    root: { kind: "issue", number: 390 },
    synthetic: false,
    base_sha: SHA40,
    task_digest: HEX64_D,
    inputs: [{ kind: "prompt", text: "Fix the bug." }],
    assertions: [
      { id: "a1", kind: "invariant", property: "no_new_exports", expect: { stable: true } },
    ],
    patches: {
      good: [{ id: "p1", diff: "diff --git a/src/a.ts b/src/a.ts\n" }],
      bad: [{ id: "p2", diff: "diff --git a/src/b.ts b/src/b.ts\n" }],
    },
    repo_files: { "src/a.ts": "export const a = 1;\n" },
    ...overrides,
  };
}

function lockEntry(overrides: JsonObject = {}): JsonObject {
  return {
    family_id: "fam-390",
    root: { kind: "issue", number: 390 },
    synthetic: false,
    source_repo: "frozename/penumbra",
    expect_blocked: false,
    content_digest: HEX64_E,
    ...overrides,
  };
}

function lock(entries: JsonObject[]): JsonObject {
  return { entries };
}

test("case 17: family_id derives from root; variants keep the root family", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.FixturePublicSchema, fx({ family_id: "fam-invariant-violated" }));
  parses(mod.FixturePublicSchema, fx({ variant_id: "lost-evidence" }));
  parses(mod.FixturePublicSchema, fx({ variant_id: "invariant-violated" }));
  expect(mod.familyIdForRoot({ kind: "operator_bundle", id: "kapitsa-fixture-contract" })).toBe(
    "fam-op-kapitsa-fixture-contract",
  );
  expect(mod.familyIdForRoot({ kind: "synthetic", id: "contract-validator" })).toBe(
    "fam-syn-contract-validator",
  );
  rejects(mod.FixtureRootSchema, { kind: "synthetic", id: "390" });
});

test("case 18: synthetic flag, reconstructs, failure_type and digest rules", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.FixturePublicSchema, fx({ synthetic: true }));
  rejects(
    mod.FixturePublicSchema,
    fx({ root: { kind: "synthetic", id: "missed-commit" }, family_id: "fam-syn-missed-commit" }),
  );
  rejects(mod.FixturePublicSchema, fx({ reconstructs: { kind: "issue", number: 379 } }));
  rejects(
    mod.FixturePublicSchema,
    fxSynthetic({ reconstructs: { kind: "synthetic", id: "other" } }),
  );
  rejects(mod.FixturePublicSchema, fx({ failure_type: null }));
  rejects(mod.FixturePublicSchema, fxSynthetic({ source_root_handoff_digests: [HEX64_E] }));
  parses(mod.FixturePublicSchema, fxSynthetic());
});

test("case 19: FixturePublic is strict and requires base_sha/task_digest", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  for (const key of ["assertions", "patches", "hidden", "repo_files"]) {
    rejects(mod.FixturePublicSchema, fx({ [key]: [] }));
  }
  rejects(mod.FixturePublicSchema, fx({ base_sha: undefined }));
  rejects(mod.FixturePublicSchema, fx({ task_digest: undefined }));
});

test("case 20: bundle input/assertion/module guards", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(
    mod.HoldoutBundleSchema,
    bundle({ inputs: [{ kind: "command", argv: ["bun", "test"] }] }),
  );
  rejects(
    mod.HoldoutBundleSchema,
    bundle({
      assertions: [{ id: "a1", kind: "invariant", property: "attempt_reset", expect: {} }],
    }),
  );
  rejects(mod.HoldoutBundleSchema, bundle({ inputs: [] }));
  rejects(
    mod.HoldoutBundleSchema,
    bundle({
      assertions: [{ id: "attempt_reset_probe", kind: "invariant", property: "p", expect: {} }],
    }),
  );
  for (const m of ["../x.ts", "/abs.ts", ".git/config"]) {
    rejects(
      mod.HoldoutBundleSchema,
      bundle({
        assertions: [{ id: "m1", kind: "invariant", property: "p", module: m, expect: {} }],
      }),
    );
  }
  rejects(mod.HoldoutBundleSchema, bundle({ assertions: [] }));
  rejects(
    mod.HoldoutBundleSchema,
    bundle({ patches: { good: [{ id: "p1", diff: "d" }], bad: [] } }),
  );
  rejects(
    mod.HoldoutBundleSchema,
    bundle({
      assertions: [
        { id: "a1", kind: "invariant", property: "p1", expect: {} },
        { id: "a1", kind: "invariant", property: "p2", expect: {} },
      ],
    }),
  );
});

test("case 21: holdout lock entries carry digests only, family must match root", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.HoldoutLockSchema, lock([lockEntry({ assertions: [] })]));
  rejects(mod.HoldoutLockSchema, lock([lockEntry({ repo_files: { "a.ts": "x" } })]));
  rejects(mod.HoldoutLockSchema, lock([lockEntry({ content_digest: "xyz" })]));
  rejects(mod.HoldoutLockSchema, lock([lockEntry({ family_id: "fam-391" })]));
  rejects(
    mod.HoldoutLockSchema,
    lock([lockEntry({ root: { kind: "synthetic", id: "s1" }, family_id: "fam-syn-s1" })]),
  );
  parses(mod.HoldoutLockSchema, lock([lockEntry()]));
});

test("case 22: assertionSetDigest order-insensitive; bundleContentDigest content-bound", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  const a1 = { id: "a1", kind: "invariant", property: "p", expect: { x: 1, y: 2 } };
  const a1Reordered = { expect: { y: 2, x: 1 }, property: "p", kind: "invariant", id: "a1" };
  const a2 = { id: "a2", kind: "invariant", property: "q", expect: {} };
  expect(mod.assertionSetDigest([a1, a2])).toBe(mod.assertionSetDigest([a1Reordered, a2]));
  expect(mod.assertionSetDigest([a1, a2])).toBe(mod.assertionSetDigest([a2, a1]));
  expect(mod.assertionSetDigest([a1, a2])).not.toBe(
    mod.assertionSetDigest([{ ...a1, expect: { x: 1, y: 3 } }, a2]),
  );
  const b = bundle();
  expect(mod.bundleContentDigest(b)).not.toBe(
    mod.bundleContentDigest(
      bundle({ patches: { good: [{ id: "p1", diff: "d" }], bad: [{ id: "p2", diff: "X" }] } }),
    ),
  );
  expect(mod.bundleContentDigest(b)).not.toBe(
    mod.bundleContentDigest(bundle({ repo_files: { "src/a.ts": "export const a = 2;\n" } })),
  );
});

test("case 31: lock entry expect_blocked is a required strict boolean", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.HoldoutLockEntrySchema, lockEntry({ expect_blocked: undefined }));
  rejects(mod.HoldoutLockEntrySchema, lockEntry({ expect_blocked: "yes" }));
  parses(mod.HoldoutLockEntrySchema, lockEntry({ expect_blocked: true }));
  parses(mod.HoldoutLockEntrySchema, lockEntry({ expect_blocked: false }));
});

test("case 32: bundle repo_files non-empty map of safe relative paths to strings", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.HoldoutBundleSchema, bundle({ repo_files: {} }));
  for (const key of ["../x.ts", "/abs.ts", ".git/config"]) {
    rejects(mod.HoldoutBundleSchema, bundle({ repo_files: { [key]: "x" } }));
  }
  rejects(mod.HoldoutBundleSchema, bundle({ repo_files: { "src/a.ts": 1 } }));
  parses(mod.HoldoutBundleSchema, bundle({ repo_files: { "src/a.ts": "export const a = 1;\n" } }));
});

test("case 35: source_repo is required owner/repo format and digests differ", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  rejects(mod.HoldoutBundleSchema, bundle({ source_repo: undefined }));
  rejects(mod.HoldoutLockEntrySchema, lockEntry({ source_repo: undefined }));
  for (const repo of ["penumbra", "a/b/c", ""]) {
    rejects(mod.HoldoutBundleSchema, bundle({ source_repo: repo }));
    rejects(mod.HoldoutLockEntrySchema, lockEntry({ source_repo: repo }));
  }
  for (const repo of ["frozename/penumbra", "frozename/llamactl"]) {
    parses(mod.HoldoutBundleSchema, bundle({ source_repo: repo }));
    parses(mod.HoldoutLockEntrySchema, lockEntry({ source_repo: repo }));
  }
  expect(mod.bundleContentDigest(bundle({ source_repo: "frozename/penumbra" }))).not.toBe(
    mod.bundleContentDigest(bundle({ source_repo: "frozename/llamactl" })),
  );
});

test("case 36: canonicalRoot resolves through reconstructs; canonicalRootKey family", async () => {
  const mod = (await import(EVALS_MODULE).catch(() => null)) as unknown as FixtureModule | null;
  expect(mod).not.toBeNull();
  if (!mod) return;
  expect(
    mod.canonicalRoot({
      root: { kind: "synthetic", id: "missed-commit" },
      reconstructs: { kind: "issue", number: 379 },
    }),
  ).toEqual({ kind: "issue", number: 379 });
  expect(
    mod.canonicalRoot({
      root: { kind: "synthetic", id: "missed-commit" },
      reconstructs: null,
    }),
  ).toEqual({ kind: "synthetic", id: "missed-commit" });
  expect(
    mod.canonicalRootKey({
      root: { kind: "synthetic", id: "missed-commit" },
      reconstructs: { kind: "issue", number: 379 },
    }),
  ).toBe("fam-379");
  expect(mod.canonicalRootKey({ root: { kind: "issue", number: 379 }, reconstructs: null })).toBe(
    "fam-379",
  );
  expect(
    mod.canonicalRootKey({
      root: { kind: "synthetic", id: "missed-commit" },
      reconstructs: null,
    }),
  ).toBe("fam-syn-missed-commit");
});
