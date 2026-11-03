import { z } from "zod";

import { digestOf } from "./canonical.js";
import {
  AssertionIdSchema,
  FailureTypeSchema,
  GitShaSchema,
  RelPathSchema,
  Sha256HexSchema,
} from "./manifest.js";

export const IssueRootSchema = z.strictObject({
  kind: z.literal("issue"),
  number: z.number().int().min(1),
});

export const OperatorBundleRootSchema = z.strictObject({
  kind: z.literal("operator_bundle"),
  id: z.string().regex(/^[a-z0-9-]{3,48}$/),
});

export const SyntheticRootSchema = z.strictObject({
  kind: z.literal("synthetic"),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,47}$/),
});

export const FixtureRootSchema = z.discriminatedUnion("kind", [
  IssueRootSchema,
  OperatorBundleRootSchema,
  SyntheticRootSchema,
]);

export type RootRef = z.infer<typeof FixtureRootSchema>;

export function familyIdForRoot(root: RootRef): string {
  if (root.kind === "issue") return `fam-${String(root.number)}`;
  if (root.kind === "operator_bundle") return `fam-op-${root.id}`;
  return `fam-syn-${root.id}`;
}

export const FixturePublicSchema = z
  .strictObject({
    schema_version: z.literal(1),
    family_id: z.string().min(1),
    variant_id: z.string().regex(/^[a-z0-9-]+$/),
    root: FixtureRootSchema,
    reconstructs: FixtureRootSchema.nullable(),
    failure_type: FailureTypeSchema.nullable(),
    split: z.enum(["train", "dev", "holdout"]),
    synthetic: z.boolean(),
    base_sha: GitShaSchema,
    task_digest: Sha256HexSchema,
    source_root_handoff_digests: z.array(Sha256HexSchema),
    expect_blocked: z.boolean(),
    hidden_ref: z.strictObject({ assertion_set_digest: Sha256HexSchema }),
    content_digest: Sha256HexSchema,
  })
  .superRefine((fixture, ctx) => {
    const report = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (fixture.family_id !== familyIdForRoot(fixture.root)) {
      report("family_id must equal familyIdForRoot(root)");
    }
    if (fixture.synthetic !== (fixture.root.kind === "synthetic")) {
      report("synthetic must be true exactly when root.kind is synthetic");
    }
    if (fixture.reconstructs !== null) {
      if (!fixture.synthetic) report("reconstructs requires a synthetic fixture");
      if (fixture.reconstructs.kind === "synthetic") {
        report("reconstructs must not be a synthetic root");
      }
    }
    if (fixture.failure_type === null && !fixture.synthetic) {
      report("a null failure_type requires a synthetic fixture");
    }
    if (fixture.synthetic && fixture.source_root_handoff_digests.length > 0) {
      report("synthetic fixtures must not carry source root handoff digests");
    }
  });

export type FixturePublic = z.infer<typeof FixturePublicSchema>;

export const InvariantPropertySchema = z.enum(["idempotent", "deterministic", "order_insensitive"]);

const ProbeAssertionSchema = z.strictObject({
  kind: z.literal("probe"),
  id: AssertionIdSchema,
  module: RelPathSchema,
  export: z.string(),
  input: z.json(),
  expect: z.json(),
});

const FileMatchesAssertionSchema = z.strictObject({
  kind: z.literal("file_matches"),
  id: AssertionIdSchema,
  path: RelPathSchema,
  pattern: z.string(),
});

const FileAbsentAssertionSchema = z.strictObject({
  kind: z.literal("file_absent"),
  id: AssertionIdSchema,
  path: RelPathSchema,
});

const InvariantAssertionSchema = z.strictObject({
  kind: z.literal("invariant"),
  id: AssertionIdSchema,
  property: InvariantPropertySchema,
  module: RelPathSchema,
  export: z.string(),
  inputs: z.array(z.json()).min(1),
  seed: z.number().int(),
});

export const HiddenAssertionSchema = z.discriminatedUnion("kind", [
  ProbeAssertionSchema,
  FileMatchesAssertionSchema,
  FileAbsentAssertionSchema,
  InvariantAssertionSchema,
]);

export type HiddenAssertion = z.infer<typeof HiddenAssertionSchema>;

function hasUniqueAssertionIds(assertions: readonly { id: string }[]): boolean {
  const ids = new Set<string>();
  for (const assertion of assertions) {
    if (ids.has(assertion.id)) return false;
    ids.add(assertion.id);
  }
  return true;
}

export const HoldoutBundleSchema = z
  .strictObject({
    schema_version: z.literal(1),
    family_id: z.string().min(1),
    variant_id: z.string().regex(/^[a-z0-9-]+$/),
    repo_files: z
      .record(RelPathSchema, z.string())
      .refine((files) => Object.keys(files).length >= 1, {
        message: "repo_files must contain at least one entry",
      }),
    assertions: z.array(HiddenAssertionSchema).min(1),
    patches: z.strictObject({
      good: z.string().min(1),
      bad: z.array(z.string().min(1)).min(1),
    }),
    mutants: z.array(z.string()),
  })
  .superRefine((bundle, ctx) => {
    if (!hasUniqueAssertionIds(bundle.assertions)) {
      ctx.addIssue({ code: "custom", message: "assertion ids must be unique" });
    }
  });

export type HoldoutBundle = z.infer<typeof HoldoutBundleSchema>;

export const HoldoutLockEntrySchema = z
  .strictObject({
    family_id: z.string().min(1),
    variant_id: z.string().regex(/^[a-z0-9-]+$/),
    root: FixtureRootSchema,
    failure_type: FailureTypeSchema.nullable(),
    synthetic: z.boolean(),
    expect_blocked: z.boolean(),
    base_sha: GitShaSchema,
    task_digest: Sha256HexSchema,
    source_root_handoff_digests: z.array(Sha256HexSchema),
    content_digest: Sha256HexSchema,
    assertion_set_digest: Sha256HexSchema,
  })
  .superRefine((entry, ctx) => {
    const report = (message: string): void => {
      ctx.addIssue({ code: "custom", message });
    };
    if (entry.family_id !== familyIdForRoot(entry.root)) {
      report("family_id must equal familyIdForRoot(root)");
    }
    if (entry.synthetic !== (entry.root.kind === "synthetic")) {
      report("synthetic must be true exactly when root.kind is synthetic");
    }
  });

export type HoldoutLockEntry = z.infer<typeof HoldoutLockEntrySchema>;

export const HoldoutLockSchema = z.strictObject({
  schema_version: z.literal(1),
  entries: z.array(HoldoutLockEntrySchema),
  digest: Sha256HexSchema,
});

export type HoldoutLock = z.infer<typeof HoldoutLockSchema>;

export function assertionSetDigest(bundle: { assertions: readonly { id: string }[] }): string {
  const sorted = [...bundle.assertions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return digestOf(sorted);
}

export function bundleContentDigest(bundle: object): string {
  return digestOf(bundle);
}
