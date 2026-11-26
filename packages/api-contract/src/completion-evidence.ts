import { z } from "zod";

const GitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const ReviewTargetSchema = z.strictObject({
  base: GitShaSchema,
  head: GitShaSchema,
});
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;

export const ReviewerVerdictSchema = z.strictObject({
  head: GitShaSchema,
  verdict: z.enum(["passed", "failed"]),
  notes: z.string().trim().min(1).max(1000),
});

export const HandoffCompletionEvidenceSchema = z.strictObject({
  attempt: z.number().int().positive(),
  result: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("implementation"), target: ReviewTargetSchema }),
      z.strictObject({ kind: z.literal("review"), review: ReviewerVerdictSchema }),
    ])
    .nullable(),
});
export type HandoffCompletionEvidence = z.infer<typeof HandoffCompletionEvidenceSchema>;

export const POST_IMPLEMENTATION_REVIEW_RESOLVER = "post-implementation-review";
export const COMPLETION_EVIDENCE_EVENT = "dispatch.completion_evidence";
export const REVIEW_TARGET_EVENT = "dispatch.review_target";
