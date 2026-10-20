import type { Database } from "bun:sqlite";

export type JudgeDecisionMode = "shadow";

export interface WriteJudgeDecisionInput {
  decisionId: string;
  site: string;
  subjectId: string;
  mode: JudgeDecisionMode;
  model: string;
  incumbent: unknown;
  jev: unknown;
  usageInputTokens: number;
  createdAt: string;
}

export function writeJudgeDecision(db: Database, input: WriteJudgeDecisionInput): void {
  if (!Number.isSafeInteger(input.usageInputTokens) || input.usageInputTokens < 0) {
    throw new RangeError(
      `usageInputTokens must be a non-negative safe integer, got ${String(input.usageInputTokens)}`,
    );
  }
  const incumbentJson = JSON.stringify(input.incumbent) as string | undefined;
  const jevJson = JSON.stringify(input.jev) as string | undefined;
  if (incumbentJson === undefined || jevJson === undefined) {
    throw new TypeError("incumbent and jev must be JSON-serialisable values");
  }
  db.prepare(
    `
      INSERT INTO judge_decisions (
        decision_id, site, subject_id, mode, model, incumbent_json, jev_json,
        applied, usage_input_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.decisionId,
    input.site,
    input.subjectId,
    input.mode,
    input.model,
    incumbentJson,
    jevJson,
    0,
    input.usageInputTokens,
    input.createdAt,
  );
}
