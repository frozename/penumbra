#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { TypesafeFetch } from "../packages/integrations/typesafe/src/client.js";
import type { TypesafeEnvInput } from "../packages/integrations/typesafe/src/config.js";
import type { JevEfficacyVerdict } from "../packages/integrations/typesafe/src/memory-efficacy.js";

import { getConfig } from "../packages/config/src/index.js";
import { applyRuntimePragmas } from "../packages/core/src/db/sqlite-vec.js";
import { writeJudgeDecision } from "../packages/core/src/writers/judge-decisions.js";
import { createTypesafeClient } from "../packages/integrations/typesafe/src/client.js";
import { resolveTypesafeSettings } from "../packages/integrations/typesafe/src/config.js";
import {
  createJevEfficacyClassifier,
  JEV_EFFICACY_MODEL,
} from "../packages/integrations/typesafe/src/memory-efficacy.js";

export interface EfficacyReplayArgs {
  db: string;
  jobIds: string[];
  allCompletedJobs: boolean;
  live: boolean;
  maxCalls: number;
}

export interface EfficacyReplaySelection {
  jobIds: readonly string[];
  allCompletedJobs: boolean;
}

export interface EfficacyFindingRow {
  finding_id: string;
  finding_text: string;
  severity: string | null;
  classification: string;
  classifier_model: string;
  classified_at: string;
  job_id: string;
}

export interface EfficacyReplayDeps {
  fetch: TypesafeFetch;
  typesafeEnv: TypesafeEnvInput;
  maxRetries?: number;
  now: () => number;
}

export interface EfficacyAbstainCounts {
  timeout: number;
  judge_error: number;
  invalid_answer: number;
}

export interface EfficacyAgreementReport {
  compared: number;
  agreed: number;
  rate: number | null;
}

export interface EfficacyClassStat {
  selected: number;
  compared: number;
  agreed: number;
  recall: number | null;
}

export interface EfficacyReplayReport {
  selected: number;
  alreadyJudged: number;
  called: number;
  answered: number;
  abstained: EfficacyAbstainCounts;
  written: number;
  agreement: EfficacyAgreementReport;
  confusion: Record<string, Record<string, number>>;
  perIncumbentClass: Record<string, EfficacyClassStat>;
}

const DEFAULT_MAX_CALLS = 25;

const HELP_TEXT = `Usage: bun scripts/jev-efficacy-replay.ts --db PATH (--job ID | --all-completed-jobs) [options]

Offline Jev shadow replay over memory_efficacy_cache. Selects the incumbent
verdicts written inside completed memory_efficacy_jobs windows and — with
--live — re-judges each finding through the Jev efficacy classifier, writing
judge_decisions rows (site 'memory.efficacy', mode 'shadow', applied = 0).
memory_efficacy_cache is never written. --db is required so a replay can
never touch the live store by accident.

Options:
  --db PATH               SQLite DB path (required; no default)
  --job ID                completed job window to replay (repeatable)
  --all-completed-jobs    replay every completed job window
  --max-calls N           cap Jev calls this run (default 25)
  --live                  make Jev calls and write judge_decisions rows
                          (default: dry run — selection counts only)
  --help                  show this text
`;

export function parseEfficacyReplayArgs(argv: string[]): EfficacyReplayArgs {
  const parsed: EfficacyReplayArgs = {
    db: "",
    jobIds: [],
    allCompletedJobs: false,
    live: false,
    maxCalls: DEFAULT_MAX_CALLS,
  };
  const remaining = [...argv];
  const takeValue = (flag: string): string => {
    const value = remaining.shift();
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };
  while (remaining.length > 0) {
    const flag = remaining.shift();
    if (flag === undefined) break;
    switch (flag) {
      case "--db":
        parsed.db = takeValue(flag);
        break;
      case "--job":
        parsed.jobIds.push(takeValue(flag));
        break;
      case "--all-completed-jobs":
        parsed.allCompletedJobs = true;
        break;
      case "--live":
        parsed.live = true;
        break;
      case "--max-calls":
        parsed.maxCalls = parsePositiveInt(flag, takeValue(flag));
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (parsed.db === "") throw new Error("--db is required");
  if (parsed.allCompletedJobs && parsed.jobIds.length > 0) {
    throw new Error("--job and --all-completed-jobs are mutually exclusive");
  }
  if (!parsed.allCompletedJobs && parsed.jobIds.length === 0) {
    throw new Error("a job selector is required: pass --job <id> or --all-completed-jobs");
  }
  return parsed;
}

export function selectEfficacyFindings(
  db: Database,
  sel: EfficacyReplaySelection,
): EfficacyFindingRow[] {
  if (!sel.allCompletedJobs && sel.jobIds.length === 0) return [];
  const jobFilter = sel.allCompletedJobs
    ? ""
    : `AND j.job_id IN (${sel.jobIds.map(() => "?").join(", ")})`;
  const params = sel.allCompletedJobs ? [] : [...sel.jobIds];
  return db
    .prepare(
      `
        SELECT c.finding_id, c.finding_text, c.severity, c.classification,
               c.classifier_model, c.classified_at, j.job_id
        FROM memory_efficacy_jobs j
        JOIN memory_efficacy_cache c
          ON c.classified_at >= j.ts_started AND c.classified_at <= j.ts_finished
        WHERE j.status = 'completed'
          AND j.ts_started IS NOT NULL
          AND j.ts_finished IS NOT NULL
          ${jobFilter}
        ORDER BY c.classified_at, c.finding_id
      `,
    )
    .all(...params) as EfficacyFindingRow[];
}

export async function runEfficacyReplay(
  args: EfficacyReplayArgs,
  deps: EfficacyReplayDeps,
): Promise<EfficacyReplayReport> {
  const db = args.live ? new Database(args.db) : new Database(args.db, { readonly: true });
  try {
    assertJudgeDecisionsTable(db);
    const rows = selectEfficacyFindings(db, args);
    const report = initReport(rows);
    if (!args.live) {
      report.alreadyJudged = countAlreadyJudged(db, rows);
      return finalizeReport(report);
    }
    const settings = resolveTypesafeSettings(deps.typesafeEnv);
    if (!settings.enabled) throw new Error(settings.reason);
    const classifier = createJevEfficacyClassifier({
      client: createTypesafeClient({
        settings,
        fetch: deps.fetch,
        maxRetries: deps.maxRetries,
      }),
    });
    applyRuntimePragmas(db);
    for (const row of rows) {
      if (isAlreadyJudged(db, row.finding_id)) {
        report.alreadyJudged += 1;
        continue;
      }
      if (report.called >= args.maxCalls) break;
      report.called += 1;
      const verdict = await classifier.classifyFinding({
        text: row.finding_text,
        severity: row.severity,
      });
      recordVerdict(report, row, verdict);
      writeVerdictRow(db, row, verdict, deps.now);
      report.written += 1;
    }
    return finalizeReport(report);
  } finally {
    db.close();
  }
}

function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${raw}`);
  }
  return value;
}

function assertJudgeDecisionsTable(db: Database): void {
  const found = db
    .query<
      { found: number },
      []
    >("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'judge_decisions'")
    .get();
  if (!found) {
    throw new Error(
      "judge_decisions table is missing from this DB; run penumbra migrations first " +
        "(this script never runs migrations against a DB it did not create)",
    );
  }
}

function isAlreadyJudged(db: Database, findingId: string): boolean {
  const found = db
    .query<{ found: number }, [string, string]>(
      `
        SELECT 1 AS found FROM judge_decisions
        WHERE site = 'memory.efficacy'
          AND subject_id = ?
          AND json_extract(jev_json, '$.requestedModel') = ?
        LIMIT 1
      `,
    )
    .get(findingId, JEV_EFFICACY_MODEL);
  return found !== null;
}

function countAlreadyJudged(db: Database, rows: EfficacyFindingRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (isAlreadyJudged(db, row.finding_id)) count += 1;
  }
  return count;
}

function emptyClassStat(): EfficacyClassStat {
  return { selected: 0, compared: 0, agreed: 0, recall: null };
}

function initReport(rows: EfficacyFindingRow[]): EfficacyReplayReport {
  const perIncumbentClass: Record<string, EfficacyClassStat> = {};
  for (const row of rows) {
    (perIncumbentClass[row.classification] ??= emptyClassStat()).selected += 1;
  }
  return {
    selected: rows.length,
    alreadyJudged: 0,
    called: 0,
    answered: 0,
    abstained: { timeout: 0, judge_error: 0, invalid_answer: 0 },
    written: 0,
    agreement: { compared: 0, agreed: 0, rate: null },
    confusion: {},
    perIncumbentClass,
  };
}

function recordVerdict(
  report: EfficacyReplayReport,
  row: EfficacyFindingRow,
  verdict: JevEfficacyVerdict,
): void {
  if (verdict.kind === "abstained") {
    report.abstained[verdict.reason] += 1;
    return;
  }
  report.answered += 1;
  report.agreement.compared += 1;
  const stat = (report.perIncumbentClass[row.classification] ??= emptyClassStat());
  stat.compared += 1;
  const byJev = (report.confusion[row.classification] ??= {});
  byJev[verdict.bucket] = (byJev[verdict.bucket] ?? 0) + 1;
  if (verdict.bucket === row.classification) {
    report.agreement.agreed += 1;
    stat.agreed += 1;
  }
}

function finalizeReport(report: EfficacyReplayReport): EfficacyReplayReport {
  const { compared, agreed } = report.agreement;
  report.agreement.rate = compared > 0 ? agreed / compared : null;
  for (const stat of Object.values(report.perIncumbentClass)) {
    stat.recall = stat.compared > 0 ? stat.agreed / stat.compared : null;
  }
  return report;
}

function writeVerdictRow(
  db: Database,
  row: EfficacyFindingRow,
  verdict: JevEfficacyVerdict,
  now: () => number,
): void {
  writeJudgeDecision(db, {
    decisionId: randomUUID(),
    site: "memory.efficacy",
    subjectId: row.finding_id,
    mode: "shadow",
    model: verdict.kind === "answered" ? verdict.servedModel : JEV_EFFICACY_MODEL,
    incumbent: {
      classification: row.classification,
      classifier_model: row.classifier_model,
      classified_at: row.classified_at,
      job_id: row.job_id,
    },
    jev: { requestedModel: JEV_EFFICACY_MODEL, ...verdict },
    usageInputTokens: verdict.kind === "answered" ? verdict.usageInputTokens : 0,
    createdAt: new Date(now()).toISOString(),
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  try {
    const args = parseEfficacyReplayArgs(argv);
    const report = await runEfficacyReplay(args, {
      fetch: globalThis.fetch,
      typesafeEnv: getConfig(process.env).env as unknown as TypesafeEnvInput,
      now: Date.now,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
