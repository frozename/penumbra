import type { TypesafeFetch } from "@penumbra/typesafe";

import { reloadAgentChatConfig } from "@penumbra/config";
import { applySchema, loadSqliteVec, readJudgeDecisions, writeJudgeDecision } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_P1_JEV_SHADOW_ESTIMATE_USD, type DreamConfig } from "@src/dreaming/config.js";
import { type DreamCycleDeps, runDreamCycle } from "@src/dreaming/cycle.js";
import { buildDreamCycleDeps } from "@src/dreaming/deps.js";
import { type JudgeVote, makeFakeJudgePool } from "@src/dreaming/judge-pool.js";
import {
  composeShadowJudgePool,
  createTypesafeShadowSeat,
  drainShadowJudgements,
  type JevShadowDecision,
  type JevShadowJudge,
  type JevShadowJudgeLoader,
  type JevShadowJudgement,
  type JevShadowOutcome,
  P1_PROMOTION_JUDGE_SITE,
  TYPESAFE_SHADOW_SUBSYSTEM,
  type TypesafeModuleLike,
} from "@src/dreaming/typesafe-judge-seat.js";
import { readSubsystemHealth } from "@src/services/subsystem-health.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

const FROZEN = new Date("2026-02-01T00:00:00.000Z");
const ROLLUP_IDS = ["r1", "r2", "r3"];
const WIRE_INPUT_TOKENS = 4321;
const JEV_WIRE_RESPONSE = {
  model: "jev-1.13.0",
  answers: {
    is_durable_fact_worth_keeping: { type: "noul", noul: 0.9 },
    is_ephemeral_runtime_noise: { type: "noul", noul: 0.05 },
    is_prompt_or_task_artifact: { type: "noul", noul: 0.05 },
    is_mechanically_discoverable_from_the_repo: { type: "noul", noul: 0.05 },
  },
  usage: { input_tokens: WIRE_INPUT_TOKENS, output_tokens: 17 },
};
const SHADOW_ENV = {
  PENUMBRA_TYPESAFE_BASE_URL: "https://api.typesafe.ai",
  PENUMBRA_TYPESAFE_MODEL: "jev-1.13.0",
  PENUMBRA_TYPESAFE_TIMEOUT_MS: 10_000,
  PENUMBRA_TYPESAFE_JUDGE_PROMOTION: "shadow",
} as const;
const VOTES: JudgeVote[] = [
  { promote: false, confidence: 0.6 },
  { promote: false, confidence: 0.5 },
  { promote: true, confidence: 0.4 },
];

afterEach(() => {
  setSystemTime();
});

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.0,
    dailyUsd: 100.0,
    curatorEnabled: false,
    pressureGuardEnabled: true,
    perCycleEmbeddingUsd: 0.1,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    t2PromotionMinEvents: 5,
    autoPromoteMinJudges: 2,
    contentQualityThreshold: 0.5,
    reembedBatchSize: 100,
    eventTriggerEnabled: false,
    idleMinutes: 15,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    pc1BatchSize: 100,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 2.0,
    rewriterEnabled: false,
    rewriterBaseUrl: "http://127.0.0.1:7944",
    rewriterModel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    rewriterTimeoutMs: 5000,
    rewriterCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    rewriterConcurrency: 4,
    skipPhases: new Set(["P2", "P3", "P4", "P5", "P6", "P7", "P8", "PC1", "PC2"]),
    ...overrides,
  };
}

function seedRollups(db: Database, n: number): void {
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
       VALUES(?, 'test-user', ?, ?, 1, ?)`,
    ).run(
      ROLLUP_IDS[i] ?? `r-extra-${String(i + 1)}`,
      `session-${String(i + 1)}`,
      `2026-01-0${String(i + 1)}T00:00:00Z`,
      `durable finding ${String(i + 1)} about dispatch ordering that outlives this session`,
    );
  }
}

function seedSameDayLlmSpend(db: Database, llmUsd: number): void {
  const now = new Date();
  const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, ended_at, llm_spent_usd, embedding_spent_usd, research_spent_usd)
     VALUES('seed-spend', ?, 'cron', 1.0, 'completed', ?, ?, 0, 0)`,
  ).run(todayStartMs + 60_000, todayStartMs + 60_000, llmUsd);
}

function shadowSink(db: Database): (row: JevShadowDecision) => void {
  return (row) => {
    writeJudgeDecision(db, {
      decisionId: crypto.randomUUID(),
      site: row.site,
      subjectId: row.subjectId,
      mode: "shadow",
      model: row.model,
      incumbent: { votes: row.incumbentVotes },
      jev: {
        answers: row.answers,
        pPromote: row.pPromote,
        shadowPromote: row.shadowPromote,
        inputSha256: row.inputSha256,
        usageOutputTokens: row.usage.outputTokens,
        usd: row.usd,
        latencyMs: row.latencyMs,
      },
      usageInputTokens: row.usage.inputTokens,
      createdAt: row.createdAt,
    });
  };
}

function okJudgement(overrides?: Partial<JevShadowJudgement>): JevShadowJudgement {
  return {
    model: "jev-1.2.3",
    answers: { promote: 0.91 },
    pPromote: 0.91,
    shadowPromote: true,
    usage: { inputTokens: 987, outputTokens: 42 },
    usd: 0.0031,
    ...overrides,
  };
}

function loaderReturning(judge: JevShadowJudge): JevShadowJudgeLoader {
  return () => Promise.resolve(judge);
}

function dumpDreamActions(db: Database): Record<string, unknown>[] {
  const rows = db
    .prepare(`SELECT * FROM dream_actions ORDER BY phase, action_type, target_ids`)
    .all() as Record<string, unknown>[];
  return rows.map((r) => {
    const { action_id: _actionId, cycle_id: _cycleId, ...rest } = r;
    return rest;
  });
}

function dumpT1Rollups(db: Database): Record<string, unknown>[] {
  const rows = db.prepare(`SELECT * FROM t1_rollups ORDER BY rollup_id`).all() as Record<
    string,
    unknown
  >[];
  return rows.map((r) => {
    const { claimed_by_cycle: _claimedByCycle, ...rest } = r;
    return rest;
  });
}

interface ShadowPairResult {
  actionsA: Record<string, unknown>[];
  actionsB: Record<string, unknown>[];
  rollupsA: Record<string, unknown>[];
  rollupsB: Record<string, unknown>[];
  cycleA: { outcome: string; phases_run: string; llm_spent_usd: number };
  cycleB: { outcome: string; phases_run: string; llm_spent_usd: number };
  shadowDb: Database;
}

function dumpCycleRow(
  db: Database,
  cycleId: string,
): { outcome: string; phases_run: string; llm_spent_usd: number } {
  return db
    .prepare(`SELECT outcome, phases_run, llm_spent_usd FROM dream_cycles WHERE cycle_id = ?`)
    .get(cycleId) as { outcome: string; phases_run: string; llm_spent_usd: number };
}

async function runShadowPair(
  judge: JevShadowJudge,
  opts?: {
    budgetMs?: number;
    configOverrides?: Partial<DreamConfig>;
    seedTodayLlmSpendUsd?: number;
    rollupCount?: number;
  },
): Promise<ShadowPairResult> {
  setSystemTime(FROZEN);
  const dbA = openTestDb();
  const dbB = openTestDb();
  seedRollups(dbA, opts?.rollupCount ?? ROLLUP_IDS.length);
  seedRollups(dbB, opts?.rollupCount ?? ROLLUP_IDS.length);
  if (opts?.seedTodayLlmSpendUsd !== undefined) {
    seedSameDayLlmSpend(dbA, opts.seedTodayLlmSpendUsd);
    seedSameDayLlmSpend(dbB, opts.seedTodayLlmSpendUsd);
  }
  const config = testConfig(opts?.configOverrides);
  const pool = makeFakeJudgePool(VOTES);
  const cycleIdA = await runDreamCycle(dbA, config, { judgePool: pool });
  const depsB: DreamCycleDeps = {};
  const seat = createTypesafeShadowSeat({
    db: dbB,
    loadJudge: loaderReturning(judge),
    writeDecision: shadowSink(dbB),
    getCostMeter: () => depsB.costMeter,
    estimateUsd: DEFAULT_P1_JEV_SHADOW_ESTIMATE_USD,
    ...(opts?.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
  });
  depsB.judgePool = composeShadowJudgePool(pool, seat);
  const cycleIdB = await runDreamCycle(dbB, config, depsB);
  await drainShadowJudgements(5_000);
  return {
    actionsA: dumpDreamActions(dbA),
    actionsB: dumpDreamActions(dbB),
    rollupsA: dumpT1Rollups(dbA),
    rollupsB: dumpT1Rollups(dbB),
    cycleA: dumpCycleRow(dbA, cycleIdA),
    cycleB: dumpCycleRow(dbB, cycleIdB),
    shadowDb: dbB,
  };
}

function expectIdenticalRows(result: ShadowPairResult): void {
  expect(result.actionsB).toEqual(result.actionsA);
  expect(result.rollupsB).toEqual(result.rollupsA);
  expect(result.actionsA.length).toBeGreaterThan(0);
}

describe("P1 typesafe shadow seat", () => {
  it("leaves incumbent decisions byte-identical when Jev answers", async () => {
    const result = await runShadowPair(() =>
      Promise.resolve({ ok: true, judgement: okJudgement() }),
    );
    expectIdenticalRows(result);
    const decisions = readJudgeDecisions(result.shadowDb, { site: P1_PROMOTION_JUDGE_SITE });
    expect(decisions).toHaveLength(3);
    for (const d of decisions) {
      expect(d.site).toBe("dream.p1.promotion");
      expect(d.applied).toBe(false);
    }
  });

  it("leaves incumbent decisions byte-identical when Jev throws", async () => {
    const result = await runShadowPair(() => Promise.reject(new Error("jev exploded")));
    expectIdenticalRows(result);
    expect(readJudgeDecisions(result.shadowDb, {})).toHaveLength(0);
  });

  it("leaves incumbent decisions byte-identical when Jev exceeds the ballot budget", async () => {
    const result = await runShadowPair(() => new Promise<JevShadowOutcome>(() => undefined), {
      budgetMs: 20,
    });
    expectIdenticalRows(result);
    expect(readJudgeDecisions(result.shadowDb, {})).toHaveLength(0);
  });

  it("passes the rollup id through as the shadow subject", async () => {
    const result = await runShadowPair(() =>
      Promise.resolve({ ok: true, judgement: okJudgement() }),
    );
    const decisions = readJudgeDecisions(result.shadowDb, { site: P1_PROMOTION_JUDGE_SITE });
    expect(new Set(decisions.map((d) => d.subjectId))).toEqual(new Set(ROLLUP_IDS));
  });

  it("never invokes the judge when the daily llm lane cannot afford the estimate", async () => {
    let judgeCalls = 0;
    const result = await runShadowPair(
      () => {
        judgeCalls += 1;
        return Promise.resolve({ ok: true, judgement: okJudgement() });
      },
      { configOverrides: { dailyUsd: 1 }, seedTodayLlmSpendUsd: 0.299 },
    );
    expect(judgeCalls).toBe(0);
    expectIdenticalRows(result);
    expect(result.cycleB).toEqual(result.cycleA);
  });

  it("records judged shadow spend on the cycle row", async () => {
    const result = await runShadowPair(
      () =>
        Promise.resolve({
          ok: true,
          judgement: okJudgement({
            usage: { inputTokens: 1_000_000, outputTokens: 64 },
            usd: 0.042,
          }),
        }),
      { rollupCount: 1 },
    );
    expect(result.cycleB.llm_spent_usd - result.cycleA.llm_spent_usd).toBeCloseTo(0.042);
  });

  it("still invokes the judge when both usd caps are zero (uncapped is the live contract)", async () => {
    let judgeCalls = 0;
    const result = await runShadowPair(
      () => {
        judgeCalls += 1;
        return Promise.resolve({ ok: true, judgement: okJudgement() });
      },
      { configOverrides: { perCycleUsd: 0, dailyUsd: 0 } },
    );
    expect(judgeCalls).toBe(ROLLUP_IDS.length);
    expectIdenticalRows(result);
  });
});

describe("P1 typesafe shadow wiring through buildDreamCycleDeps", () => {
  it("writes one shadow judge_decisions row per rollup and leaves incumbent actions identical", async () => {
    setSystemTime(FROZEN);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      promote: true,
                      confidence: 0.8,
                      rationale: "seat-vote",
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    });
    const dir = join(tmpdir(), `p1-shadow-wiring-${crypto.randomUUID()}`);
    const savedConfigDir = process.env.PENUMBRA_CONFIG_DIR;
    const dbA = openTestDb();
    const dbB = openTestDb();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "agents.yaml"),
        "agents:\n" +
          `  - name: fake-seat-1\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://127.0.0.1:${String(server.port)}/v1\n      model: fake-incumbent\n` +
          `  - name: fake-seat-2\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://127.0.0.1:${String(server.port)}/v1\n      model: fake-incumbent\n`,
      );
      writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
      writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
      process.env.PENUMBRA_CONFIG_DIR = dir;
      reloadAgentChatConfig();

      const real = await import("@penumbra/typesafe");
      const fakeJevFetch: TypesafeFetch = () =>
        Promise.resolve(
          new Response(JSON.stringify(JEV_WIRE_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      const loadTypesafeModule = (): Promise<TypesafeModuleLike> =>
        Promise.resolve({
          ...real,
          resolveTypesafeSettings: () => ({
            enabled: true,
            apiKey: "test-key",
            keySource: "env",
            baseUrl: "https://api.typesafe.ai",
            model: "jev-1.13.0",
            timeoutMs: 10_000,
            judgePromotion: "shadow",
          }),
          createTypesafeClient: (o) => real.createTypesafeClient({ ...o, fetch: fakeJevFetch }),
        });
      const services = { loadTypesafeModule };
      const config = testConfig();

      seedRollups(dbA, ROLLUP_IDS.length);
      const depsA = buildDreamCycleDeps(services, dbA, {
        ...config,
        typesafeJudgePromotion: "off",
      });
      await runDreamCycle(dbA, config, depsA);

      seedRollups(dbB, ROLLUP_IDS.length);
      const depsB = buildDreamCycleDeps(services, dbB, {
        ...config,
        typesafeJudgePromotion: "shadow",
        typesafeEnv: SHADOW_ENV,
      });
      await runDreamCycle(dbB, config, depsB);
      await drainShadowJudgements(5_000);

      const decisions = readJudgeDecisions(dbB, { site: "dream.p1.promotion" });
      expect(decisions).toHaveLength(3);
      for (const d of decisions) {
        expect(d.applied).toBe(false);
        expect(d.mode).toBe("shadow");
        expect(ROLLUP_IDS).toContain(d.subjectId);
        expect(d.usageInputTokens).toBe(WIRE_INPUT_TOKENS);
      }
      expect(JSON.stringify(decisions)).not.toContain("durable finding");
      expect(dumpDreamActions(dbB)).toEqual(dumpDreamActions(dbA));
      expect(readSubsystemHealth(dbB, TYPESAFE_SHADOW_SUBSYSTEM)?.consecutive_failures).toBe(0);
      const stray = dbB
        .prepare(
          "SELECT subsystem FROM subsystem_health WHERE subsystem LIKE 'dream.judge.typesafe%'",
        )
        .all();
      expect(stray).toHaveLength(0);
    } finally {
      void server.stop(true);
      if (savedConfigDir === undefined) {
        delete process.env.PENUMBRA_CONFIG_DIR;
      } else {
        process.env.PENUMBRA_CONFIG_DIR = savedConfigDir;
      }
      reloadAgentChatConfig();
      rmSync(dir, { recursive: true, force: true });
      dbA.close();
      dbB.close();
    }
  });
});
