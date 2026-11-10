// lesson-retrieval.ts — pure module, no I/O, no DB, no clock.
// Selects eligible lessons and records retrieval telemetry.
// Does not wire into compile; later wiring passes `advisory` into compile's
// advisory.memory.

import { z } from "zod";

import { estimateTokens, type TokenCounter } from "../dispatch/capsule/budget.js";
import { type AdvisoryItem, AdvisoryItemSchema } from "../dispatch/capsule/schema.js";
import {
  type Lesson,
  lessonEligibility,
  type LessonEligibilityCtx,
  LessonSchema,
} from "./lesson.js";

export const LessonRetrievalArmSchema = z.enum(["memory_on", "memory_off"]);

export const LessonRetrievalRecordSchema = z.strictObject({
  lesson_id: z.string().min(1),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  token_cost: z.number().int().nonnegative(),
  decision: z.enum(["admitted", "withheld", "memory_off"]),
  usage: z.enum(["pending", "applied", "ignored", "not_retrieved"]),
});

export const LessonRetrievalTelemetrySchema = z.strictObject({
  arm: LessonRetrievalArmSchema,
  estimator: z.enum(["tokenizer", "fallback_estimate"]),
  records: z.array(LessonRetrievalRecordSchema),
  admitted_tokens: z.number().int().nonnegative(),
});

export type LessonRetrievalRecord = z.infer<typeof LessonRetrievalRecordSchema>;
export type LessonRetrievalTelemetry = z.infer<typeof LessonRetrievalTelemetrySchema>;
export type LessonRetrievalArm = z.infer<typeof LessonRetrievalArmSchema>;

export function renderLessonAdvisoryText(lesson: Lesson): string {
  const lines: string[] = [];

  lines.push(`lesson_id: ${lesson.lesson_id} polarity: ${lesson.polarity}`);
  lines.push(`failure_signature: ${lesson.failure_signature}`);
  lines.push(`root_cause: ${lesson.root_cause}`);
  lines.push(`procedure: ${lesson.procedure.map((s, i) => `${String(i + 1)}. ${s}`).join("; ")}`);
  lines.push(`applicability: ${lesson.applicability.join("; ")}`);
  lines.push(`exclusions: ${lesson.exclusions.join("; ")}`);
  lines.push(`counterexample: ${lesson.counterexample ?? "none"}`);
  lines.push(`expires_at: ${lesson.expires_at}`);

  return lines.join("\n");
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function withheldRecord(lesson_id: string, reasons: string[]): LessonRetrievalRecord {
  return {
    lesson_id,
    eligible: false,
    reasons,
    token_cost: 0,
    decision: "withheld",
    usage: "not_retrieved",
  };
}

// A duplicated lesson_id is withheld as ONE record and never estimated: the
// ineligibility reasons of every occurrence are kept alongside the duplicate.
function duplicateRecord(
  lesson_id: string,
  occurrences: readonly Lesson[],
  ctx: LessonEligibilityCtx,
): LessonRetrievalRecord {
  const reasons: string[] = ["duplicate_lesson_id"];
  for (const occurrence of occurrences) {
    const eligibility = lessonEligibility(occurrence, ctx);
    if (!eligibility.eligible) {
      reasons.push(...eligibility.reasons);
    }
  }
  return withheldRecord(lesson_id, [...new Set(reasons)].toSorted());
}

function scoredRecord(
  lesson: Lesson,
  ctx: LessonEligibilityCtx,
  arm: LessonRetrievalArm,
  counter: TokenCounter | undefined,
): { record: LessonRetrievalRecord; text: string; tokenized: boolean } {
  const eligibility = lessonEligibility(lesson, ctx);
  const text = renderLessonAdvisoryText(lesson);
  const est = estimateTokens(text, counter);

  let decision: LessonRetrievalRecord["decision"] = "withheld";
  if (arm === "memory_off") {
    decision = "memory_off";
  } else if (eligibility.eligible) {
    decision = "admitted";
  }

  const record: LessonRetrievalRecord = {
    lesson_id: lesson.lesson_id,
    eligible: eligibility.eligible,
    reasons: eligibility.eligible ? [] : eligibility.reasons,
    token_cost: est.tokens,
    decision,
    usage: decision === "admitted" ? "pending" : "not_retrieved",
  };
  return { record, text, tokenized: est.estimator === "tokenizer" };
}

export function retrieveLessonsForCapsule(input: {
  lessons: readonly unknown[];
  ctx: LessonEligibilityCtx;
  arm: "memory_on" | "memory_off";
  counter?: TokenCounter;
}): { advisory: AdvisoryItem[]; telemetry: LessonRetrievalTelemetry } {
  const { lessons, ctx, arm, counter } = input;

  const records: LessonRetrievalRecord[] = [];
  const advisory: AdvisoryItem[] = [];
  let allTokenizer = Boolean(counter);
  let admittedTokens = 0;

  // Schema-invalid elements are withheld under their input index.
  const idGroups = new Map<string, Lesson[]>();
  for (const [index, candidate] of lessons.entries()) {
    const result = LessonSchema.safeParse(candidate);
    if (!result.success) {
      records.push(withheldRecord(`invalid:${String(index)}`, ["invalid_lesson_schema"]));
      continue;
    }
    const group = idGroups.get(result.data.lesson_id) ?? [];
    group.push(result.data);
    idGroups.set(result.data.lesson_id, group);
  }

  for (const [lessonId, occurrences] of idGroups) {
    const [lesson] = occurrences;
    if (occurrences.length > 1 || lesson === undefined) {
      records.push(duplicateRecord(lessonId, occurrences, ctx));
      continue;
    }
    const scored = scoredRecord(lesson, ctx, arm, counter);
    if (!scored.tokenized) {
      allTokenizer = false;
    }
    records.push(scored.record);
    if (scored.record.decision === "admitted") {
      admittedTokens += scored.record.token_cost;
      advisory.push(
        AdvisoryItemSchema.parse({
          id: `lesson:${lesson.lesson_id}`,
          authority: "advisory",
          text: scored.text,
          provenance: { source: "lesson", ref: lesson.lesson_id },
        }),
      );
    }
  }

  records.sort((a, b) => compareCodeUnits(a.lesson_id, b.lesson_id));
  advisory.sort((a, b) => compareCodeUnits(a.id, b.id));

  const telemetry = LessonRetrievalTelemetrySchema.parse({
    arm,
    estimator: allTokenizer ? "tokenizer" : "fallback_estimate",
    records,
    admitted_tokens: admittedTokens,
  });

  return { advisory, telemetry };
}

export type MarkLessonUsageResult =
  | { ok: true; telemetry: LessonRetrievalTelemetry }
  | { ok: false; reason: "unknown_lesson" | "not_admitted" | "already_recorded" };

export function markLessonUsage(
  telemetry: LessonRetrievalTelemetry,
  lesson_id: string,
  usage: "applied" | "ignored",
): MarkLessonUsageResult {
  const recordIndex = telemetry.records.findIndex((r) => r.lesson_id === lesson_id);

  if (recordIndex === -1) {
    return { ok: false, reason: "unknown_lesson" };
  }

  const record = telemetry.records[recordIndex];
  if (record === undefined) {
    return { ok: false, reason: "unknown_lesson" };
  }

  if (record.decision !== "admitted") {
    return { ok: false, reason: "not_admitted" };
  }

  if (record.usage !== "pending") {
    return { ok: false, reason: "already_recorded" };
  }

  // Create new telemetry with updated record
  const updatedRecords = telemetry.records.map((r, i) => {
    if (i === recordIndex) {
      return { ...r, usage };
    }
    return r;
  });

  const newTelemetry: LessonRetrievalTelemetry = {
    ...telemetry,
    records: updatedRecords,
  };

  return { ok: true, telemetry: newTelemetry };
}
