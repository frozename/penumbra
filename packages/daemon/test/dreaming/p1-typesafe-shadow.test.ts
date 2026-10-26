import type { TypesafeFetch } from "@penumbra/typesafe";

import { reloadAgentChatConfig } from "@penumbra/config";
import {
  applySchema,
  loadSqliteVec,
  type Logger,
  readJudgeDecisions,
  writeJudgeDecision,
} from "@penumbra/core";
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

// #284: the incumbent dreaming-judge seats never open a socket. Each seat has
// its own origin, and buildDreamCycleDeps hands this fetch to the judge pool
// through services.judgeFetch. A seat listed in failSeats rejects the way a
// refused connection does, so the pool records transport_error for it.
const INCUMBENT_SEAT_BY_ORIGIN = new Map<string, string>([
  ["http://127.0.0.1:1", "fake-seat-1"],
  ["http://127.0.0.1:9", "fake-seat-2"],
]);

function incumbentAgentsYaml(): string {
  return (
    "agents:\n" +
    "  - name: fake-seat-1\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://127.0.0.1:1/v1\n      model: fake-incumbent\n" +
    "  - name: fake-seat-2\n    adapter: openai-compat-http\n    api_provider: local\n    roles:\n      - dreaming-judge\n    options:\n      baseUrl: http://127.0.0.1:9/v1\n      model: fake-incumbent\n"
  );
}

function incumbentSeatFetch(opts: {
  content: string;
  failSeats: readonly string[];
  onCall?: (seat: string) => void;
}): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const seat = INCUMBENT_SEAT_BY_ORIGIN.get(new URL(url).origin);
    if (seat === undefined) {
      return Promise.resolve(new Response("no route", { status: 599 }));
    }
    opts.onCall?.(seat);
    if (opts.failSeats.includes(seat)) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: opts.content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
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
    const dir = join(tmpdir(), `p1-shadow-wiring-${crypto.randomUUID()}`);
    const savedConfigDir = process.env.PENUMBRA_CONFIG_DIR;
    const dbA = openTestDb();
    const dbB = openTestDb();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "agents.yaml"), incumbentAgentsYaml());
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
      const services = {
        loadTypesafeModule,
        judgeFetch: incumbentSeatFetch({
          content: JSON.stringify({ promote: true, confidence: 0.8, rationale: "seat-vote" }),
          failSeats: [],
        }),
      };
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

type VetoJev =
  | { kind: "outcome"; outcome: JevShadowOutcome }
  | { kind: "wire"; response: unknown }
  | { kind: "import-fail" };

interface VetoRunResult {
  db: Database;
  jevCalls: number;
  embedCalls: number;
  incumbentCalls: number;
  logCalls: VetoLogCall[];
}

interface VetoLogCall {
  level: "info" | "warn";
  fields: Record<string, unknown>;
  msg: unknown;
}

function captureVetoLog(logCalls: VetoLogCall[]): Logger {
  return {
    info: (fields: unknown, msg: unknown): void => {
      logCalls.push({ level: "info", fields: fields as Record<string, unknown>, msg });
    },
    warn: (fields: unknown, msg: unknown): void => {
      logCalls.push({ level: "warn", fields: fields as Record<string, unknown>, msg });
    },
  } as unknown as Logger;
}

function vetoLogCalls(logCalls: VetoLogCall[]): VetoLogCall[] {
  return logCalls.filter((c) => "jev_veto" in c.fields);
}

function jevWireResponse(durable: number, strongestFilter: number): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      is_durable_fact_worth_keeping: { type: "noul", noul: durable },
      is_ephemeral_runtime_noise: { type: "noul", noul: strongestFilter },
      is_prompt_or_task_artifact: { type: "noul", noul: 0 },
      is_mechanically_discoverable_from_the_repo: { type: "noul", noul: 0 },
    },
    usage: { input_tokens: 100, output_tokens: 5 },
  };
}

async function runVetoCycle(opts: {
  mode: "off" | "shadow" | "veto";
  seatVote: { promote: boolean; confidence: number };
  jev: VetoJev;
  rollupCount?: number;
  configOverrides?: Partial<DreamConfig>;
  seedTodayLlmSpendUsd?: number;
  failSeats?: readonly string[];
}): Promise<VetoRunResult> {
  setSystemTime(FROZEN);
  const content = JSON.stringify({
    promote: opts.seatVote.promote,
    confidence: opts.seatVote.confidence,
    rationale: "seat-vote",
  });
  const dir = join(tmpdir(), `p1-veto-${crypto.randomUUID()}`);
  const savedConfigDir = process.env.PENUMBRA_CONFIG_DIR;
  const db = openTestDb();
  const counters = { jevCalls: 0, embedCalls: 0, incumbentCalls: 0 };
  const judgeFetch = incumbentSeatFetch({
    content,
    failSeats: opts.failSeats ?? [],
    onCall: () => {
      counters.incumbentCalls += 1;
    },
  });
  const logCalls: VetoLogCall[] = [];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agents.yaml"), incumbentAgentsYaml());
    writeFileSync(join(dir, "routing.yaml"), "default_roles: {}\n");
    writeFileSync(join(dir, "quotas.yaml"), "providers: []\n");
    process.env.PENUMBRA_CONFIG_DIR = dir;
    reloadAgentChatConfig();

    const jev = opts.jev;
    const loadTypesafeModule = async (): Promise<TypesafeModuleLike> => {
      if (jev.kind === "import-fail") throw new Error("typesafe module missing");
      const settings = {
        enabled: true as const,
        apiKey: "test-key",
        keySource: "env" as const,
        baseUrl: "https://api.typesafe.ai",
        model: "jev-1.13.0",
        timeoutMs: 10_000,
        judgePromotion: opts.mode,
      };
      if (jev.kind === "wire") {
        const real = await import("@penumbra/typesafe");
        const response = jev.response;
        const fakeJevFetch: TypesafeFetch = () =>
          Promise.resolve(
            new Response(JSON.stringify(response), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        return {
          ...real,
          resolveTypesafeSettings: () => settings,
          createTypesafeClient: (o) => real.createTypesafeClient({ ...o, fetch: fakeJevFetch }),
          judgePromotion: (client, input, signal): Promise<JevShadowOutcome> => {
            counters.jevCalls += 1;
            return real.judgePromotion(client, input, signal);
          },
        };
      }
      const outcome = jev.outcome;
      return {
        resolveTypesafeSettings: () => settings,
        createTypesafeClient: () => ({
          evaluate: () => Promise.reject(new Error("unused in veto test")),
        }),
        judgePromotion: (): Promise<JevShadowOutcome> => {
          counters.jevCalls += 1;
          return Promise.resolve(outcome);
        },
      };
    };
    const services = {
      loadTypesafeModule,
      judgeFetch,
      log: captureVetoLog(logCalls),
      embedder: {
        embed: (bodies: string[]): Promise<Float32Array[]> => {
          counters.embedCalls += bodies.length;
          return Promise.resolve(bodies.map(() => new Float32Array([0.1, 0.2, 0.3])));
        },
      },
    };
    seedRollups(db, opts.rollupCount ?? 1);
    if (opts.seedTodayLlmSpendUsd !== undefined) {
      seedSameDayLlmSpend(db, opts.seedTodayLlmSpendUsd);
    }
    const config = testConfig({
      typesafeJudgePromotion: opts.mode,
      typesafeEnv: { ...SHADOW_ENV, PENUMBRA_TYPESAFE_JUDGE_PROMOTION: opts.mode },
      ...opts.configOverrides,
    });
    const deps = buildDreamCycleDeps(services, db, config);
    await runDreamCycle(db, config, deps);
    await drainShadowJudgements(5_000);
    return { db, ...counters, logCalls };
  } finally {
    if (savedConfigDir === undefined) {
      delete process.env.PENUMBRA_CONFIG_DIR;
    } else {
      process.env.PENUMBRA_CONFIG_DIR = savedConfigDir;
    }
    reloadAgentChatConfig();
    rmSync(dir, { recursive: true, force: true });
  }
}

function p1PromoteActions(db: Database): { status: string; payload: Record<string, unknown> }[] {
  const rows = db
    .prepare(
      `SELECT status, payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY target_ids`,
    )
    .all() as { status: string; payload_json: string }[];
  return rows.map((r) => ({
    status: r.status,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  }));
}

function promotedT2Count(db: Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM t2_memories WHERE kind='promoted'`).get() as {
      c: number;
    }
  ).c;
}

function rollupPromotionStamps(
  db: Database,
  rollupId: string,
): { promotion_filtered_at: string | null; t2_promoted_at: string | null } {
  return db
    .prepare(`SELECT promotion_filtered_at, t2_promoted_at FROM t1_rollups WHERE rollup_id = ?`)
    .get(rollupId) as {
    promotion_filtered_at: string | null;
    t2_promoted_at: string | null;
  };
}

interface PromotionDiagnosis {
  promoted: number;
  abstentions: { seat: unknown; errorClass: unknown }[];
  deferrals: { reason: unknown; retryCount: unknown }[];
  retryCount: number | null;
}

// #284: the promoted-row count plus the silent routes to zero rows (seat
// abstentions and P1 deferrals), so a failing equality names its own cause.
function promotionDiagnosis(db: Database, logCalls: VetoLogCall[]): PromotionDiagnosis {
  const rollup = db
    .prepare(`SELECT promotion_retry_count FROM t1_rollups WHERE rollup_id = 'r1'`)
    .get() as { promotion_retry_count: number } | null;
  return {
    promoted: promotedT2Count(db),
    abstentions: logCalls
      .filter((c) => c.msg === "dream-cycle P1 judge seat abstained")
      .map((c) => ({ seat: c.fields["seat"], errorClass: c.fields["errorClass"] })),
    deferrals: logCalls
      .filter((c) => c.msg === "dream-cycle P1 promotion deferred")
      .map((c) => ({ reason: c.fields["reason"], retryCount: c.fields["retryCount"] })),
    retryCount: rollup?.promotion_retry_count ?? null,
  };
}

const PROMOTED_CLEANLY: PromotionDiagnosis = {
  promoted: 1,
  abstentions: [],
  deferrals: [],
  retryCount: 0,
};

describe("P1 Jev veto mode", () => {
  it("blocks the auto-promotion onto the queued path when Jev answers below the promote threshold", async () => {
    const { db, jevCalls, embedCalls, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: {
        kind: "outcome",
        outcome: {
          ok: true,
          judgement: okJudgement({ pPromote: 0.2, shadowPromote: false }),
        },
      },
    });
    try {
      // One detached shadow ballot plus one synchronous veto consultation.
      expect(jevCalls).toBe(2);
      expect(embedCalls).toBe(0);
      expect(promotedT2Count(db)).toBe(0);
      const actions = p1PromoteActions(db);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("jev_reject");
      const rollup = rollupPromotionStamps(db, "r1");
      expect(rollup.promotion_filtered_at).not.toBeNull();
      expect(rollup.t2_promoted_at).toBeNull();
      // Veto mode keeps the shadow lane: the detached ballot still lands a row.
      expect(readJudgeDecisions(db, { site: P1_PROMOTION_JUDGE_SITE })).toHaveLength(1);
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("info");
      expect(vetoLogs[0]?.fields).toEqual({
        rollup_id: "r1",
        jev_veto: "blocked",
        jev_veto_reason: "jev_reject",
      });
      expect(JSON.stringify(vetoLogs[0]?.fields)).not.toContain("durable finding");
    } finally {
      db.close();
    }
  });

  it("mints the t2 row with jev_veto allowed when the real wire lands pPromote exactly on the 0.5 threshold", async () => {
    const { db, jevCalls, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "wire", response: jevWireResponse(0.5, 0) },
    });
    try {
      expect(jevCalls).toBe(2);
      expect(promotionDiagnosis(db, logCalls)).toEqual(PROMOTED_CLEANLY);
      const actions = p1PromoteActions(db);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.status).toBe("auto_applied");
      expect(actions[0]?.payload["jev_veto"]).toBe("allowed");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("jev_promote");
      expect(typeof actions[0]?.payload["t2_memory_id"]).toBe("string");
      expect(rollupPromotionStamps(db, "r1").t2_promoted_at).not.toBeNull();
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("info");
      expect(vetoLogs[0]?.fields).toEqual({
        rollup_id: "r1",
        jev_veto: "allowed",
        jev_veto_reason: "jev_promote",
      });
    } finally {
      db.close();
    }
  });

  it("blocks when the real wire lands pPromote just under the promote threshold", async () => {
    // 0.5 * (1 - 0.04) = 0.48 < 0.5
    const { db, jevCalls, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "wire", response: jevWireResponse(0.5, 0.04) },
    });
    try {
      expect(jevCalls).toBe(2);
      expect(promotedT2Count(db)).toBe(0);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("jev_reject");
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("info");
    } finally {
      db.close();
    }
  });

  it("fails closed when the typesafe module cannot be loaded", async () => {
    const { db, jevCalls, embedCalls, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "import-fail" },
    });
    try {
      expect(jevCalls).toBe(0);
      expect(embedCalls).toBe(0);
      expect(promotedT2Count(db)).toBe(0);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("loader_unavailable");
      expect(readJudgeDecisions(db, {})).toHaveLength(0);
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("warn");
      expect(vetoLogs[0]?.fields).toEqual({
        rollup_id: "r1",
        jev_veto: "blocked",
        jev_veto_reason: "loader_unavailable",
      });
    } finally {
      db.close();
    }
  });

  it("blocks with reason exception and warns when the veto function itself throws", async () => {
    setSystemTime(FROZEN);
    const db = openTestDb();
    const logCalls: VetoLogCall[] = [];
    try {
      seedRollups(db, 1);
      const deps: DreamCycleDeps = {
        judgePool: makeFakeJudgePool([
          { promote: true, confidence: 0.9 },
          { promote: true, confidence: 0.8 },
        ]),
        promotionVeto: () => Promise.reject(new Error("veto exploded")),
        log: captureVetoLog(logCalls),
      };
      await runDreamCycle(db, testConfig(), deps);
      const actions = p1PromoteActions(db);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("exception");
      expect(promotedT2Count(db)).toBe(0);
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("warn");
      expect(vetoLogs[0]?.fields).toEqual({
        rollup_id: "r1",
        jev_veto: "blocked",
        jev_veto_reason: "exception",
      });
      expect(JSON.stringify(vetoLogs[0]?.fields)).not.toContain("durable finding");
    } finally {
      db.close();
    }
  });

  it("blocks with reason timeout and warns when the Jev call times out", async () => {
    const { db, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: false, reason: "timeout", status: null } },
    });
    try {
      expect(promotedT2Count(db)).toBe(0);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("timeout");
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("warn");
      expect(vetoLogs[0]?.fields).toEqual({
        rollup_id: "r1",
        jev_veto: "blocked",
        jev_veto_reason: "timeout",
      });
    } finally {
      db.close();
    }
  });

  it("blocks with reason judge_failed and warns when the Jev call fails", async () => {
    const { db, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: false, reason: "transport", status: null } },
    });
    try {
      expect(promotedT2Count(db)).toBe(0);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("judge_failed");
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("warn");
      expect(vetoLogs[0]?.fields["jev_veto_reason"]).toBe("judge_failed");
    } finally {
      db.close();
    }
  });

  it("blocks with reason cost_gate and warns when the meter refuses the estimate", async () => {
    const { db, jevCalls, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: true, judgement: okJudgement() } },
      configOverrides: { dailyUsd: 1 },
      seedTodayLlmSpendUsd: 0.299,
    });
    try {
      // Both lanes refuse at the meter, so the judge is never invoked.
      expect(jevCalls).toBe(0);
      expect(promotedT2Count(db)).toBe(0);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload["jev_veto"]).toBe("blocked");
      expect(actions[0]?.payload["jev_veto_reason"]).toBe("cost_gate");
      const vetoLogs = vetoLogCalls(logCalls);
      expect(vetoLogs).toHaveLength(1);
      expect(vetoLogs[0]?.level).toBe("warn");
      expect(vetoLogs[0]?.fields["jev_veto_reason"]).toBe("cost_gate");
    } finally {
      db.close();
    }
  });

  it("never consults the veto when the incumbent does not auto-promote", async () => {
    const { db, jevCalls, logCalls } = await runVetoCycle({
      mode: "veto",
      seatVote: { promote: false, confidence: 0.8 },
      jev: { kind: "outcome", outcome: { ok: true, judgement: okJudgement() } },
    });
    try {
      // Only the detached shadow ballot fires; a veto call would make this 2.
      expect(jevCalls).toBe(1);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("queued");
      expect(actions[0]?.payload).not.toHaveProperty("jev_veto");
      expect(actions[0]?.payload).not.toHaveProperty("jev_veto_reason");
      expect(promotedT2Count(db)).toBe(0);
      expect(vetoLogCalls(logCalls)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("shadow mode auto-promotes without a jev_veto payload field", async () => {
    const { db, jevCalls, incumbentCalls, logCalls } = await runVetoCycle({
      mode: "shadow",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: true, judgement: okJudgement() } },
    });
    try {
      expect(incumbentCalls).toBe(2);
      expect(jevCalls).toBe(1);
      expect(promotionDiagnosis(db, logCalls)).toEqual(PROMOTED_CLEANLY);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("auto_applied");
      expect(actions[0]?.payload).not.toHaveProperty("jev_veto");
      expect(actions[0]?.payload).not.toHaveProperty("jev_veto_reason");
      expect(vetoLogCalls(logCalls)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("off mode auto-promotes with no typesafe wiring and no jev_veto field", async () => {
    const { db, jevCalls, logCalls } = await runVetoCycle({
      mode: "off",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: true, judgement: okJudgement() } },
    });
    try {
      expect(jevCalls).toBe(0);
      expect(promotionDiagnosis(db, logCalls)).toEqual(PROMOTED_CLEANLY);
      const actions = p1PromoteActions(db);
      expect(actions[0]?.status).toBe("auto_applied");
      expect(actions[0]?.payload).not.toHaveProperty("jev_veto");
      expect(actions[0]?.payload).not.toHaveProperty("jev_veto_reason");
      expect(readJudgeDecisions(db, {})).toHaveLength(0);
      expect(vetoLogCalls(logCalls)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("routes both incumbent seats through the injected judge fetch", async () => {
    const { db, incumbentCalls, logCalls } = await runVetoCycle({
      mode: "shadow",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: true, judgement: okJudgement() } },
    });
    try {
      expect(incumbentCalls).toBe(2);
      expect(promotionDiagnosis(db, logCalls)).toEqual(PROMOTED_CLEANLY);
    } finally {
      db.close();
    }
  });

  it("defers the promotion and names the seat when one incumbent seat has a transport failure", async () => {
    const { db, incumbentCalls, logCalls } = await runVetoCycle({
      mode: "shadow",
      seatVote: { promote: true, confidence: 0.9 },
      jev: { kind: "outcome", outcome: { ok: true, judgement: okJudgement() } },
      failSeats: ["fake-seat-2"],
    });
    try {
      expect(incumbentCalls).toBe(2);
      expect(promotionDiagnosis(db, logCalls)).toEqual({
        promoted: 0,
        abstentions: [{ seat: "fake-seat-2", errorClass: "transport_error" }],
        deferrals: [{ reason: "insufficient_judge_votes", retryCount: 1 }],
        retryCount: 1,
      });
      expect(p1PromoteActions(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
