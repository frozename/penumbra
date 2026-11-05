// This file is the single writer of the capsule schema; later phases request a
// Phase 1.x amendment instead of editing it.
//
// output_hash is the hash of the pre-formatter capsule state (input +
// token_report). A later formatter phase adds a separate rendered_hash for the
// serialized prompt and never redefines output_hash.
import { z } from "zod";

import { digestOf, GitShaSchema, RelPathSchema, Sha256HexSchema } from "../eval-primitives.js";

export const CAPSULE_SCHEMA_VERSION = 1 as const;
export const LAST_ERROR_EXCERPT_MAX_BYTES = 4096;

export const RefusalCodeSchema = z.enum([
  "stale_base",
  "missing_dependency",
  "essential_overflow",
  "invalid_budget",
  "ref_out_of_scope",
  "ref_unresolved",
  "fence_violation",
  "unauthorized_handle",
  "advisory_privilege_attempt",
]);
export type RefusalCode = z.infer<typeof RefusalCodeSchema>;

export const CapsuleRefusalSchema = z.strictObject({
  ok: z.literal(false),
  code: RefusalCodeSchema,
  detail: z.string(),
});
export type CapsuleRefusal = z.infer<typeof CapsuleRefusalSchema>;

export function refusal(code: RefusalCode, detail: string): CapsuleRefusal {
  return { ok: false, code, detail };
}

export const ProvenanceSchema = z.strictObject({
  source: z.string().min(1),
  ref: z.string().min(1),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const AdvisoryItemSchema = z.strictObject({
  id: z.string().min(1),
  authority: z.literal("advisory"),
  text: z.string(),
  provenance: ProvenanceSchema,
});
export type AdvisoryItem = z.infer<typeof AdvisoryItemSchema>;

function hasUniqueIds(items: readonly { id: string }[]): boolean {
  return new Set(items.map((i) => i.id)).size === items.length;
}

export const AdvisoryLaneSchema = z.strictObject({
  memory: z.array(AdvisoryItemSchema).refine(hasUniqueIds, { message: "duplicate advisory id" }),
  repo_map: AdvisoryItemSchema.optional(),
  log_excerpts: z
    .array(AdvisoryItemSchema)
    .refine(hasUniqueIds, { message: "duplicate advisory id" }),
});
export type AdvisoryLane = z.infer<typeof AdvisoryLaneSchema>;

export const EssentialConstraintSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type EssentialConstraint = z.infer<typeof EssentialConstraintSchema>;

export const CheckRecipeSchema = z.strictObject({
  id: z.string().min(1),
  command: z.string().min(1),
});
export type CheckRecipe = z.infer<typeof CheckRecipeSchema>;

export const ToolSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  command: z.string().min(1),
});
export type Tool = z.infer<typeof ToolSchema>;

export const ArtifactHandleSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().min(1),
  uri: z.string().min(1),
});
export type ArtifactHandle = z.infer<typeof ArtifactHandleSchema>;

export const AuthoritativeLaneSchema = z.strictObject({
  objective: z.string().min(1),
  acceptance_state: z.string().min(1),
  base_sha: GitShaSchema,
  base_sha_verified: z.literal(true),
  dependency_shas: z.array(GitShaSchema),
  write_fence: z.array(RelPathSchema),
  essential_constraints: z.array(EssentialConstraintSchema),
  check_recipes: z.array(CheckRecipeSchema),
  tools: z.array(ToolSchema),
  artifact_handles: z.array(ArtifactHandleSchema),
});
export type AuthoritativeLane = z.infer<typeof AuthoritativeLaneSchema>;

export const LastErrorSchema = z.strictObject({
  kind: z.enum(["compiler", "test", "permission", "tool"]),
  excerpt: z
    .string()
    .refine((s) => new TextEncoder().encode(s).byteLength <= LAST_ERROR_EXCERPT_MAX_BYTES, {
      message: "excerpt exceeds byte cap",
    }),
  truncated: z.boolean(),
  log_sha256: Sha256HexSchema,
});
export type LastError = z.infer<typeof LastErrorSchema>;

export const TokenReportSchema = z.strictObject({
  estimator: z.enum(["tokenizer", "fallback_estimate"]),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type TokenReport = z.infer<typeof TokenReportSchema>;

export const CapsuleSchema = z.strictObject({
  schema_version: z.literal(1),
  authoritative: AuthoritativeLaneSchema,
  advisory: AdvisoryLaneSchema,
  last_error: LastErrorSchema.optional(),
  token_report: TokenReportSchema,
});
export type Capsule = z.infer<typeof CapsuleSchema>;

export interface CapsuleHashes {
  recipe_hash: string;
  input_hash: string;
  output_hash: string;
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function canonicalAdvisory(advisory: AdvisoryLane): Record<string, unknown> {
  const sorted = {
    memory: advisory.memory.toSorted(byId),
    log_excerpts: advisory.log_excerpts.toSorted(byId),
  };
  return advisory.repo_map === undefined ? sorted : { ...sorted, repo_map: advisory.repo_map };
}

export function capsuleHashes(c: Capsule): CapsuleHashes {
  const advisory = canonicalAdvisory(c.advisory);
  const input = {
    schema_version: c.schema_version,
    authoritative: c.authoritative,
    advisory,
    ...(c.last_error === undefined ? {} : { last_error: c.last_error }),
  };
  return {
    recipe_hash: digestOf({
      schema_version: c.schema_version,
      check_recipes: c.authoritative.check_recipes,
      tools: c.authoritative.tools,
    }),
    input_hash: digestOf(input),
    output_hash: digestOf({ ...input, token_report: c.token_report }),
  };
}
