import { DispatchEventKindSchema } from "@penumbra/api-contract";
import { applySchema, loadSqliteVec, T2Promotion, type T2PromotionOpts } from "@penumbra/core";
import { T2_SETTLED_ROLLUP_SQL } from "@penumbra/core/writers/t2-settle";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { DreamConfig } from "@src/dreaming/config.js";
import { type DreamCycleDeps, runDreamCycle } from "@src/dreaming/cycle.js";
import {
  buildDreamingPromptBlock,
  createDreamingJudgePool,
} from "@src/dreaming/dreaming-judge-pool.js";
import type { JudgePool, JudgeVote } from "@src/dreaming/judge-pool.js";
import { authorClass, buildP1PromotionInput, renderP1PromptBlock } from "@src/dreaming/p1-input.js";
import {
  composeShadowJudgePool,
  type TypesafeShadowSeat,
} from "@src/dreaming/typesafe-judge-seat.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

// Golden copies of the v1 contract as it shipped before the flag existed.
const V1_PROMPT_GOLDEN = [
  "You are a memory quality judge deciding whether a candidate memory record should be promoted to long-term storage.",
  "",
  'Return promote: false when the content is ephemeral: one-time observations ("X passed", "task #5 created"), session-specific events, literal system/dispatch prompts ("You are X, a long-lived agent...", "# Operating rules", "IMPLEMENTER MODE"), or anything that won\'t be true in 30 days. Return promote: true ONLY for durable knowledge: design decisions, project facts, user preferences, conventions, rules, debugging findings, gotchas, traps.',
  "Memory kind: promote_t1",
  "Memory body:",
  "BODY",
  "",
  "Output ONLY valid JSON — no prose, no code fences, no wrapper tags:",
  '{"promote": <boolean>, "confidence": <number 0.0-1.0>, "rationale": "<one sentence>"}',
].join("\n");

const V1_CLAIM_SQL_GOLDEN = [
  "UPDATE t1_rollups SET claimed_at = ?, claimed_by_cycle = ?",
  "        WHERE rollup_id IN (",
  "          SELECT rollup_id FROM (",
  "            SELECT rollup_id, project_id, promotion_retry_count FROM t1_rollups",
  "               WHERE t2_promoted_at IS NULL",
  "                 AND claimed_at IS NULL",
  "                 AND promotion_filtered_at IS NULL",
  "                 AND promotion_unusable_excerpt_at IS NULL",
  "                 AND promotion_retry_exhausted_at IS NULL",
  "                 AND (promotion_retry_after IS NULL OR promotion_retry_after <= ?)",
  "                 AND (first_prompt_excerpt IS NULL OR (first_prompt_excerpt NOT LIKE ? AND first_prompt_excerpt NOT LIKE ? AND first_prompt_excerpt NOT LIKE ? AND first_prompt_excerpt NOT LIKE ? AND first_prompt_excerpt NOT LIKE ? AND first_prompt_excerpt NOT LIKE ?))",
  "                 AND (user_id IS NULL OR user_id NOT IN (?))",
  "                 AND NOT EXISTS (",
  "                   SELECT 1 FROM dream_actions da",
  "                   WHERE da.action_type = 'promote_t1'",
  "                     AND da.status = 'queued'",
  "                     AND da.target_ids = json_array(t1_rollups.rollup_id)",
  "                 )",
  "                 ORDER BY started_at ASC",
  "                 LIMIT ?",
  "            )",
  "        )",
  "        RETURNING rollup_id, first_prompt_excerpt, project_id, promotion_retry_count",
].join("\n");

const HUMAN_BODY = "durable finding: the recall index must be rebuilt after a schema migration.";
const AGENT_BODY = "[recall] stamped worker prompt: implement the reconciler sweep fix for lanes.";

const NO_VOTES: JudgeVote[] = [
  { promote: false, confidence: 0.4 },
  { promote: false, confidence: 0.3 },
];
const YES_VOTES: JudgeVote[] = [
  { promote: true, confidence: 0.9 },
  { promote: true, confidence: 0.8 },
];

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
    rewriterEnabled: false,
    rewriterBaseUrl: "",
    rewriterModel: "",
    rewriterTimeoutMs: 5000,
    rewriterCacheTtlMs: 1000,
    rewriterConcurrency: 1,
    skipPhases: new Set(["P2", "P3", "P4", "P5", "P6", "P7", "P8", "PC1", "PC2"]),
    contentQualityThreshold: 0.5,
    reembedBatchSize: 100,
    eventTriggerEnabled: false,
    idleMinutes: 10,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 0,
    pc1BatchSize: 100,
    pc2MinClusterSize: 3,
    pc2ClusterLinkThreshold: 0.85,
    pc2AutoThreshold: 0.97,
    ...overrides,
  };
}

type Author = "human" | "agentchat" | "chain-start" | "none";

function seedRollup(
  db: Database,
  opts: {
    id: string;
    body: string;
    nEvents?: number;
    author: Author;
    startedAt?: string;
    endedAt?: string | null;
  },
): void {
  const sessionId = `session-${opts.id}`;
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, project_id, started_at, ended_at, n_events, first_prompt_excerpt)
     VALUES(?, 'test-user', ?, NULL, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    sessionId,
    opts.startedAt ?? "2026-01-01T00:00:00Z",
    opts.endedAt === undefined ? "2026-01-01T00:10:00Z" : opts.endedAt,
    opts.nEvents ?? 1,
    opts.body,
  );
  const t0 = db.prepare(
    `INSERT INTO t0_events(event_id, ts, ingest_ts, source, source_detail, user_id, machine_id, session_id, event_type, lane, payload_json, payload_summary)
     VALUES(?, ?, ?, ?, ?, 'test-user', 'local', ?, ?, 'cli-subscription', '{}', ?)`,
  );
  const ts = "2026-01-01T00:00:01Z";
  if (opts.author === "human") {
    t0.run(
      `${opts.id}-p`,
      ts,
      ts,
      "claude-code",
      "user-prompt",
      sessionId,
      "agent-prompt",
      opts.body,
    );
  } else if (opts.author === "agentchat") {
    t0.run(`${opts.id}-p`, ts, ts, "agentchat", null, sessionId, "agent-prompt", opts.body);
  } else if (opts.author === "chain-start") {
    t0.run(`${opts.id}-u`, ts, ts, "agentchat", "chain-start", sessionId, "user-prompt", "raw");
    const later = "2026-01-01T00:00:02Z";
    t0.run(`${opts.id}-p`, later, later, "agentchat", null, sessionId, "agent-prompt", opts.body);
  }
}

interface SpyPool extends JudgePool {
  calls: { body: string; kind: string; prompt?: string; subjectId?: string }[];
}

function spyPool(votes: JudgeVote[]): SpyPool {
  const calls: SpyPool["calls"] = [];
  return {
    calls,
    judge: () => Promise.resolve({ confidence: 0.5, verdict: "unsure" }),
    judgeAll: (args): Promise<JudgeVote[]> => {
      calls.push({ ...args });
      return Promise.resolve(votes);
    },
  };
}

function testEmbed(): Promise<Float32Array> {
  return Promise.resolve(new Float32Array([0.1, 0.2, 0.3]));
}

function capturingFetch(promote: boolean): { fetch: typeof fetch; prompts: string[] } {
  const prompts: string[] = [];
  const impl = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const sent = JSON.parse(raw) as { messages: { content: string }[] };
    prompts.push(sent.messages[0]?.content ?? "");
    const content = JSON.stringify({ promote, confidence: 0.8, rationale: "r" });
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
    );
  };
  return { fetch: impl as typeof fetch, prompts };
}

function realPool(promote: boolean): { pool: JudgePool; prompts: string[] } {
  const { fetch: fetchImpl, prompts } = capturingFetch(promote);
  const pool = createDreamingJudgePool(
    [
      { name: "j1", baseUrl: "http://127.0.0.1:1", apiKey: "", model: "m" },
      { name: "j2", baseUrl: "http://127.0.0.1:2", apiKey: "", model: "m" },
    ],
    fetchImpl,
  );
  return { pool, prompts };
}

function recordSql(db: Database): string[] {
  const sqls: string[] = [];
  const original = db.prepare.bind(db);
  const recording = (sql: string): ReturnType<Database["prepare"]> => {
    sqls.push(sql);
    return original(sql);
  };
  Object.defineProperty(db, "prepare", { value: recording, configurable: true });
  return sqls;
}

function claimSqls(sqls: string[]): string[] {
  return sqls.filter((s) => s.includes("SET claimed_at = ?, claimed_by_cycle = ?"));
}

interface RollupState {
  claimed_by_cycle: string | null;
  promotion_filtered_at: string | null;
  promotion_unusable_excerpt_at: number | null;
  t2_promoted_at: string | null;
}

function rollupState(db: Database, id: string): RollupState | null {
  return db
    .prepare(
      `SELECT claimed_by_cycle, promotion_filtered_at, promotion_unusable_excerpt_at, t2_promoted_at
         FROM t1_rollups WHERE rollup_id=?`,
    )
    .get(id) as RollupState | null;
}

function promoteActions(db: Database): { status: string; target_ids: string }[] {
  return db
    .prepare(
      `SELECT status, target_ids FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'
        ORDER BY target_ids`,
    )
    .all() as { status: string; target_ids: string }[];
}

function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function t2Detector(db: Database): T2Promotion {
  return new T2Promotion({ db } as unknown as T2PromotionOpts);
}

describe("authorClass", () => {
  it("classifies only a Claude Code user prompt as human", () => {
    expect(authorClass({ source: "claude-code", source_detail: "user-prompt" })).toBe("human");
    expect(authorClass({ source: "agentchat", source_detail: null })).toBe("agent");
    expect(authorClass({ source: "agentchat", source_detail: "chain-start" })).toBe("agent");
    expect(authorClass({ source: "daemon", source_detail: "chain-start" })).toBe("agent");
    expect(authorClass({ source: "claude-code", source_detail: "tool:Bash" })).toBe("unknown");
    expect(authorClass({ source: "codex", source_detail: "user-prompt" })).toBe("unknown");
    expect(authorClass(null)).toBe("unknown");
    expect(authorClass(undefined)).toBe("unknown");
  });
});

describe("buildP1PromotionInput", () => {
  const human = {
    source: "claude-code",
    source_detail: "user-prompt",
    payload_summary: HUMAN_BODY,
  };

  it("v1 judges the excerpt verbatim with no provenance gate", () => {
    expect(buildP1PromotionInput({ contract: "v1", excerpt: AGENT_BODY })).toEqual({
      eligible: true,
      body: AGENT_BODY,
    });
    expect(buildP1PromotionInput({ contract: "v1", excerpt: "too short" })).toEqual({
      eligible: false,
      reason: "unusable_excerpt",
    });
    expect(buildP1PromotionInput({ contract: "v1", excerpt: null })).toEqual({
      eligible: false,
      reason: "unusable_excerpt",
    });
  });

  it("v2 admits a human prompt below the T2 minimum with the stored text as the body", () => {
    const input = buildP1PromotionInput({
      contract: "v2",
      excerpt: HUMAN_BODY,
      nEvents: 4,
      t2MinEvents: 5,
      firstPrompt: human,
    });
    expect(input).toEqual({ eligible: true, body: HUMAN_BODY });
  });

  it("v2 skips each ineligible shape with a deterministic reason", () => {
    const base = { contract: "v2", excerpt: HUMAN_BODY, nEvents: 1, t2MinEvents: 5 } as const;
    const reasonOf = (input: ReturnType<typeof buildP1PromotionInput>): string =>
      input.eligible ? "eligible" : input.reason;
    expect(reasonOf(buildP1PromotionInput({ ...base, nEvents: 5, firstPrompt: human }))).toBe(
      "t2_owned",
    );
    expect(reasonOf(buildP1PromotionInput({ ...base, excerpt: "short", firstPrompt: human }))).toBe(
      "unusable_excerpt",
    );
    expect(
      reasonOf(
        buildP1PromotionInput({
          ...base,
          firstPrompt: { source: "agentchat", source_detail: null, payload_summary: HUMAN_BODY },
        }),
      ),
    ).toBe("agent_authored");
    expect(reasonOf(buildP1PromotionInput({ ...base, firstPrompt: null }))).toBe("unknown_origin");
    expect(
      reasonOf(
        buildP1PromotionInput({ ...base, firstPrompt: { ...human, payload_summary: "other" } }),
      ),
    ).toBe("provenance_mismatch");
  });
});

describe("P1 prompt rendering", () => {
  it("keeps the v1 prompt byte-identical", () => {
    expect(buildDreamingPromptBlock({ body: "BODY", kind: "promote_t1" })).toBe(V1_PROMPT_GOLDEN);
  });

  it("renders v2 as the v1 prompt without the bogus Memory kind line", () => {
    const v2 = renderP1PromptBlock({ body: HUMAN_BODY });
    expect(v2).not.toContain("Memory kind");
    expect(v2).toContain(`Memory body:\n${HUMAN_BODY}\n`);
    expect(v2).toBe(
      buildDreamingPromptBlock({ body: HUMAN_BODY, kind: "promote_t1" }).replace(
        "Memory kind: promote_t1\n",
        "",
      ),
    );
  });

  it("leaves link, retire and rewrite prompts unchanged", () => {
    for (const kind of ["link", "retire", "rewrite"]) {
      expect(buildDreamingPromptBlock({ body: "BODY", kind })).toBe(
        V1_PROMPT_GOLDEN.replace("Memory kind: promote_t1", `Memory kind: ${kind}`),
      );
    }
  });
});

describe("P1 input contract v1 (default)", () => {
  for (const flag of [undefined, "v1"] as const) {
    it(`flag ${String(flag)} keeps the claim SQL, prompt and NO path byte-identical`, async () => {
      const db = openTestDb();
      seedRollup(db, { id: "a", body: AGENT_BODY, nEvents: 10, author: "agentchat" });
      const sqls = recordSql(db);
      const { pool, prompts } = realPool(false);
      const config = testConfig(flag === undefined ? {} : { p1InputContract: flag });
      const cycleId = await runDreamCycle(db, config, { judgePool: pool });

      expect(claimSqls(sqls)).toEqual([V1_CLAIM_SQL_GOLDEN]);
      expect([...new Set(prompts)]).toEqual([V1_PROMPT_GOLDEN.replace("BODY", AGENT_BODY)]);
      expect(promoteActions(db)).toEqual([{ status: "queued", target_ids: '["a"]' }]);
      const state = rollupState(db, "a");
      expect(state?.claimed_by_cycle).toBe(cycleId);
      expect(state?.promotion_filtered_at).not.toBeNull();
      expect(state?.promotion_unusable_excerpt_at).toBeNull();
    });
  }
});

describe("P1 input contract v2", () => {
  it("skips agent, dispatcher and unknown-origin rollups without calling any judge", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "agent", body: AGENT_BODY, author: "agentchat" });
    seedRollup(db, { id: "dispatch", body: AGENT_BODY, author: "chain-start" });
    seedRollup(db, { id: "orphan", body: HUMAN_BODY, author: "none" });
    const pool = spyPool(YES_VOTES);
    const events: { kind: string; meta?: unknown }[] = [];
    const veto: string[] = [];
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: pool,
      onReembed: testEmbed,
      promotionVeto: (input) => {
        veto.push(input.rollupId);
        return Promise.resolve({ decision: "allow", reason: "jev_promote" });
      },
      dispatchEventLog: {
        record(event) {
          events.push(event);
        },
      },
    });

    expect(pool.calls).toHaveLength(0);
    expect(veto).toHaveLength(0);
    expect(promoteActions(db)).toEqual([]);
    for (const id of ["agent", "dispatch", "orphan"]) {
      const state = rollupState(db, id);
      expect(state?.promotion_unusable_excerpt_at).not.toBeNull();
      expect(state?.promotion_filtered_at).toBeNull();
      expect(state?.t2_promoted_at).toBeNull();
    }
    const skipped = events.filter((e) => e.kind === "dream_p1_input_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.meta).toEqual({
      contract: "v2",
      skipped: { agent_authored: 2, unknown_origin: 1 },
    });
    expect(DispatchEventKindSchema.safeParse(skipped[0]?.kind).success).toBe(true);
  });

  it("leaves rollups at or above the T2 minimum unclaimed so T2 still extracts them", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "small", body: HUMAN_BODY, nEvents: 2, author: "human" });
    seedRollup(db, { id: "edge", body: HUMAN_BODY, nEvents: 3, author: "human" });
    seedRollup(db, { id: "big", body: HUMAN_BODY, nEvents: 40, author: "human" });
    const sqls = recordSql(db);
    const pool = spyPool(NO_VOTES);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2", t2PromotionMinEvents: 3 }), {
      judgePool: pool,
    });

    expect(pool.calls.map((c) => c.subjectId)).toEqual(["small"]);
    for (const id of ["edge", "big"]) {
      expect(rollupState(db, id)).toEqual({
        claimed_by_cycle: null,
        promotion_filtered_at: null,
        promotion_unusable_excerpt_at: null,
        t2_promoted_at: null,
      });
    }
    expect(claimSqls(sqls).every((s) => s.includes("AND n_events < ?"))).toBe(true);
    const eligible = t2Detector(db).detectEligibleRollups(24, new Date("2026-02-01T00:00:00Z"), 3);
    expect(eligible.sort()).toEqual(["big", "edge"]);
  });

  it("stamps promotion_filtered_at on a NO without queueing a promote_t1 action", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    const pool = spyPool(NO_VOTES);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), { judgePool: pool });

    expect(pool.calls).toHaveLength(1);
    expect(promoteActions(db)).toEqual([]);
    expect(rollupState(db, "h")?.promotion_filtered_at).not.toBeNull();

    db.prepare(`UPDATE t1_rollups SET claimed_at=NULL, claimed_by_cycle=NULL`).run();
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), { judgePool: pool });
    expect(pool.calls).toHaveLength(1);
  });

  it("treats a vetoed YES as a NO and queues no action", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: spyPool(YES_VOTES),
      onReembed: testEmbed,
      promotionVeto: () => Promise.resolve({ decision: "block", reason: "jev_reject" }),
    });
    expect(promoteActions(db)).toEqual([]);
    expect(rollupState(db, "h")?.promotion_filtered_at).not.toBeNull();
    expect(rollupState(db, "h")?.t2_promoted_at).toBeNull();
  });

  it("stores exactly the body the judges saw", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    const pool = spyPool(YES_VOTES);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: pool,
      onReembed: testEmbed,
    });

    expect(pool.calls).toHaveLength(1);
    const judged = pool.calls[0]?.body;
    const stored = db.prepare(`SELECT body FROM t2_memories WHERE kind='promoted'`).get() as {
      body: string;
    } | null;
    expect(judged).toBe(HUMAN_BODY);
    expect(stored?.body).toBe(judged);
    expect(rollupState(db, "h")?.t2_promoted_at).not.toBeNull();
    expect(promoteActions(db)).toEqual([{ status: "auto_applied", target_ids: '["h"]' }]);
  });

  it("sends the judges a prompt with no Memory kind line", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    const { pool, prompts } = realPool(false);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), { judgePool: pool });

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toBe(renderP1PromptBlock({ body: HUMAN_BODY }));
      expect(prompt).not.toContain("Memory kind");
    }
  });

  it("hands the veto and the shadow seat only the candidate text", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    const vetoInputs: unknown[] = [];
    const shadowInputs: unknown[] = [];
    const seat: TypesafeShadowSeat = {
      shadow: (input) => {
        shadowInputs.push(input);
        return Promise.resolve();
      },
    };
    const deps: DreamCycleDeps = {
      judgePool: composeShadowJudgePool(spyPool(YES_VOTES), seat),
      onReembed: testEmbed,
      promotionVeto: (input) => {
        vetoInputs.push(input);
        return Promise.resolve({ decision: "allow", reason: "jev_promote" });
      },
    };
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), deps);

    expect(vetoInputs).toEqual([{ rollupId: "h", body: HUMAN_BODY }]);
    expect(shadowInputs).toEqual([{ body: HUMAN_BODY, kind: "promote_t1", subjectId: "h" }]);
  });
});

describe("P1 input contract v2 settle gate", () => {
  it("does not claim a rollup younger than the T2 delay, so T2 still extracts it once it grows", async () => {
    const db = openTestDb();
    seedRollup(db, {
      id: "young",
      body: HUMAN_BODY,
      nEvents: 2,
      author: "human",
      startedAt: hoursAgoIso(2),
      endedAt: hoursAgoIso(1),
    });
    seedRollup(db, {
      id: "open",
      body: HUMAN_BODY,
      nEvents: 2,
      author: "human",
      startedAt: hoursAgoIso(2),
      endedAt: null,
    });
    const sqls = recordSql(db);
    const pool = spyPool(NO_VOTES);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: pool,
      onReembed: testEmbed,
    });

    expect(claimSqls(sqls).every((s) => s.includes(`AND ${T2_SETTLED_ROLLUP_SQL}`))).toBe(true);
    expect(claimSqls(sqls).length).toBeGreaterThan(0);
    expect(pool.calls).toHaveLength(0);
    for (const id of ["young", "open"]) {
      expect(rollupState(db, id)).toEqual({
        claimed_by_cycle: null,
        promotion_filtered_at: null,
        promotion_unusable_excerpt_at: null,
        t2_promoted_at: null,
      });
    }
    expect(promoteActions(db)).toEqual([]);

    // The session resumes and T1 grows the rollup past the T2 minimum.
    db.prepare(`UPDATE t1_rollups SET n_events=12`).run();
    const later = new Date(Date.now() + 48 * 3600_000);
    expect(t2Detector(db).detectEligibleRollups(24, later, 5).sort()).toEqual(["open", "young"]);
  });

  it("reads the delay T2 uses from the dream config", async () => {
    const db = openTestDb();
    seedRollup(db, {
      id: "r",
      body: HUMAN_BODY,
      nEvents: 2,
      author: "human",
      startedAt: hoursAgoIso(3),
      endedAt: hoursAgoIso(2),
    });
    const strict = spyPool(NO_VOTES);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2", t2PromotionDelayHours: 3 }), {
      judgePool: strict,
    });
    expect(strict.calls).toHaveLength(0);
    expect(rollupState(db, "r")?.claimed_by_cycle).toBeNull();

    const loose = spyPool(NO_VOTES);
    await runDreamCycle(db, testConfig({ p1InputContract: "v2", t2PromotionDelayHours: 1 }), {
      judgePool: loose,
    });
    expect(loose.calls.map((c) => c.subjectId)).toEqual(["r"]);
  });

  it("claims a rollup older than the delay with n_events below the minimum", async () => {
    const db = openTestDb();
    seedRollup(db, {
      id: "settled",
      body: HUMAN_BODY,
      nEvents: 2,
      author: "human",
      startedAt: hoursAgoIso(26),
      endedAt: hoursAgoIso(25),
    });
    const pool = spyPool(YES_VOTES);
    const cycleId = await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: pool,
      onReembed: testEmbed,
    });

    expect(pool.calls.map((c) => c.subjectId)).toEqual(["settled"]);
    const state = rollupState(db, "settled");
    expect(state?.claimed_by_cycle).toBe(cycleId);
    expect(state?.t2_promoted_at).not.toBeNull();
    expect(promoteActions(db)).toEqual([{ status: "auto_applied", target_ids: '["settled"]' }]);
  });
});

describe("P1 input contract v2 unappliable YES paths", () => {
  it("stamps a YES whose embed fails and queues no promote_t1 action", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: spyPool(YES_VOTES),
      onReembed: () => Promise.reject(new Error("embed down")),
    });

    expect(promoteActions(db)).toEqual([]);
    const state = rollupState(db, "h");
    expect(state?.promotion_filtered_at).not.toBeNull();
    expect(state?.t2_promoted_at).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM t2_memories`).get()).toEqual({ n: 0 });
  });

  it("stamps a YES with no embed handler and queues no promote_t1 action", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "h", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: spyPool(YES_VOTES),
    });

    expect(promoteActions(db)).toEqual([]);
    expect(rollupState(db, "h")?.promotion_filtered_at).not.toBeNull();
    expect(rollupState(db, "h")?.t2_promoted_at).toBeNull();
  });

  it("stamps a duplicate-title YES and queues no promote_t1 action", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "first", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: spyPool(YES_VOTES),
      onReembed: testEmbed,
    });
    expect(rollupState(db, "first")?.t2_promoted_at).not.toBeNull();

    seedRollup(db, { id: "second", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig({ p1InputContract: "v2" }), {
      judgePool: spyPool(YES_VOTES),
      onReembed: testEmbed,
    });

    expect(promoteActions(db)).toEqual([{ status: "auto_applied", target_ids: '["first"]' }]);
    const state = rollupState(db, "second");
    expect(state?.promotion_filtered_at).not.toBeNull();
    expect(state?.t2_promoted_at).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM t2_memories WHERE kind='promoted'`).get()).toEqual(
      { n: 1 },
    );
  });

  it("keeps the v1 duplicate-title and embed-failure paths queueing promote_t1", async () => {
    const db = openTestDb();
    seedRollup(db, { id: "first", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig(), {
      judgePool: spyPool(YES_VOTES),
      onReembed: testEmbed,
    });
    seedRollup(db, { id: "second", body: HUMAN_BODY, author: "human" });
    await runDreamCycle(db, testConfig(), {
      judgePool: spyPool(YES_VOTES),
      onReembed: testEmbed,
    });
    seedRollup(db, { id: "third", body: AGENT_BODY, author: "agentchat" });
    await runDreamCycle(db, testConfig(), {
      judgePool: spyPool(YES_VOTES),
      onReembed: () => Promise.reject(new Error("embed down")),
    });

    expect(promoteActions(db)).toEqual([
      { status: "auto_applied", target_ids: '["first"]' },
      { status: "queued", target_ids: '["second"]' },
      { status: "queued", target_ids: '["third"]' },
    ]);
  });
});
