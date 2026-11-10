import { z } from "zod";

import { digestOf } from "./canonical.js";
import {
  AssistanceSchema,
  type EpisodeBody,
  EpisodeSchema,
  GitShaSchema,
  IsoTsSchema,
  receiptDigest,
  Sha256HexSchema,
} from "./manifest.js";

// Mirrors TOKEN_REDACTION_RULE in packages/core/src/dispatch/capsule/preflight.ts and resume.ts until a shared core rule set exists.
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_\w{20,}/,
  /\bsk-[\w-]{20,}/,
  /\bxox[abprs]-[\w-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export const LessonDraftSchema = z.strictObject({
  project_id: z.string().min(1),
  polarity: z.enum(["positive", "negative"]),
  failure_signature: z.string(),
  root_cause: z.string(),
  procedure: z.array(z.string()).min(1),
  applicability: z.array(z.string()),
  exclusions: z.array(z.string()),
  counterexample: z.string().nullable(),
  created_at: IsoTsSchema,
  expires_at: IsoTsSchema,
});

export type LessonDraft = z.infer<typeof LessonDraftSchema>;

function secretsDetected(
  failure_signature: string,
  root_cause: string,
  counterexample: string | null,
  procedure: string[],
  applicability: string[],
  exclusions: string[],
): boolean {
  const fields = [
    failure_signature,
    root_cause,
    ...(counterexample === null ? [] : [counterexample]),
    ...procedure,
    ...applicability,
    ...exclusions,
  ];
  return SECRET_PATTERNS.some((pattern) => fields.some((field) => pattern.test(field)));
}

function isIndependentlyVerifiedEp(episode: EpisodeBody): boolean {
  if (episode.final_sha === null) return false;
  return episode.receipts.some(
    (r) =>
      r.kind === "hidden_assertion" &&
      r.producer === "grader" &&
      r.sha === episode.final_sha &&
      r.claimed_verdict === "pass" &&
      r.control_verdict === "pass",
  );
}

function holdoutEpisode(episode: EpisodeBody): boolean {
  return episode.split === "holdout";
}

function unverifiedFinalSha(episode: EpisodeBody, polarity: "positive" | "negative"): boolean {
  if (polarity !== "positive") return false;
  return !isIndependentlyVerifiedEp(episode);
}

function invalidExpiry(draft: LessonDraft): boolean {
  return Date.parse(draft.expires_at) <= Date.parse(draft.created_at);
}

function buildReceiptDigests(episode: EpisodeBody): string[] {
  return episode.receipts
    .filter(
      (r) =>
        r.kind === "hidden_assertion" &&
        r.producer === "grader" &&
        r.sha === episode.final_sha &&
        r.sha !== null &&
        r.claimed_verdict === "pass" &&
        r.control_verdict === "pass",
    )
    .map((r) => receiptDigest({ ...r, receipt_digest: null }));
}

function buildProvenanceGaps(episode: EpisodeBody): string[] {
  const gaps: string[] = [];
  if (episode.model_identity.effective.value === null) {
    gaps.push("model_identity.effective");
  }
  if (episode.harness_build.sha === null) {
    gaps.push("harness_build");
  }
  return gaps.toSorted();
}

export function proposeLessonFromEpisode(
  episode: EpisodeBody,
  draft: LessonDraft,
):
  | { status: "rejected"; reasons: string[] }
  | { status: "proposed"; lesson: z.infer<typeof LessonSchema>; provenance_gaps: string[] } {
  const parsedEpisode = EpisodeSchema.safeParse(episode);
  if (!parsedEpisode.success) {
    return { status: "rejected", reasons: ["invalid_episode_schema"] };
  }

  const parsedDraft = LessonDraftSchema.safeParse(draft);
  if (!parsedDraft.success) {
    return { status: "rejected", reasons: ["invalid_draft_schema"] };
  }

  const reasons: string[] = [];

  if (holdoutEpisode(episode)) {
    reasons.push("holdout_episode");
  }

  if (unverifiedFinalSha(episode, draft.polarity)) {
    reasons.push("unverified_final_sha");
  }

  if (invalidExpiry(draft)) {
    reasons.push("invalid_expiry");
  }

  if (
    secretsDetected(
      draft.failure_signature,
      draft.root_cause,
      draft.counterexample,
      draft.procedure,
      draft.applicability,
      draft.exclusions,
    )
  ) {
    reasons.push("secret_detected");
  }

  if (reasons.length > 0) {
    return { status: "rejected", reasons: [...new Set(reasons)].toSorted() };
  }

  const receiptDigests = buildReceiptDigests(episode);
  const contributions = episode.assistance.map((a) => ({ kind: a.kind, attempt_n: a.attempt_n }));
  const provenanceGaps = buildProvenanceGaps(episode);

  const lessonBody = {
    review: "proposed" as const,
    approved_by: null as string | null,
    authority: "advisory" as const,
    polarity: draft.polarity,
    source: {
      episode_id: episode.episode_id,
      family_id: episode.family_id,
      final_sha: episode.final_sha,
      receipt_digests: receiptDigests,
    },
    scope: {
      project_id: draft.project_id,
      harness_build_sha: episode.harness_build.sha,
      engine: episode.model_identity.engine.value,
      dependency_lock_sha256: episode.repo.dependency_lock_sha256,
    },
    failure_signature: draft.failure_signature,
    root_cause: draft.root_cause,
    procedure: draft.procedure,
    applicability: draft.applicability,
    exclusions: draft.exclusions,
    counterexample: draft.counterexample,
    created_at: draft.created_at,
    expires_at: draft.expires_at,
    contributions: contributions,
    provenance_gaps: provenanceGaps,
  };

  const lesson = {
    ...lessonBody,
    lesson_id: digestOf(lessonBody),
  };

  const validated = LessonSchema.parse(lesson);

  return { status: "proposed", lesson: validated, provenance_gaps: provenanceGaps };
}

export const LessonSchema = z
  .strictObject({
    lesson_id: Sha256HexSchema,
    review: z.enum(["proposed", "approved", "rejected"]),
    approved_by: z.string().min(1).nullable(),
    authority: z.literal("advisory"),
    polarity: z.enum(["positive", "negative"]),
    source: z.strictObject({
      episode_id: z.string().min(1),
      family_id: z.string().min(1),
      final_sha: GitShaSchema.nullable(),
      receipt_digests: z.array(Sha256HexSchema),
    }),
    scope: z.strictObject({
      project_id: z.string().min(1),
      harness_build_sha: GitShaSchema.nullable(),
      engine: z.string().nullable(),
      dependency_lock_sha256: Sha256HexSchema.nullable(),
    }),
    failure_signature: z.string(),
    root_cause: z.string(),
    procedure: z.array(z.string()),
    applicability: z.array(z.string()),
    exclusions: z.array(z.string()),
    counterexample: z.string().nullable(),
    created_at: IsoTsSchema,
    expires_at: IsoTsSchema,
    contributions: z.array(
      z.strictObject({
        kind: AssistanceSchema.shape.kind,
        attempt_n: z.number().int().min(1),
      }),
    ),
    provenance_gaps: z.array(z.string()),
  })
  .superRefine((val, ctx) => {
    if (val.review === "approved" && val.approved_by === null) {
      ctx.addIssue({
        code: "custom",
        message: "approved_by must be non-null when review is approved",
      });
    }
  });

export type Lesson = z.infer<typeof LessonSchema>;

export type LessonEligibilityCtx = {
  now: string;
  project_id: string;
  revoked: readonly string[];
  current: {
    harness_build_sha: string | null;
    engine: string | null;
    dependency_lock_sha256: string | null;
  };
};

export type LessonEligibilityResult = { eligible: true } | { eligible: false; reasons: string[] };

function versionDiffers(recorded: string | null, current: string | null): boolean {
  return recorded !== null && current !== null && recorded !== current;
}

function scopeVersionChanged(
  scope: Lesson["scope"],
  current: LessonEligibilityCtx["current"],
): boolean {
  return (
    versionDiffers(scope.harness_build_sha, current.harness_build_sha) ||
    versionDiffers(scope.engine, current.engine) ||
    versionDiffers(scope.dependency_lock_sha256, current.dependency_lock_sha256)
  );
}

export function lessonEligibility(
  lesson: z.infer<typeof LessonSchema>,
  ctx: LessonEligibilityCtx,
): LessonEligibilityResult {
  const reasons: string[] = [];

  if (lesson.review !== "approved") {
    reasons.push("not_approved");
  }

  if (Date.parse(ctx.now) >= Date.parse(lesson.expires_at)) {
    reasons.push("expired");
  }

  if (lesson.scope.project_id !== ctx.project_id) {
    reasons.push("cross_project");
  }

  const allSourceRefs = [lesson.source.final_sha, ...lesson.source.receipt_digests].filter(
    (ref): ref is string => ref !== null,
  );

  if (allSourceRefs.some((ref) => ctx.revoked.includes(ref))) {
    reasons.push("source_revoked");
  }

  const versionChanged = scopeVersionChanged(lesson.scope, ctx.current);

  if (versionChanged) {
    reasons.push("source_version_changed");
  }

  if (lesson.polarity === "negative") {
    reasons.push("negative_example");
  }

  if (reasons.length === 0) {
    return { eligible: true };
  }

  return { eligible: false, reasons: [...new Set(reasons)].toSorted() };
}
