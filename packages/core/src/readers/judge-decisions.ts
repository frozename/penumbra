import type { Database } from "bun:sqlite";

export interface JudgeDecisionRecord {
  decisionId: string;
  site: string;
  subjectId: string;
  mode: string;
  model: string;
  incumbent: unknown;
  jev: unknown;
  applied: boolean;
  usageInputTokens: number;
  createdAt: string;
}

export interface ReadJudgeDecisionsOpts {
  site?: string;
  subjectId?: string;
  sinceIso?: string;
  limit?: number;
}

interface JudgeDecisionRow {
  decision_id: string;
  site: string;
  subject_id: string;
  mode: string;
  model: string;
  incumbent_json: string;
  jev_json: string;
  applied: number;
  usage_input_tokens: number;
  created_at: string;
}

export function readJudgeDecisions(
  db: Database,
  opts: ReadJudgeDecisionsOpts = {},
): JudgeDecisionRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.site !== undefined) {
    conditions.push("site = ?");
    params.push(opts.site);
  }
  if (opts.subjectId !== undefined) {
    conditions.push("subject_id = ?");
    params.push(opts.subjectId);
  }
  if (opts.sinceIso !== undefined) {
    conditions.push("created_at >= ?");
    params.push(opts.sinceIso);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit === undefined ? "" : " LIMIT ?";
  if (opts.limit !== undefined) params.push(opts.limit);

  const rows = db
    .prepare(
      `
        SELECT decision_id, site, subject_id, mode, model, incumbent_json, jev_json,
               applied, usage_input_tokens, created_at
        FROM judge_decisions
        ${where}
        ORDER BY created_at DESC${limit}
      `,
    )
    .all(...params) as JudgeDecisionRow[];

  return rows.map((row) => ({
    decisionId: row.decision_id,
    site: row.site,
    subjectId: row.subject_id,
    mode: row.mode,
    model: row.model,
    incumbent: JSON.parse(row.incumbent_json) as unknown,
    jev: JSON.parse(row.jev_json) as unknown,
    applied: row.applied === 1,
    usageInputTokens: row.usage_input_tokens,
    createdAt: row.created_at,
  }));
}
