import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TypesafeFetch } from "../packages/integrations/typesafe/src/client.js";
import type { TypesafeEnvInput } from "../packages/integrations/typesafe/src/config.js";

import { migrate } from "../packages/core/src/db/migrations.js";
import { loadSqliteVec } from "../packages/core/src/db/sqlite-vec.js";
import { JEV_EFFICACY_MODEL } from "../packages/integrations/typesafe/src/memory-efficacy.js";
import {
  parseEfficacyReplayArgs,
  runEfficacyReplay,
  selectEfficacyFindings,
} from "./jev-efficacy-replay.js";

const JOB_1 = "job-1";
const JOB_2 = "job-2";
const FIXED_NOW = Date.parse("2026-09-18T12:00:00.000Z");
const FIXED_NOW_ISO = "2026-09-18T12:00:00.000Z";
const CANNED_INPUT_TOKENS = 123;
const CANNED_BUCKET = "not_memory_related";
const SERVED_MODEL_VARIANT = "jev-1.13.0-build7";

const TYPESAFE_ENV: TypesafeEnvInput = {
  PENUMBRA_TYPESAFE_API_KEY: "test-key",
  PENUMBRA_TYPESAFE_BASE_URL: "https://api.typesafe.ai",
  PENUMBRA_TYPESAFE_MODEL: "jev-1.13.0",
  PENUMBRA_TYPESAFE_TIMEOUT_MS: 10000,
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "shadow",
};

const FINDING_IDS = ["f-1", "f-2", "f-3", "f-4", "f-5"];

interface CacheSeed {
  findingId: string;
  classifiedAt: string;
  classification: string;
  severity: string | null;
}

const CACHE_SEEDS: CacheSeed[] = [
  {
    findingId: "f-1",
    classifiedAt: "2026-09-01T00:10:00.000Z",
    classification: "missed_registration",
    severity: "high",
  },
  {
    findingId: "f-2",
    classifiedAt: "2026-09-01T00:20:00.000Z",
    classification: "recall_miss",
    severity: null,
  },
  {
    findingId: "f-3",
    classifiedAt: "2026-09-01T00:30:00.000Z",
    classification: "not_memory_related",
    severity: "low",
  },
  {
    findingId: "f-4",
    classifiedAt: "2026-09-02T00:10:00.000Z",
    classification: "memory_ignored",
    severity: "medium",
  },
  {
    findingId: "f-5",
    classifiedAt: "2026-09-02T00:20:00.000Z",
    classification: "not_memory_related",
    severity: null,
  },
  {
    findingId: "f-outside",
    classifiedAt: "2026-08-31T23:00:00.000Z",
    classification: "recall_miss",
    severity: "low",
  },
  {
    findingId: "f-failed-job",
    classifiedAt: "2026-09-03T00:30:00.000Z",
    classification: "missed_registration",
    severity: "high",
  },
];

function seedJob(
  db: Database,
  jobId: string,
  status: string,
  tsStarted: string | null,
  tsFinished: string | null,
): void {
  db.prepare(
    `INSERT INTO memory_efficacy_jobs (
       job_id, ts_enqueued, ts_started, ts_finished, status, since_iso, reviews_dir
     ) VALUES (?, ?, ?, ?, ?, NULL, '/tmp/reviews')`,
  ).run(jobId, "2026-09-01T00:00:00.000Z", tsStarted, tsFinished, status);
}

function seedFinding(db: Database, index: number, seed: CacheSeed): void {
  db.prepare(
    `INSERT INTO memory_efficacy_cache (
       finding_id, synthesis_path, ts, finding_index, finding_text, severity,
       classification, classifier_model, classified_at, raw_response_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.findingId,
    "synthesis/test",
    seed.classifiedAt,
    index,
    `UNIQUE_FINDING_TEXT_${seed.findingId} the recall pool missed the edge case`,
    seed.severity,
    seed.classification,
    "incumbent-classifier-1",
    seed.classifiedAt,
    "{}",
  );
}

function seedDbFile(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    seedJob(db, JOB_1, "completed", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z");
    seedJob(db, JOB_2, "completed", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z");
    seedJob(db, "job-failed", "failed", "2026-09-03T00:00:00.000Z", "2026-09-03T01:00:00.000Z");
    seedJob(db, "job-queued", "queued", null, null);
    for (const [index, seed] of CACHE_SEEDS.entries()) {
      seedFinding(db, index, seed);
    }
  } finally {
    db.close();
  }
}

function cannedResponse(servedModel: string): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({
        model: servedModel,
        answers: {
          bucket: {
            type: "choice",
            choice: CANNED_BUCKET,
            probabilities: {
              missed_registration: 0.02,
              recall_miss: 0.02,
              memory_ignored: 0.02,
              not_memory_related: 0.94,
            },
            confidence: 0.94,
          },
        },
        usage: { input_tokens: CANNED_INPUT_TOKENS, output_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function makeDeps(
  servedModel: string,
  counter: { calls: number },
): { fetch: TypesafeFetch; typesafeEnv: TypesafeEnvInput; maxRetries: number; now: () => number } {
  return {
    fetch: (url, init): Promise<Response> => {
      counter.calls += 1;
      void url;
      void init;
      return cannedResponse(servedModel);
    },
    typesafeEnv: TYPESAFE_ENV,
    maxRetries: 0,
    now: () => FIXED_NOW,
  };
}

interface JudgeDecisionSqlRow {
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

function readJudgeDecisionRows(dbPath: string): JudgeDecisionSqlRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT * FROM judge_decisions ORDER BY subject_id")
      .all() as JudgeDecisionSqlRow[];
  } finally {
    db.close();
  }
}

function cacheRowsJson(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare("SELECT * FROM memory_efficacy_cache ORDER BY finding_id").all();
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

describe("jev-efficacy-replay", () => {
  const tmpDirs: string[] = [];

  function makeDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "jev-efficacy-replay-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "db.sqlite");
    seedDbFile(dbPath);
    return dbPath;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseEfficacyReplayArgs requires --db, defaults to dry with maxCalls 25, and rejects mixed selectors", () => {
    expect(() => parseEfficacyReplayArgs([])).toThrow(/--db/);
    expect(() => parseEfficacyReplayArgs(["--all-completed-jobs"])).toThrow(/--db/);
    expect(() => parseEfficacyReplayArgs(["--db", "/tmp/x.sqlite"])).toThrow(/selector|--job/i);

    const parsed = parseEfficacyReplayArgs(["--db", "/tmp/x.sqlite", "--job", "job-1"]);
    expect(parsed.db).toBe("/tmp/x.sqlite");
    expect(parsed.live).toBe(false);
    expect(parsed.maxCalls).toBe(25);
    expect(parsed.jobIds).toEqual(["job-1"]);
    expect(parsed.allCompletedJobs).toBe(false);

    const repeated = parseEfficacyReplayArgs([
      "--db",
      "/tmp/x.sqlite",
      "--job",
      "a",
      "--job",
      "b",
      "--live",
      "--max-calls",
      "3",
    ]);
    expect(repeated.jobIds).toEqual(["a", "b"]);
    expect(repeated.live).toBe(true);
    expect(repeated.maxCalls).toBe(3);

    const all = parseEfficacyReplayArgs(["--db", "/tmp/x.sqlite", "--all-completed-jobs"]);
    expect(all.allCompletedJobs).toBe(true);
    expect(all.jobIds).toEqual([]);

    expect(() =>
      parseEfficacyReplayArgs(["--db", "/tmp/x.sqlite", "--job", "a", "--all-completed-jobs"]),
    ).toThrow(/mutually exclusive|both/i);
  });

  test("--job job-1 selects exactly the three rows inside that job's completed window", () => {
    const dbPath = makeDbPath();
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = selectEfficacyFindings(db, { jobIds: [JOB_1], allCompletedJobs: false });
      expect(rows.map((row) => row.finding_id)).toEqual(["f-1", "f-2", "f-3"]);
      expect(rows.every((row) => row.job_id === JOB_1)).toBe(true);

      const all = selectEfficacyFindings(db, { jobIds: [], allCompletedJobs: true });
      expect(all.map((row) => row.finding_id)).toEqual(FINDING_IDS);
    } finally {
      db.close();
    }
  });

  test("dry run reports the five selected rows per incumbent class with no calls and no writes", async () => {
    const dbPath = makeDbPath();
    const counter = { calls: 0 };
    const args = parseEfficacyReplayArgs(["--db", dbPath, "--all-completed-jobs"]);

    const report = await runEfficacyReplay(args, makeDeps(JEV_EFFICACY_MODEL, counter));

    expect(counter.calls).toBe(0);
    expect(report.selected).toBe(5);
    expect(report.called).toBe(0);
    expect(report.answered).toBe(0);
    expect(report.written).toBe(0);
    expect(report.perIncumbentClass["missed_registration"]?.selected).toBe(1);
    expect(report.perIncumbentClass["recall_miss"]?.selected).toBe(1);
    expect(report.perIncumbentClass["memory_ignored"]?.selected).toBe(1);
    expect(report.perIncumbentClass["not_memory_related"]?.selected).toBe(2);
    expect(readJudgeDecisionRows(dbPath)).toHaveLength(0);
  });

  test("--live --all-completed-jobs writes one shadow row per finding and stores no finding text", async () => {
    const dbPath = makeDbPath();
    const cacheBefore = cacheRowsJson(dbPath);
    const counter = { calls: 0 };
    const args = parseEfficacyReplayArgs(["--db", dbPath, "--all-completed-jobs", "--live"]);

    const report = await runEfficacyReplay(args, makeDeps(JEV_EFFICACY_MODEL, counter));

    expect(counter.calls).toBe(5);
    expect(report.called).toBe(5);
    expect(report.answered).toBe(5);
    expect(report.written).toBe(5);

    const rows = readJudgeDecisionRows(dbPath);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.site).toBe("memory.efficacy");
      expect(row.mode).toBe("shadow");
      expect(row.applied).toBe(0);
      expect(FINDING_IDS).toContain(row.subject_id);
      expect(row.usage_input_tokens).toBe(CANNED_INPUT_TOKENS);
      expect(row.created_at).toBe(FIXED_NOW_ISO);
      for (const value of Object.values(row)) {
        expect(String(value)).not.toContain("UNIQUE_FINDING_TEXT");
      }
    }
    expect(cacheRowsJson(dbPath)).toBe(cacheBefore);

    const confusionTotal = Object.values(report.confusion)
      .flatMap((byJev) => Object.values(byJev))
      .reduce((sum, count) => sum + count, 0);
    expect(confusionTotal).toBe(5);
    expect(report.confusion["not_memory_related"]?.[CANNED_BUCKET]).toBe(2);
    expect(report.agreement).toEqual({ compared: 5, agreed: 2, rate: 0.4 });
    expect(report.perIncumbentClass["not_memory_related"]).toEqual({
      selected: 2,
      compared: 2,
      agreed: 2,
      recall: 1,
    });
    expect(report.perIncumbentClass["recall_miss"]).toEqual({
      selected: 1,
      compared: 1,
      agreed: 0,
      recall: 0,
    });
  });

  test("rerun is a no-op: the skip keys on requestedModel, not the served model id", async () => {
    const dbPath = makeDbPath();
    const counter = { calls: 0 };
    const args = parseEfficacyReplayArgs(["--db", dbPath, "--all-completed-jobs", "--live"]);

    await runEfficacyReplay(args, makeDeps(SERVED_MODEL_VARIANT, counter));
    expect(counter.calls).toBe(5);
    const servedModels = readJudgeDecisionRows(dbPath).map((row) => row.model);
    expect(servedModels).toEqual(Array.from({ length: 5 }, () => SERVED_MODEL_VARIANT));

    const second = await runEfficacyReplay(args, makeDeps(SERVED_MODEL_VARIANT, counter));
    expect(counter.calls).toBe(5);
    expect(second.alreadyJudged).toBe(5);
    expect(second.called).toBe(0);
    expect(second.written).toBe(0);
    expect(readJudgeDecisionRows(dbPath)).toHaveLength(5);
  });

  test("--live --max-calls 2 over five unjudged rows makes two calls and writes two rows", async () => {
    const dbPath = makeDbPath();
    const counter = { calls: 0 };
    const args = parseEfficacyReplayArgs([
      "--db",
      dbPath,
      "--all-completed-jobs",
      "--live",
      "--max-calls",
      "2",
    ]);

    const report = await runEfficacyReplay(args, makeDeps(JEV_EFFICACY_MODEL, counter));

    expect(counter.calls).toBe(2);
    expect(report.called).toBe(2);
    expect(report.written).toBe(2);
    expect(report.selected).toBe(5);
    expect(readJudgeDecisionRows(dbPath)).toHaveLength(2);
  });

  test("runEfficacyReplay throws naming judge_decisions before any fetch when the table is missing", async () => {
    const dbPath = makeDbPath();
    const setup = new Database(dbPath);
    try {
      setup.run("DROP TABLE judge_decisions");
    } finally {
      setup.close();
    }
    const counter = { calls: 0 };
    const args = parseEfficacyReplayArgs(["--db", dbPath, "--all-completed-jobs", "--live"]);

    const error = await runEfficacyReplay(args, makeDeps(JEV_EFFICACY_MODEL, counter)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/judge_decisions/);
    expect(counter.calls).toBe(0);
  });
});
