import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RoutingDecision, TaskProfile } from "../packages/core/src/routing/schemas.js";
import type { AgentTaskType } from "../packages/core/src/schemas/agent-performance.js";
import type { TypesafeFetch } from "../packages/integrations/typesafe/src/client.js";
import type { TypesafeEnvInput } from "../packages/integrations/typesafe/src/config.js";

import { migrate } from "../packages/core/src/db/migrations.js";
import { loadSqliteVec } from "../packages/core/src/db/sqlite-vec.js";
import { writeRoutingDecision } from "../packages/core/src/routing/decision-log.js";
import { RoutingTaskTypeSchema } from "../packages/core/src/routing/schemas.js";
import { ROUTER_SCORED_AXES } from "../packages/core/src/routing/task-profile-judge.js";
import { profileTaskDeterministic } from "../packages/core/src/routing/task-profile.js";
import { parseProfileReplayArgs, runProfileReplay } from "./jev-profile-replay.js";

const SINCE = "2026-08-01T00:00:00.000Z";
const UNTIL = "2026-08-31T00:00:00.000Z";
const TS = "2026-08-05T10:00:00.000Z";
const ROLE = "executor";
const CHAIN_TASK_TYPE: AgentTaskType = "debug_diagnose";
const PROMPT = "Diagnose the flaky router test regression and root cause the failure";
const RECALL_PREFIX =
  "## Relevant prior context\nThe following memories were auto-recalled at dispatch time.\n";

const TYPESAFE_ENV: TypesafeEnvInput = {
  PENUMBRA_TYPESAFE_API_KEY: "test-key",
  PENUMBRA_TYPESAFE_BASE_URL: "https://api.typesafe.ai",
  PENUMBRA_TYPESAFE_MODEL: "jev-1.13.0",
  PENUMBRA_TYPESAFE_TIMEOUT_MS: 10000,
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "shadow",
};

const SCORE_LEVEL_KEYS = ["0", "1", "2", "3", "4"];

function scoreAnswer(value: number, confidence: number): Record<string, unknown> {
  return {
    type: "score",
    score: value,
    legend: Object.fromEntries(SCORE_LEVEL_KEYS.map((key) => [key, `level ${key}`])),
    probabilities: Object.fromEntries(
      SCORE_LEVEL_KEYS.map((key) => [key, Number(key) === value ? 1 : 0]),
    ),
    confidence,
  };
}

function choiceAnswer(value: string, confidence: number): Record<string, unknown> {
  return {
    type: "choice",
    choice: value,
    probabilities: Object.fromEntries(
      RoutingTaskTypeSchema.options.map((option) => [option, option === value ? 1 : 0]),
    ),
    confidence,
  };
}

function cannedJevResponse(): Promise<Response> {
  const answers: Record<string, unknown> = {
    primary_task_type: choiceAnswer("coding", 0.9),
  };
  for (const axis of ROUTER_SCORED_AXES) {
    answers[axis] = scoreAnswer(3, 0.9);
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
}

function makeDecision(taskProfile: TaskProfile): RoutingDecision {
  return {
    selected: {
      agent: "quality-seat",
      provider: "openai",
      routeId: "openai:quality-seat",
    },
    taskProfile,
    score: 0.88,
    confidence: 0.8,
    alternatives: [],
    factors: [],
    fallbackChain: [],
    dataFreshness: {},
    explanation: [],
    routerSchemaVersion: "1",
  };
}

function seedReplayRow(
  db: Database,
  opts: { handoffId: string; decisionId: string; ts: string },
): void {
  const recordedProfile = profileTaskDeterministic(PROMPT, ROLE, {
    taskType: CHAIN_TASK_TYPE,
  });
  const eventId = `${opts.handoffId}-event`;
  db.prepare(
    `
      INSERT INTO t0_events (
        event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane,
        payload_json
      ) VALUES (?, ?, ?, 'test', 'user', 'machine', 'agent-message', 'lane', ?)
    `,
  ).run(eventId, opts.ts, opts.ts, JSON.stringify({ prompt: PROMPT }));
  db.prepare(
    `
      INSERT INTO handoffs (
        handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
        message, status, triggered_by_event_id, chain_task_type
      ) VALUES (?, ?, 'project', ?, 'maestro', 'quality-seat', ?, ?, 'resolved', ?, ?)
    `,
  ).run(
    opts.handoffId,
    opts.ts,
    `${opts.handoffId}-conversation`,
    ROLE,
    RECALL_PREFIX + PROMPT,
    eventId,
    CHAIN_TASK_TYPE,
  );
  writeRoutingDecision(db, makeDecision(recordedProfile), {
    decisionId: opts.decisionId,
    ts: opts.ts,
    handoffId: opts.handoffId,
    mode: "live",
    applied: true,
    role: ROLE,
  });
}

function seedDbFile(dbPath: string, rowCount: number): void {
  const db = new Database(dbPath);
  try {
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    for (let index = 0; index < rowCount; index++) {
      const n = index + 1;
      seedReplayRow(db, {
        handoffId: `handoff-${String(n)}`,
        decisionId: `decision-${String(n)}`,
        ts: `2026-08-05T1${String(n)}:00:00.000Z`,
      });
    }
  } finally {
    db.close();
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("jev-profile-replay", () => {
  const tmpDirs: string[] = [];
  const openDbs: Database[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "jev-profile-replay-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseProfileReplayArgs reads the confidence floor from router.yaml, honors overrides and defaults", () => {
    const configDir = makeTmpDir();
    writeFileSync(join(configDir, "router.yaml"), "thresholds:\n  judge_confidence_floor: 0.8\n");
    const env = { PENUMBRA_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;

    const parsed = parseProfileReplayArgs(
      ["--db", "/tmp/db.sqlite", "--since", SINCE, "--until", UNTIL],
      env,
    );
    expect(parsed.confidenceFloor).toBe(0.8);
    expect(parsed.db).toBe("/tmp/db.sqlite");
    expect(parsed.since).toBe(SINCE);
    expect(parsed.until).toBe(UNTIL);
    expect(parsed.live).toBe(false);
    expect(parsed.limit).toBe(25);

    const overridden = parseProfileReplayArgs(
      ["--db", "/tmp/db.sqlite", "--since", SINCE, "--until", UNTIL, "--confidence-floor", "0.3"],
      env,
    );
    expect(overridden.confidenceFloor).toBe(0.3);

    expect(() =>
      parseProfileReplayArgs(["--db", "/tmp/db.sqlite", "--until", UNTIL], env),
    ).toThrow();
  });

  test("dry run reports row counts and drift without touching the network", async () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "db.sqlite");
    seedDbFile(dbPath, 1);
    const args = parseProfileReplayArgs(["--db", dbPath, "--since", SINCE, "--until", UNTIL], {
      PENUMBRA_CONFIG_DIR: join(dir, "cfg"),
    });

    let fetchCalls = 0;
    const fetchImpl: TypesafeFetch = () => {
      fetchCalls++;
      return cannedJevResponse();
    };
    const { report, db } = await runProfileReplay(args, {
      fetch: fetchImpl,
      typesafeEnv: TYPESAFE_ENV,
      maxRetries: 0,
    });
    openDbs.push(db);

    expect(fetchCalls).toBe(0);
    expect(report.totalRows).toBe(1);
    expect(report.inputDrift).toBe(0);
    expect(report.judged).toBe(0);
  });

  test("an out-of-range confidenceFloor rejects before the database is opened", async () => {
    const dir = makeTmpDir();
    const args = parseProfileReplayArgs(
      ["--db", join(dir, "missing.sqlite"), "--since", SINCE, "--until", UNTIL, "--live"],
      { PENUMBRA_CONFIG_DIR: join(dir, "cfg") },
    );
    args.confidenceFloor = 1.5;

    const error = await runProfileReplay(args, {
      fetch: () => cannedJevResponse(),
      typesafeEnv: TYPESAFE_ENV,
      maxRetries: 0,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/confidence.?floor/i);
  });

  test("live run judges rows through the injected fetch and leaves the DB untouched", async () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "db.sqlite");
    seedDbFile(dbPath, 1);
    const args = parseProfileReplayArgs(
      ["--db", dbPath, "--since", SINCE, "--until", UNTIL, "--live"],
      { PENUMBRA_CONFIG_DIR: join(dir, "cfg") },
    );
    const hashBefore = sha256(dbPath);

    let fetchCalls = 0;
    const fetchImpl: TypesafeFetch = () => {
      fetchCalls++;
      return cannedJevResponse();
    };
    const { report, db } = await runProfileReplay(args, {
      fetch: fetchImpl,
      typesafeEnv: TYPESAFE_ENV,
      maxRetries: 0,
    });
    openDbs.push(db);

    expect(fetchCalls).toBe(1);
    expect(report.judged).toBe(1);
    expect(report.bySource.jev).toBe(1);
    expect(sha256(dbPath)).toBe(hashBefore);
    expect(() =>
      db.run(
        `INSERT INTO t0_events (
           event_id, ts, ingest_ts, source, user_id, machine_id, event_type, lane,
           payload_json
         ) VALUES ('write-probe', 'x', 'x', 'x', 'x', 'x', 'x', 'x', '{}')`,
      ),
    ).toThrow("attempt to write a readonly database");
  });

  test("--live --limit 1 over two seeded rows makes exactly one Jev call", async () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "db.sqlite");
    seedDbFile(dbPath, 2);
    const args = parseProfileReplayArgs(
      ["--db", dbPath, "--since", SINCE, "--until", UNTIL, "--live", "--limit", "1"],
      { PENUMBRA_CONFIG_DIR: join(dir, "cfg") },
    );

    let fetchCalls = 0;
    const fetchImpl: TypesafeFetch = () => {
      fetchCalls++;
      return cannedJevResponse();
    };
    const { report, db } = await runProfileReplay(args, {
      fetch: fetchImpl,
      typesafeEnv: TYPESAFE_ENV,
      maxRetries: 0,
    });
    openDbs.push(db);

    expect(fetchCalls).toBe(1);
    expect(report.judged).toBe(1);
  });
});
