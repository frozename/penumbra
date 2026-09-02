import type { Logger } from "@penumbra/core";

import { applySchema, buildT2EmbedText, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, it } from "bun:test";

import type { DreamConfig } from "@src/dreaming/config.js";
import { P1_CLAIM_TTL_MS, runDreamCycle } from "@src/dreaming/cycle.js";
import { makeFakeJudgePool } from "@src/dreaming/judge-pool.js";
import { setRewriteForMemory } from "@src/dreaming/query-rewriter-cache.js";
import { sanitizeTitleForQuery } from "@src/dreaming/query-sanitize.js";
import { hashQuery } from "@src/dreaming/research.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

let previousT2EmbedRecipe: string | undefined;
let previousT2ReembedEnabled: string | undefined;
let previousDreamingEnabled: string | undefined;
let previousDreamingRewriterEnabled: string | undefined;

beforeAll(() => {
  previousT2EmbedRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
  previousT2ReembedEnabled = process.env.PENUMBRA_T2_REEMBED_ENABLED;
  previousDreamingEnabled = process.env.PENUMBRA_DREAMING_ENABLED;
  previousDreamingRewriterEnabled = process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "body_v1";
  delete process.env.PENUMBRA_T2_REEMBED_ENABLED;
  delete process.env.PENUMBRA_DREAMING_ENABLED;
  delete process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
});

afterAll(() => {
  if (previousT2EmbedRecipe === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
  else process.env.PENUMBRA_T2_EMBED_RECIPE = previousT2EmbedRecipe;
  if (previousT2ReembedEnabled === undefined) delete process.env.PENUMBRA_T2_REEMBED_ENABLED;
  else process.env.PENUMBRA_T2_REEMBED_ENABLED = previousT2ReembedEnabled;
  if (previousDreamingEnabled === undefined) delete process.env.PENUMBRA_DREAMING_ENABLED;
  else process.env.PENUMBRA_DREAMING_ENABLED = previousDreamingEnabled;
  if (previousDreamingRewriterEnabled === undefined)
    delete process.env.PENUMBRA_DREAMING_REWRITER_ENABLED;
  else process.env.PENUMBRA_DREAMING_REWRITER_ENABLED = previousDreamingRewriterEnabled;
});

function makeLogSpy(spy: (fields: Record<string, unknown>, msg: string) => void): Logger {
  return { info: spy } as unknown as Logger;
}

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
    rewriterEnabled: false,
    rewriterBaseUrl: "http://127.0.0.1:7944",
    rewriterModel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    rewriterTimeoutMs: 5000,
    rewriterCacheTtlMs: 30 * 24 * 60 * 60 * 1000,
    rewriterConcurrency: 4,
    skipPhases: new Set(),
    ...overrides,
  };
}

function seedTodaySpend(
  db: Database,
  opts: { llm: number; embedding: number; research: number },
): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, ended_at, llm_spent_usd, embedding_spent_usd, research_spent_usd)
     VALUES('seed-spend', ?, 'cron', 1.0, 'completed', ?, ?, ?, ?)`,
  ).run(Date.now(), Date.now(), opts.llm, opts.embedding, opts.research);
}

function seedUnpromotedRollups(db: Database, n: number): void {
  for (let i = 0; i < n; i++) {
    const rollupId = `R${String(i + 1)}`;
    const sessionId = `session-${String(i + 1)}`;
    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
       VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', 1, ?)`,
    ).run(rollupId, sessionId, `rollup-${String(i + 1)}`);
  }
}

function seedMemoryWithVector(db: Database, opts: { id: string; vector: number[] }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', 'feedback', ?, ?, ?, 'body', ?, ?)`,
  ).run(opts.id, now, now, opts.id, now, now);
  const { rowid } = db
    .prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`)
    .get(opts.id) as { rowid: number };
  db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(
    rowid,
    new Float32Array(opts.vector),
  );
}

function getCycleOutcome(db: Database, cycleId: string): string {
  const row = db.prepare(`SELECT outcome FROM dream_cycles WHERE cycle_id = ?`).get(cycleId) as {
    outcome: string;
  } | null;
  return row?.outcome ?? "";
}

function getCycleBailReason(db: Database, cycleId: string): string {
  const row = db
    .prepare(`SELECT bail_reason FROM dream_cycles WHERE cycle_id = ?`)
    .get(cycleId) as { bail_reason: string | null } | null;
  return row?.bail_reason ?? "";
}

function getClaimedRollups(db: Database, cycleId: string): string[] {
  const rows = db
    .prepare(`SELECT rollup_id FROM t1_rollups WHERE claimed_by_cycle = ?`)
    .all(cycleId) as { rollup_id: string }[];
  return rows.map((r) => r.rollup_id);
}

it("P0 bails when daily cap already reached", async () => {
  const db = openTestDb();
  seedTodaySpend(db, { llm: 4.5, embedding: 0.4, research: 0.2 }); // total 5.10 > dailyUsd 5.0
  const cycleId = await runDreamCycle(db, testConfig({ dailyUsd: 5.0 }));
  expect(getCycleOutcome(db, cycleId)).toBe("bailed");
  expect(getCycleBailReason(db, cycleId)).toMatch(/daily/i);
});

it("P0 treats zero USD caps as unlimited and still runs P7", async () => {
  const db = openTestDb();
  const cycleId = await runDreamCycle(db, testConfig({ dailyUsd: 0, perCycleUsd: 0 }));
  const row = db
    .prepare(`SELECT outcome, bail_reason, phases_run FROM dream_cycles WHERE cycle_id = ?`)
    .get(cycleId) as { outcome: string; bail_reason: string | null; phases_run: string };
  const phasesRun = JSON.parse(row.phases_run) as string[];
  expect(row.outcome).not.toBe("bailed");
  expect(row.bail_reason ?? "").not.toMatch(/daily|per-cycle|per cycle|usd/i);
  expect(phasesRun).toContain("P7");
});

it("defaults an omitted skipPhases to run P7", async () => {
  const db = openTestDb();
  const { skipPhases: _skipPhases, ...configWithoutSkipPhases } = testConfig();

  const cyclePromise = runDreamCycle(db, configWithoutSkipPhases as unknown as DreamConfig);
  const cycleId = await cyclePromise;
  expect(typeof cycleId).toBe("string");

  const row = db.prepare(`SELECT phases_run FROM dream_cycles WHERE cycle_id = ?`).get(cycleId) as {
    phases_run: string;
  };
  expect(JSON.parse(row.phases_run) as string[]).toContain("P7");
});

it("P0 bails when per-cycle LLM cap exceeded", async () => {
  const db = openTestDb();
  const cycleId = await runDreamCycle(db, testConfig({ perCycleUsd: 0.001 }));
  expect(getCycleOutcome(db, cycleId)).toBe("bailed");
  expect(getCycleBailReason(db, cycleId)).toMatch(/per.cycle/i);
});

it("P0 bails when pressure guard sees throttled provider", async () => {
  const db = openTestDb();
  const pressureStub = {
    check: (): Promise<{ anyThrottled: boolean }> => Promise.resolve({ anyThrottled: true }),
  };
  const cycleId = await runDreamCycle(db, testConfig(), { pressureGuard: pressureStub });
  expect(getCycleOutcome(db, cycleId)).toBe("bailed");
  expect(getCycleBailReason(db, cycleId)).toMatch(/pressure/i);
});

it("P0 duration includes pre-flight pressure guard work", async () => {
  const db = openTestDb();
  const originalDateNow = Date.now;
  let nowMs = 1_000_000;
  Object.defineProperty(Date, "now", {
    value: () => nowMs,
    writable: true,
  });
  const phaseEnds: Record<string, unknown>[] = [];
  const log = makeLogSpy((fields, msg) => {
    if (msg === "dream-cycle phase end") phaseEnds.push(fields);
  });
  const pressureStub = {
    check: (): Promise<{ anyThrottled: boolean }> => {
      nowMs += 42;
      return Promise.resolve({ anyThrottled: false });
    },
  };

  try {
    await runDreamCycle(db, testConfig(), { pressureGuard: pressureStub, log });
  } finally {
    Object.defineProperty(Date, "now", {
      value: originalDateNow,
      writable: true,
    });
  }

  const p0End = phaseEnds.find((entry) => entry.phase === "P0");
  expect(p0End?.durationMs).toBeGreaterThanOrEqual(42);
});

it("P0 pressure guard: flap mid-cycle bails before next phase", async () => {
  const db = openTestDb();
  let callCount = 0;
  const pressureStub = {
    check: (): Promise<{ anyThrottled: boolean }> =>
      Promise.resolve({ anyThrottled: callCount++ > 1 }), // flips throttled after 2nd call
  };
  const cycleId = await runDreamCycle(db, testConfig(), { pressureGuard: pressureStub });
  const row = db.prepare(`SELECT phases_run FROM dream_cycles WHERE cycle_id=?`).get(cycleId) as {
    phases_run: string;
  };
  const phases = JSON.parse(row.phases_run) as string[];
  // bails after first throttled check; P0 was fine, but mid-cycle re-check trips
  expect(phases.length).toBeLessThan(4);
});

it("P1 transactional claim: two concurrent P1 invocations produce disjoint working sets", async () => {
  const db = openTestDb();
  seedUnpromotedRollups(db, 10);
  const [c1, c2] = await Promise.all([
    runDreamCycle(db, testConfig()),
    runDreamCycle(db, testConfig()),
  ]);
  const c1claims = getClaimedRollups(db, c1);
  const c2claims = getClaimedRollups(db, c2);
  const intersection = c1claims.filter((id: string) => c2claims.includes(id));
  expect(intersection).toHaveLength(0);
});

it("P1 releases claims held by terminal cycles so rollups are re-selectable", async () => {
  const db = openTestDb();
  const oldCycleId = "terminal-cycle";
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, ended_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, ?, 'cron', 1.0, 'completed', '["P0","P1"]')`,
  ).run(oldCycleId, Date.now() - 10_000, Date.now() - 5_000);

  const rollupId = seedUnpromotedRollup(db, {
    body: "terminal-cycle claim release regression: this rollup should be selectable by the next run.",
  });
  db.prepare(`UPDATE t1_rollups SET claimed_at=?, claimed_by_cycle=? WHERE rollup_id=?`).run(
    Date.now() - 1_000,
    oldCycleId,
    rollupId,
  );

  const cycleId = await runDreamCycle(db, testConfig());
  const action = db
    .prepare(
      `SELECT 1 AS ok
         FROM dream_actions
        WHERE cycle_id = ?
          AND phase = 'P1'
          AND action_type = 'promote_t1'
          AND target_ids = ?`,
    )
    .get(cycleId, JSON.stringify([rollupId])) as { ok: number } | null;
  expect(action?.ok).toBe(1);
});

it("P1 releases stale claims by TTL using millisecond timestamps", async () => {
  const db = openTestDb();
  const staleRollupId = seedUnpromotedRollup(db, {
    body: "stale claim should be released and re-selected after TTL elapsed in milliseconds.",
  });
  const freshRollupId = seedUnpromotedRollup(db, {
    body: "fresh claim should stay leased and not be re-selected yet.",
  });
  const now = Date.now();
  db.prepare(
    `UPDATE t1_rollups SET claimed_at=?, claimed_by_cycle='still-running' WHERE rollup_id=?`,
  ).run(now - P1_CLAIM_TTL_MS - 60_000, staleRollupId);
  db.prepare(
    `UPDATE t1_rollups SET claimed_at=?, claimed_by_cycle='still-running' WHERE rollup_id=?`,
  ).run(now - P1_CLAIM_TTL_MS + 60_000, freshRollupId);

  const cycleId = await runDreamCycle(db, testConfig());
  const staleAction = db
    .prepare(
      `SELECT 1 AS ok
         FROM dream_actions
        WHERE cycle_id = ?
          AND phase = 'P1'
          AND action_type = 'promote_t1'
          AND target_ids = ?`,
    )
    .get(cycleId, JSON.stringify([staleRollupId])) as { ok: number } | null;
  expect(staleAction?.ok).toBe(1);

  const fresh = db
    .prepare(`SELECT claimed_by_cycle FROM t1_rollups WHERE rollup_id=?`)
    .get(freshRollupId) as { claimed_by_cycle: string | null } | null;
  expect(fresh?.claimed_by_cycle).toBe("still-running");
});

function p1DedupConfig(): DreamConfig {
  return testConfig({
    autoPromoteMinJudges: 2,
    skipPhases: new Set(["P2", "P3", "P4", "P5", "P6", "P7", "P8", "PC1", "PC2"]),
  });
}

it("P1 does not re-queue promote_t1 for a never-promoted rollup across cycles", async () => {
  const db = openTestDb();
  const rollupId = seedUnpromotedRollup(db, {
    body: "long-enough body that clears the P1 excerpt guard for judging across cycles.",
  });
  const pool = makeFakeJudgePool([
    { promote: false, confidence: 0.4 },
    { promote: false, confidence: 0.3 },
  ]);

  await runDreamCycle(db, p1DedupConfig(), { judgePool: pool });

  db.prepare(
    `UPDATE t1_rollups SET claimed_at=NULL, claimed_by_cycle=NULL, promotion_filtered_at=NULL WHERE rollup_id=?`,
  ).run(rollupId);

  await runDreamCycle(db, p1DedupConfig(), { judgePool: pool });

  const queuedCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dream_actions
        WHERE phase='P1' AND action_type='promote_t1' AND status='queued' AND target_ids=?`,
    )
    .get(JSON.stringify([rollupId])) as { n: number };
  expect(queuedCount.n).toBe(1);
});

it("P1 stamps promotion_filtered_at on non-auto-promoted rollups so future cycles skip them", async () => {
  const db = openTestDb();
  const rollupId = seedUnpromotedRollup(db, {
    body: "long-enough body that clears the P1 excerpt guard so judges vote against promotion.",
  });
  const pool = makeFakeJudgePool([
    { promote: false, confidence: 0.4 },
    { promote: false, confidence: 0.3 },
  ]);

  await runDreamCycle(db, p1DedupConfig(), { judgePool: pool });

  const marker = db
    .prepare(`SELECT promotion_filtered_at FROM t1_rollups WHERE rollup_id=?`)
    .get(rollupId) as { promotion_filtered_at: string | null } | null;
  expect(marker?.promotion_filtered_at).not.toBeNull();

  db.prepare(`UPDATE t1_rollups SET claimed_at=NULL, claimed_by_cycle=NULL WHERE rollup_id=?`).run(
    rollupId,
  );

  await runDreamCycle(db, p1DedupConfig(), { judgePool: pool });

  const queuedCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dream_actions
        WHERE phase='P1' AND action_type='promote_t1' AND status='queued' AND target_ids=?`,
    )
    .get(JSON.stringify([rollupId])) as { n: number };
  expect(queuedCount.n).toBe(1);
});

it("P2 auto-applies semantic_near link when cosine >= LINK_AUTO_THRESHOLD", async () => {
  const db = openTestDb();
  seedMemoryWithVector(db, { id: "M-A", vector: [1, 0, 0] });
  seedMemoryWithVector(db, { id: "M-B", vector: [0.96, 0.1, 0] }); // cosine > 0.75
  await runDreamCycle(db, testConfig());
  const link = db.prepare(`SELECT * FROM memory_links WHERE link_type='semantic_near'`).get();
  expect(link).toBeDefined();
  const action = db
    .prepare(`SELECT * FROM dream_actions WHERE phase='P2' AND status='auto_applied'`)
    .get();
  expect(action).toBeDefined();
});

it("P2 queues semantic_near link when cosine < LINK_AUTO_THRESHOLD", async () => {
  const db = openTestDb();
  seedMemoryWithVector(db, { id: "M-A", vector: [1, 0, 0] });
  seedMemoryWithVector(db, { id: "M-B", vector: [0.5, 0.5, 0] }); // cosine < 0.75
  await runDreamCycle(db, testConfig());
  const action = db
    .prepare(`SELECT * FROM dream_actions WHERE phase='P2' AND status='queued'`)
    .get();
  expect(action).toBeDefined();
});

it("P2 does not queue duplicate semantic_near link actions across cycles", async () => {
  const db = openTestDb();
  seedMemoryWithVector(db, { id: "M-A", vector: [1, 0, 0] });
  seedMemoryWithVector(db, { id: "M-B", vector: [0.5, 0.5, 0] }); // cosine in queued band

  await runDreamCycle(db, testConfig());
  await runDreamCycle(db, testConfig());

  const queued = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM dream_actions
        WHERE phase='P2'
          AND action_type='link'
          AND status='queued'
          AND target_ids IN (?, ?)`,
    )
    .get(JSON.stringify(["M-A", "M-B"]), JSON.stringify(["M-B", "M-A"])) as { n: number };
  expect(queued.n).toBe(1);

  const reversedDb = openTestDb();
  seedMemoryWithVector(reversedDb, { id: "M-A", vector: [1, 0, 0] });
  seedMemoryWithVector(reversedDb, { id: "M-B", vector: [0.5, 0.5, 0] });
  ensureSeedCycle(reversedDb);
  reversedDb
    .prepare(
      `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
       VALUES(?, 'seed-cycle', 'P2', 'link', 0.7, 'queued', ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      JSON.stringify(["M-B", "M-A"]),
      JSON.stringify({ link_type: "semantic_near" }),
    );

  await runDreamCycle(reversedDb, testConfig());
  const reversedQueued = reversedDb
    .prepare(
      `SELECT COUNT(*) AS n
         FROM dream_actions
        WHERE phase='P2'
          AND action_type='link'
          AND status='queued'
          AND target_ids IN (?, ?)`,
    )
    .get(JSON.stringify(["M-A", "M-B"]), JSON.stringify(["M-B", "M-A"])) as { n: number };
  expect(reversedQueued.n).toBe(1);
});

it("P8 sets completed outcome with non-null ended_at and non-empty phases_run", async () => {
  const db = openTestDb();
  const cycleId = await runDreamCycle(db, testConfig());
  const row = db
    .prepare(`SELECT outcome, ended_at, phases_run FROM dream_cycles WHERE cycle_id=?`)
    .get(cycleId) as {
    outcome: string;
    ended_at: number;
    phases_run: string;
  };
  expect(row.outcome).toBe("completed");
  expect(row.ended_at).toBeGreaterThan(0);
  const phases: unknown = JSON.parse(row.phases_run) as unknown;
  expect(Array.isArray(phases) && phases).toContain("P0");
});

it("in-process mutex prevents overlapping cycles", async () => {
  const db = openTestDb();
  await Promise.all([runDreamCycle(db, testConfig()), runDreamCycle(db, testConfig())]);
  const running = db
    .prepare(`SELECT COUNT(*) as n FROM dream_cycles WHERE outcome='running'`)
    .get() as { n: number };
  expect(running.n).toBe(0);
});

// ── helpers for P1/P3/P4 tests ─────────────────────────────────────────────

function ensureSeedCycle(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES('seed-cycle', 1, 'seed', 0, 'completed', '[]')`,
  ).run();
}

function seedMemory(db: Database, opts: { body: string; projectId?: string | null }): string {
  const memId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, project_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', ?, 'feedback', ?, ?, 'test', ?, ?, ?)`,
  ).run(memId, opts.projectId ?? null, now, now, opts.body, now, now);
  return memId;
}

function seedUnpromotedRollup(
  db: Database,
  opts: {
    body: string;
    userId?: string;
    firstPromptExcerpt?: string | null;
    projectId?: string | null;
  },
): string {
  const rollupId = crypto.randomUUID();
  const userId = opts.userId ?? "test-user";
  const firstPromptExcerpt =
    opts.firstPromptExcerpt === undefined ? opts.body : opts.firstPromptExcerpt;
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, project_id, started_at, n_events, first_prompt_excerpt)
     VALUES(?, ?, ?, ?, '2026-01-01T00:00:00Z', 1, ?)`,
  ).run(rollupId, userId, crypto.randomUUID(), opts.projectId ?? null, firstPromptExcerpt);
  return rollupId;
}

function testP1Embed(): Promise<Float32Array> {
  return Promise.resolve(new Float32Array([0.1, 0.2, 0.3]));
}

function seedNegativeResearchCache(
  db: Database,
  opts: { project_id: string; title: string; expiresAt: number; isNegative?: number },
): void {
  const query = sanitizeTitleForQuery(opts.title);
  const negKey = hashQuery(query, query);
  db.prepare(
    `INSERT INTO dream_research_cache(cache_key, provider, project_id, url, query_hash, markdown, fetched_at, expires_at, is_negative)
     VALUES(?, 'firecrawl', ?, ?, ?, 'cached text', ?, ?, ?)`,
  ).run(
    negKey,
    opts.project_id,
    query,
    negKey,
    Date.now() - 1000,
    opts.expiresAt,
    opts.isNegative ?? 1,
  );
}

function insertLink(
  db: Database,
  opts: { src_id: string; dst_id: string; link_type: string; weight: number },
): void {
  ensureSeedCycle(db);
  db.prepare(
    `INSERT OR IGNORE INTO memory_links(link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle)
     VALUES(?, ?, ?, ?, ?, ?, 'seed-cycle')`,
  ).run(crypto.randomUUID(), opts.src_id, opts.dst_id, opts.link_type, opts.weight, Date.now());
}

function seedP4QueueAtMax(db: Database, max: number): void {
  ensureSeedCycle(db);
  const stmt = db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, 'seed-cycle', 'P4', 'resolve_contradiction', 0.5, 'queued', ?, '{}')`,
  );
  db.run("BEGIN");
  for (let i = 0; i < max; i++) {
    stmt.run(crypto.randomUUID(), JSON.stringify([`mem-seed-${String(i)}`]));
  }
  db.run("COMMIT");
}

function seedExpiredP4Action(db: Database, opts: { expires_at: number }): void {
  ensureSeedCycle(db);
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, expires_at)
     VALUES(?, 'seed-cycle', 'P4', 'resolve_contradiction', 0.5, 'queued', '["mem-expired"]', '{}', ?)`,
  ).run(crypto.randomUUID(), opts.expires_at);
}

// ── P1 auto-promote ────────────────────────────────────────────────────────

it("P1 auto-promotes when judge consensus >= ceil(2/3)", async () => {
  const db = openTestDb();
  seedUnpromotedRollup(db, {
    body: "well-known finding with durable reasoning about dispatch policy and memory shaping.",
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.9 },
    { promote: true, confidence: 0.85 },
    { promote: false, confidence: 0.4 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool, onReembed: testP1Embed });
  const action = db
    .prepare(`SELECT status FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`)
    .get() as { status: string } | null;
  expect(action?.status).toBe("auto_applied");
});

it("P1 auto-promote inserts t2 memory + vector and uses buildT2EmbedText input", async () => {
  const db = openTestDb();
  const body =
    "Auto-promotion should embed the canonical recipe text and persist a vector in the same write path.";
  seedUnpromotedRollup(db, { body, projectId: "proj_embed" });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
  const prevRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
  const prevModelVersion = process.env.PENUMBRA_EMBEDDING_MODEL_VERSION;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "body_v1";
  process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = "embed-model-v2";
  const seen: { memory_id: string; text: string }[] = [];
  const promotedCountDuringEmbed: number[] = [];

  try {
    await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
      judgePool: pool,
      onReembed: (memory_id, text) => {
        const promotedCount = (
          db.prepare(`SELECT COUNT(*) AS c FROM t2_memories WHERE kind='promoted'`).get() as {
            c: number;
          }
        ).c;
        promotedCountDuringEmbed.push(promotedCount);
        seen.push({ memory_id, text });
        return Promise.resolve(new Float32Array([0.25, 0.5, 0.75]));
      },
    });
  } finally {
    if (prevRecipe === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prevRecipe;
    if (prevModelVersion === undefined) delete process.env.PENUMBRA_EMBEDDING_MODEL_VERSION;
    else process.env.PENUMBRA_EMBEDDING_MODEL_VERSION = prevModelVersion;
  }

  const promoted = db
    .prepare(
      `SELECT rowid, memory_id, title, body, embedding_model_version
       FROM t2_memories
       WHERE kind='promoted'
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get() as {
    rowid: number;
    memory_id: string;
    title: string;
    body: string;
    embedding_model_version: string | null;
  } | null;
  expect(promoted).toBeTruthy();
  expect(promoted?.embedding_model_version).toBe("embed-model-v2");
  expect(seen).toHaveLength(1);
  expect(promotedCountDuringEmbed).toEqual([0]);
  expect(seen[0]?.memory_id).toBe(promoted?.memory_id);
  expect(seen[0]?.text).toBe(buildT2EmbedText(promoted!.title, promoted!.body));

  const vecRow = db
    .prepare(`SELECT embedding FROM t2_vec WHERE rowid = ?`)
    .get(promoted?.rowid) as { embedding: Uint8Array } | null;
  expect(vecRow).toBeTruthy();
});

it("P1 embed failure rolls back candidate promotion and continues to next rollup", async () => {
  const db = openTestDb();
  const failingBody =
    "This candidate should fail embedding and must not get promoted despite auto-promote consensus.";
  const succeedingBody =
    "This second candidate should still promote after the first candidate fails embedding mid-cycle.";
  const failingRollupId = seedUnpromotedRollup(db, { body: failingBody, projectId: "proj_fail" });
  const succeedingRollupId = seedUnpromotedRollup(db, {
    body: succeedingBody,
    projectId: "proj_pass",
  });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
  const prevRecipe = process.env.PENUMBRA_T2_EMBED_RECIPE;
  process.env.PENUMBRA_T2_EMBED_RECIPE = "body_v1";
  let embedCalls = 0;

  try {
    await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
      judgePool: pool,
      onReembed: (_memory_id, text) => {
        embedCalls += 1;
        if (
          text === buildT2EmbedText(`P1 auto-promote: ${failingBody.slice(0, 80)}`, failingBody)
        ) {
          return Promise.reject(new Error("embed exploded"));
        }
        return Promise.resolve(new Float32Array([1, 2, 3]));
      },
    });
  } finally {
    if (prevRecipe === undefined) delete process.env.PENUMBRA_T2_EMBED_RECIPE;
    else process.env.PENUMBRA_T2_EMBED_RECIPE = prevRecipe;
  }

  expect(embedCalls).toBeGreaterThanOrEqual(2);
  const promotedCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM t2_memories WHERE kind='promoted'`).get() as { c: number }
  ).c;
  expect(promotedCount).toBe(1);
  const failedPromoted = db
    .prepare(`SELECT 1 AS ok FROM t2_memories WHERE kind='promoted' AND body = ? LIMIT 1`)
    .get(failingBody) as { ok: number } | null;
  expect(failedPromoted).toBeNull();
  const successPromoted = db
    .prepare(`SELECT rowid FROM t2_memories WHERE kind='promoted' AND body = ? LIMIT 1`)
    .get(succeedingBody) as { rowid: number } | null;
  expect(successPromoted).toBeTruthy();
  const successVec = db
    .prepare(`SELECT 1 AS ok FROM t2_vec WHERE rowid = ? LIMIT 1`)
    .get(successPromoted?.rowid) as { ok: number } | null;
  expect(successVec?.ok).toBe(1);

  const failedRollupRow = db
    .prepare(`SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = ?`)
    .get(failingRollupId) as { t2_promoted_at: string | null } | null;
  const succeededRollupRow = db
    .prepare(`SELECT t2_promoted_at FROM t1_rollups WHERE rollup_id = ?`)
    .get(succeedingRollupId) as { t2_promoted_at: string | null } | null;
  expect(failedRollupRow?.t2_promoted_at).toBeNull();
  expect(succeededRollupRow?.t2_promoted_at).toBeTruthy();
});

it("P1 skips rollups whose first_prompt_excerpt is a long-lived standing prompt", async () => {
  const db = openTestDb();
  const normalRollupId = seedUnpromotedRollup(db, {
    body: "normal user prompt about Postgres migration rollout sequencing and query planning.",
  });
  const longLivedRollupId = seedUnpromotedRollup(db, {
    body: "ignored prompt",
    firstPromptExcerpt:
      "You are home-mgmt, a long-lived agent with persistent state. Standing brief: check house health and dispatch critical issues.",
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  const cycleId = await runDreamCycle(db, testConfig(), {
    judgePool: pool,
    onReembed: testP1Embed,
  });
  const claimedRollups = getClaimedRollups(db, cycleId);
  expect(claimedRollups).toContain(normalRollupId);
  expect(claimedRollups).not.toContain(longLivedRollupId);
  const longLivedRow = db
    .prepare(`SELECT claimed_by_cycle FROM t1_rollups WHERE rollup_id=?`)
    .get(longLivedRollupId) as {
    claimed_by_cycle: string | null;
  } | null;
  expect(longLivedRow?.claimed_by_cycle).toBeNull();
  const p1Actions = db
    .prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`,
    )
    .get() as { n: number };
  expect(p1Actions.n).toBe(1);
});

it("P1 skips dispatch-mode excerpts (Operating rules / IMPLEMENTER MODE)", async () => {
  const db = openTestDb();
  seedUnpromotedRollup(db, {
    body: "normal user prompt about deployment",
    firstPromptExcerpt:
      "# Operating rules\nIMPLEMENTER MODE\nThis is a session-specific dispatch command",
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool, onReembed: testP1Embed });
  const p1Actions = db
    .prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`,
    )
    .get() as { n: number };
  expect(p1Actions.n).toBe(0);
});

it("P1 skips Fix:-prefixed excerpts", async () => {
  const db = openTestDb();
  seedUnpromotedRollup(db, {
    body: "normal user prompt about deployment",
    firstPromptExcerpt: "Fix: task was completed and closed by the release pipeline.",
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool, onReembed: testP1Embed });
  const p1Actions = db
    .prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`,
    )
    .get() as { n: number };
  expect(p1Actions.n).toBe(0);
});

it("P1 skips NULL and short first_prompt_excerpt rollups (no UUID fallback)", async () => {
  const db = openTestDb();
  const nullRollupId = seedUnpromotedRollup(db, {
    body: "normal user prompt with no excerpt",
    firstPromptExcerpt: null,
  });
  const shortRollupId = seedUnpromotedRollup(db, {
    body: "normal user prompt with no excerpt",
    firstPromptExcerpt: "short",
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  const cycleId = await runDreamCycle(db, testConfig(), {
    judgePool: pool,
    onReembed: testP1Embed,
  });
  const claimedRollups = getClaimedRollups(db, cycleId);
  expect(claimedRollups).toContain(nullRollupId);
  expect(claimedRollups).toContain(shortRollupId);
  const p1Actions = db
    .prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' AND cycle_id=?`,
    )
    .get(cycleId) as { n: number };
  expect(p1Actions.n).toBe(0);
});

it("P1 queues queued auto-promote when title already exists in active t2 memory", async () => {
  const db = openTestDb();
  const body = "Design decision: prefer async-first handlers for all workflow dispatch code paths.";
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const existingMemoryId = seedMemory(db, { body: "legacy body", projectId: "proj-a" });
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id=?`).run(
    existingTitle,
    existingMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: "proj-a" });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });
  const action = db
    .prepare(
      `SELECT status, payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { status: string; payload_json: string } | null;
  expect(action?.status).toBe("queued");
  const payload = JSON.parse(action?.payload_json ?? "{}") as { dedup_against?: string };
  expect(payload.dedup_against).toBe(existingMemoryId);
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(1);
  expect(payload.project_id).toBe("proj-a");
});

it("P1 queues queued auto-promote when body already exists in active t2 memory", async () => {
  const db = openTestDb();
  const body =
    "Feature flag naming conventions should always include the service suffix to avoid collisions.";
  const existingMemoryId = seedMemory(db, { body, projectId: "proj-a" });
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id=?`).run(
    existingTitle,
    existingMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: "proj-a" });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });
  const action = db
    .prepare(
      `SELECT status, payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { status: string; payload_json: string } | null;
  expect(action?.status).toBe("queued");
  const payload = JSON.parse(action?.payload_json ?? "{}") as { dedup_against?: string };
  expect(payload.dedup_against).toBe(existingMemoryId);
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(1);
});

it("P1 deduplicates against the same project_id and leaves a dedup proof in payload", async () => {
  const db = openTestDb();
  const body =
    "Cross-project duplicate test prompt that should dedup only within the same project scope.";
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const existingMemoryId = seedMemory(db, { body: "legacy memory", projectId: "proj_a" });
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id=?`).run(
    existingTitle,
    existingMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: "proj_a" });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { payload_json: string } | null;
  const payload = JSON.parse(action?.payload_json ?? "{}") as {
    dedup_against?: string;
    project_id?: string | null;
  };
  expect(payload.dedup_against).toBe(existingMemoryId);
  expect(payload.project_id).toBe("proj_a");
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(1);
});

it("P1 does not deduplicate across different project_id scopes", async () => {
  const db = openTestDb();
  const body =
    "Cross-project duplicate test prompt that should mint a second copy for different project.";
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const existingMemoryId = seedMemory(db, { body: "legacy memory", projectId: "proj_a" });
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id=?`).run(
    existingTitle,
    existingMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: "proj_b" });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);

  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const action = db
    .prepare(
      `SELECT status FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { status: string } | null;
  expect(action?.status).toBe("auto_applied");
  const minted = db
    .prepare(`SELECT project_id FROM t2_memories WHERE kind='promoted' ORDER BY rowid DESC LIMIT 1`)
    .get() as { project_id: string | null };
  expect(minted.project_id).toBe("proj_b");
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(2);
});

it("P1 with NULL project_id dedups only against NULL-scoped t2 memory", async () => {
  const db = openTestDb();
  const body = "Null project_id memory should only match another null project_id memory.";
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const nullProjectMemoryId = seedMemory(db, { body: "legacy", projectId: null });
  const otherProjectMemoryId = seedMemory(db, { body: "legacy", projectId: "proj_a" });
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id IN (?, ?)`).run(
    existingTitle,
    nullProjectMemoryId,
    otherProjectMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: null });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);

  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { payload_json: string } | null;
  const payload = JSON.parse(action?.payload_json ?? "{}") as { dedup_against?: string };
  expect(payload.dedup_against).toBe(nullProjectMemoryId);
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(2);
  expect(otherProjectMemoryId).toBeTruthy();
});

it("P1 minted t2 row carries project_id from the source rollup", async () => {
  const db = openTestDb();
  const body =
    "Auto-promoted memory should carry project_id so scoped readers can resolve ownership.";
  seedUnpromotedRollup(db, { body, projectId: "proj_x" });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);

  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const row = db
    .prepare(`SELECT project_id FROM t2_memories WHERE kind='promoted' ORDER BY rowid DESC LIMIT 1`)
    .get() as { project_id: string | null } | null;
  expect(row?.project_id).toBe("proj_x");
});

it("P1 only dedups within the same project_id scope", async () => {
  const db = openTestDb();
  const body =
    "Cross-project memory text for dedupe behavior is intentionally duplicated text prefix.";
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const existingMemoryId = seedMemory(db, { body });
  db.prepare(`UPDATE t2_memories SET title=?, project_id=? WHERE memory_id=?`).run(
    existingTitle,
    "proj_a",
    existingMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: "proj_b" });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);

  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const minted = db
    .prepare(`SELECT project_id FROM t2_memories WHERE kind='promoted' ORDER BY rowid DESC LIMIT 1`)
    .get() as { project_id: string | null };
  expect(minted.project_id).toBe("proj_b");
  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { payload_json: string } | null;
  const payload = JSON.parse(action?.payload_json ?? "{}") as { dedup_against?: string };
  expect(payload.dedup_against).toBeUndefined();
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(2);
});

it("P1 matches NULL project_id rows only against NULL rows", async () => {
  const db = openTestDb();
  const body = "Null-project-id memory should only match another null project scoped memory.";
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const nullProjectMemoryId = seedMemory(db, { body });
  const nonNullProjectMemoryId = db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, project_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', 'proj_a', 'feedback', ?, ?, ?, ?, ?, ?)`,
  );
  const memoryId2 = crypto.randomUUID();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, project_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', 'proj_a', 'feedback', ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(memoryId2, now, now, existingTitle, body, now, now);
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id IN (?, ?)`).run(
    existingTitle,
    nullProjectMemoryId,
    memoryId2,
  );
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id=?`).run(
    existingTitle,
    nullProjectMemoryId,
  );
  seedUnpromotedRollup(db, { body, projectId: null });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { payload_json: string } | null;
  const payload = JSON.parse(action?.payload_json ?? "{}") as { dedup_against?: string };
  expect(payload.dedup_against).toBe(nullProjectMemoryId);
  const t2Count = (db.prepare("SELECT COUNT(*) as n FROM t2_memories").get() as { n: number }).n;
  expect(t2Count).toBe(2);
  expect(nonNullProjectMemoryId).toBeTruthy();
});

it("P1 minted t2 memory includes project_id from rollup", async () => {
  const db = openTestDb();
  const body =
    "Auto-promoted memory should persist originating rollup project_id for reader scoping.";
  seedUnpromotedRollup(db, { body, projectId: "proj_x" });
  const pool = makeFakeJudgePool([{ promote: true, confidence: 1 }]);
  await runDreamCycle(db, testConfig({ autoPromoteMinJudges: 1 }), {
    judgePool: pool,
    onReembed: testP1Embed,
  });

  const row = db
    .prepare(`SELECT project_id FROM t2_memories WHERE kind='promoted' ORDER BY rowid DESC LIMIT 1`)
    .get() as { project_id: string | null } | null;
  expect(row?.project_id).toBe("proj_x");
});

// ── P3 quality signal ──────────────────────────────────────────────────────

it("P3 rewrite: never auto-applied, always queued regardless of confidence", async () => {
  const db = openTestDb();
  seedMemory(db, { body: "vague memory that needs rewriting" });
  const scorer = {
    score: (): Promise<{
      verdict: "retire" | "rewrite" | "keep";
      composite: number;
      should_auto_retire: boolean;
    }> =>
      Promise.resolve({ verdict: "rewrite" as const, composite: 0.95, should_auto_retire: false }),
  };
  await runDreamCycle(db, testConfig(), { scorer });
  const action = db
    .prepare(`SELECT status FROM dream_actions WHERE action_type='rewrite'`)
    .get() as { status: string } | null;
  expect(action?.status).toBe("queued");
});

it("P3 auto-retire skips direct-origin memories but retires non-direct memories", async () => {
  const db = openTestDb();
  const directId = seedMemory(db, { body: "direct source memory" });
  const nonDirectId = seedMemory(db, { body: "non-direct source memory" });
  db.prepare(`UPDATE t2_memories SET origin = 'direct' WHERE memory_id = ?`).run(directId);

  await runDreamCycle(db, testConfig(), {
    scorer: {
      score: ({ memory_id }: { memory_id: string }) =>
        Promise.resolve({
          verdict: memory_id === directId ? ("keep" as const) : ("retire" as const),
          composite: 0.99,
          should_auto_retire: true,
        }),
    },
  });

  const directRow = db
    .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
    .get(directId) as { retired_at: number | null };
  const nonDirectRow = db
    .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id = ?`)
    .get(nonDirectId) as { retired_at: number | null };

  const directAction = db
    .prepare(
      `SELECT status FROM dream_actions WHERE action_type='retire' AND target_ids=? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(JSON.stringify([directId])) as { status: string } | null;
  const nonDirectAction = db
    .prepare(
      `SELECT status FROM dream_actions WHERE action_type='retire' AND target_ids=? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(JSON.stringify([nonDirectId])) as { status: string } | null;

  expect(directRow.retired_at).toBeNull();
  expect(nonDirectRow.retired_at).not.toBeNull();
  expect(directAction?.status).toBe("skipped_direct_origin");
  expect(nonDirectAction?.status).toBe("auto_applied");
});

// ── P4 bounded discovery queue ─────────────────────────────────────────────

it("P4 queues bounded: evicts oldest-expired when queue hits P4_QUEUE_MAX", async () => {
  const db = openTestDb();
  seedP4QueueAtMax(db, 1000);
  seedExpiredP4Action(db, { expires_at: 1 });
  await runDreamCycle(db, testConfig({ p4QueueMax: 1000 }));
  const count = db
    .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`)
    .get() as { n: number };
  expect(count.n).toBeLessThanOrEqual(1000);
});

it("P4 contradiction actions deduplicated by (action_type, target_ids)", async () => {
  const db = openTestDb();
  const m1 = seedMemory(db, { body: "X is always true" });
  const m2 = seedMemory(db, { body: "X is never true" });
  insertLink(db, { src_id: m1, dst_id: m2, link_type: "contradicts", weight: 0.95 });
  await runDreamCycle(db, testConfig());
  await runDreamCycle(db, testConfig()); // second cycle; same contradiction
  const count = db
    .prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE action_type='resolve_contradiction' AND status='queued'`,
    )
    .get() as { n: number };
  expect(count.n).toBe(1);
});

// ── P4 research_query seeding ──────────────────────────────────────────────

function seedT2MemoryWithProjectId(
  db: Database,
  opts: { project_id: string; title: string; body?: string },
): string {
  const memId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
     VALUES(?, 'test-user', 'knowledge', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(memId, now, now, opts.title, opts.body ?? "body", now, now, opts.project_id);
  return memId;
}

function getT2UpdatedAtMs(db: Database, memoryId: string): number {
  const row = db.prepare(`SELECT updated_at FROM t2_memories WHERE memory_id=?`).get(memoryId) as {
    updated_at: string;
  } | null;
  return row ? Date.parse(row.updated_at) : NaN;
}

type TestProject = {
  project_id: string;
  dreaming?: { research_provider?: string; allowed_domains?: string[] };
};
function makeProjectRegistry(projects: TestProject[]): {
  get: (id: string) => TestProject | null;
  list: () => TestProject[];
} {
  return {
    get: (id: string): TestProject | null => projects.find((p) => p.project_id === id) ?? null,
    list: (): TestProject[] => projects,
  };
}

it("P4 seeds research_query actions for projects with research_provider != off", async () => {
  const db = openTestDb();
  const projectId = "proj-firecrawl";
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "important topic for reliable recall",
  });
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "production rollout checks for queue health",
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const actions = db
    .prepare(
      `SELECT target_ids, payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .all() as { target_ids: string; payload_json: string }[];
  expect(actions.length).toBeGreaterThanOrEqual(1);
  expect(actions.length).toBeLessThanOrEqual(2);
  for (const a of actions) {
    expect(JSON.parse(a.target_ids)).toEqual([projectId]);
    expect((JSON.parse(a.payload_json) as { query: string }).query).toBeTruthy();
  }
});

it("P4 rotates research_query candidates across cycles instead of repeating the newest two", async () => {
  const db = openTestDb();
  const projectId = "proj-rotation";
  for (const title of [
    "Qwen3 8 27B benchmark routing comparison",
    "Codex ACP timeout recovery behavior",
    "Gemini flash dispatch reliability analysis",
    "OpenAI compatible gateway cache policy",
    "Local memory recall ranking calibration",
  ]) {
    seedT2MemoryWithProjectId(db, { project_id: projectId, title });
  }
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);

  await runDreamCycle(db, testConfig(), { projectRegistry });
  await runDreamCycle(db, testConfig(), { projectRegistry });

  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT json_extract(payload_json, '$.source_memory_id')) AS n
       FROM dream_actions
       WHERE phase='P4' AND action_type='research_query'`,
    )
    .get() as { n: number };
  expect(row.n).toBeGreaterThanOrEqual(3);
});

it("P4 skips research_query for projects with research_provider=off or no dreaming config", async () => {
  const db = openTestDb();
  seedT2MemoryWithProjectId(db, { project_id: "proj-off", title: "some topic" });
  seedT2MemoryWithProjectId(db, { project_id: "proj-none", title: "some topic" });
  const projectRegistry = makeProjectRegistry([
    { project_id: "proj-off", dreaming: { research_provider: "off" } },
    { project_id: "proj-none" },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE action_type='research_query'`)
      .get() as { n: number }
  ).n;
  expect(count).toBe(0);
});

it("P4 skips research_query seeding when t2 title looks like a URL", async () => {
  const db = openTestDb();
  const projectId = "proj-url";
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: "https://attacker.com/exfil" });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(0);
});

it("P4 skips research_query seeding when negative cache sentinel is fresh", async () => {
  const db = openTestDb();
  const projectId = "proj-negative-hit";
  const now = Date.now();
  const titles = ["Concurrent boot flow assertions", "Parallel boot actions across all workers"];
  for (const title of titles) {
    seedT2MemoryWithProjectId(db, { project_id: projectId, title });
    seedNegativeResearchCache(db, { project_id: projectId, title, expiresAt: now + 3600000 });
  }
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(0);
});

it("P4 inserts research_query when negative cache sentinel is expired", async () => {
  const db = openTestDb();
  const projectId = "proj-negative-miss";
  const now = Date.now();
  const titles = ["Concurrent boot flow assertions", "Parallel boot actions across all workers"];
  for (const title of titles) {
    seedT2MemoryWithProjectId(db, { project_id: projectId, title });
    seedNegativeResearchCache(db, { project_id: projectId, title, expiresAt: now - 3600000 });
  }
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(2);
});

it("P4 inserts research_query when no negative cache sentinel exists", async () => {
  const db = openTestDb();
  const projectId = "proj-no-sentinel";
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "Concurrent boot flow assertions",
  });
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "Parallel boot actions across all workers",
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(2);
});

it("P4 query gate rejects unsearchable memory titles before minting research_query", async () => {
  const db = openTestDb();
  const projectId = "proj-gate-reject";
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "feat(daemon-workers): phase 5 supervisor",
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);

  await runDreamCycle(db, testConfig(), { projectRegistry });

  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

it("P4 query gate allows valid memory titles and mints research_query", async () => {
  const db = openTestDb();
  const projectId = "proj-gate-accept";
  const title = "TypeScript strict null checks";
  seedT2MemoryWithProjectId(db, { project_id: projectId, title });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);

  await runDreamCycle(db, testConfig(), { projectRegistry });

  const actions = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .all() as { payload_json: string }[];
  expect(actions.length).toBe(1);
  expect((JSON.parse(actions[0]!.payload_json) as { query: string }).query).toBe(title);
});

it("P4 query gate can be disabled via env var for backward compatibility", async () => {
  const oldValue = process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED;
  process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED = "0";
  try {
    const db = openTestDb();
    const projectId = "proj-gate-disabled";
    seedT2MemoryWithProjectId(db, {
      project_id: projectId,
      title: "feat(daemon-workers): phase 5 supervisor",
    });
    const projectRegistry = makeProjectRegistry([
      { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
    ]);

    await runDreamCycle(db, testConfig(), { projectRegistry });

    const count = (
      db
        .prepare(
          `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  } finally {
    if (oldValue === undefined) {
      delete process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED;
    } else {
      process.env.PENUMBRA_DREAMING_QUERY_GATE_ENABLED = oldValue;
    }
  }
});

it("P4 query gate logs structured rejection with title_hash", async () => {
  const db = openTestDb();
  const projectId = "proj-gate-log";
  const gateTitle = "feat(daemon-workers): phase 5 supervisor";
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: gateTitle,
  });
  const events: { kind: string; meta: unknown }[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig({ rewriterEnabled: false }), {
    projectRegistry,
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
  });

  const event = events.find((entry) => entry.kind === "dream_p4_query_rejected_unsearchable");
  expect(event).toBeDefined();
  expect(JSON.stringify(event?.meta ?? {})).not.toContain(gateTitle);
});

it("P4 uses cached rewriter skip verdict and does not call llmInvoke", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-cache-skip";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "How to keep this stable under high load",
  });
  const memoryUpdatedAtMs = getT2UpdatedAtMs(db, memoryId);
  setRewriteForMemory({
    db,
    t2_memory_id: memoryId,
    memory_updated_at_ms: memoryUpdatedAtMs,
    verdict: { kind: "skip", reason: "too-internal" },
    model: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    now_ms: Date.now(),
  });

  const llmCalls: number[] = [];
  const events: { kind: string; meta: unknown }[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    llmInvoke: () => {
      llmCalls.push(1);
      return Promise.resolve({
        ok: false as const,
        reason: "http_error",
        failureMessage: "should not happen",
      });
    },
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
  });

  expect(llmCalls.length).toBe(0);
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(0);

  const event = events.find((entry) => entry.kind === "dream_p4_query_skipped");
  expect(event?.kind).toBe("dream_p4_query_skipped");
  expect(event?.meta).toMatchObject({
    t2_memory_id: memoryId,
    cache_hit: true,
  });
});

it("P4 uses cached rewriter query verdict when available", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-cache-query";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "How to keep this stable under high load",
  });
  const memoryUpdatedAtMs = getT2UpdatedAtMs(db, memoryId);
  setRewriteForMemory({
    db,
    t2_memory_id: memoryId,
    memory_updated_at_ms: memoryUpdatedAtMs,
    verdict: { kind: "query", query: "searchable rewritten stability query" },
    model: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    now_ms: Date.now(),
  });

  const llmCalls: number[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    llmInvoke: () => {
      llmCalls.push(1);
      return Promise.resolve({
        ok: true as const,
        value: { kind: "query", query: "should-not-be-used" },
        raw: '{"kind":"query","query":"should-not-be-used"}',
      });
    },
  });

  expect(llmCalls.length).toBe(0);
  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .get() as { payload_json: string } | null;
  expect(action).not.toBeNull();
  expect((JSON.parse(action!.payload_json) as { query: string }).query).toBe(
    "searchable rewritten stability query",
  );
});

it("P4 writes cache on rewriter fresh skip and skips action minting", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-fresh-skip";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "A stable architecture question with human language",
  });
  const memoryUpdatedAtMs = getT2UpdatedAtMs(db, memoryId);
  const events: { kind: string; meta: unknown }[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
    llmInvoke: () =>
      Promise.resolve({
        ok: true as const,
        value: { kind: "skip", reason: "too-internal" },
        raw: '{"kind":"skip","reason":"too-internal"}',
      }),
  });

  const actionCount = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(actionCount).toBe(0);

  const event = events.find((entry) => entry.kind === "dream_p4_query_skipped");
  expect(event?.kind).toBe("dream_p4_query_skipped");
  expect(event?.meta).toMatchObject({
    cache_hit: false,
    t2_memory_id: memoryId,
  });

  const row = db
    .prepare(`SELECT verdict_kind, reason FROM dream_query_rewrites WHERE t2_memory_id=?`)
    .get(memoryId) as { verdict_kind: string; reason: string } | null;
  expect(row).not.toBeNull();
  expect(row?.verdict_kind).toBe("skip");
  expect(row?.reason).toBe("too-internal");
  expect(memoryUpdatedAtMs).toBeGreaterThan(0);
});

it("P4 writes cache on rewriter fresh query and mints action with rewritten query", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-fresh-query";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "A stable architecture question with human language",
  });
  const events: { kind: string; meta: unknown }[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
    llmInvoke: () =>
      Promise.resolve({
        ok: true as const,
        value: { kind: "query", query: "something searchable and useful query terms" },
        raw: '{"kind":"query","query":"something searchable and useful query terms"}',
      }),
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .get() as { payload_json: string } | null;
  expect(action).not.toBeNull();
  expect((JSON.parse(action!.payload_json) as { query: string }).query).toBe(
    "something searchable and useful query terms",
  );

  const event = events.find((entry) => entry.kind === "dream_p4_query_rewritten");
  expect(event?.kind).toBe("dream_p4_query_rewritten");
  expect(event?.meta).toMatchObject({
    cache_hit: false,
    t2_memory_id: memoryId,
  });

  const cacheRow = db
    .prepare(`SELECT query FROM dream_query_rewrites WHERE t2_memory_id=?`)
    .get(memoryId) as {
    query: string;
  } | null;
  expect(cacheRow?.query).toBe("something searchable and useful query terms");
});

it("P4 wires the subscription HTTP rung and records the fallback candidate that served", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-cloud-fallback";
  seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "A stable architecture question with human language",
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  let invokeInput: Record<string, unknown> | undefined;

  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    rewriterCandidates: [
      {
        name: "local-rewriter",
        baseUrl: "http://127.0.0.1:7944/v1",
        model: "local-rewriter",
        provider: "local",
        auth: { source: "none" },
      },
      {
        name: "sakana-rewriter",
        baseUrl: "https://api.sakana.ai/v1",
        model: "sakana-rewriter",
        provider: "sakana",
        auth: { source: "bearer", token: "test-sakana-token" },
      },
    ],
    llmInvoke: (input) => {
      invokeInput = input as unknown as Record<string, unknown>;
      return Promise.resolve({
        ok: true as const,
        value: { kind: "query" as const, query: "something searchable and useful query terms" },
        raw: '{"kind":"query","query":"something searchable and useful query terms"}',
        candidate: {
          name: "sakana-rewriter",
          baseUrl: "https://api.sakana.ai/v1",
          model: "sakana-rewriter",
          provider: "sakana" as const,
          authSource: "bearer" as const,
          tier: "fallback" as const,
        },
      });
    },
  });

  expect(invokeInput?.fallbackCandidates).toEqual([
    {
      name: "sakana-rewriter",
      baseUrl: "https://api.sakana.ai/v1",
      model: "sakana-rewriter",
      provider: "sakana",
      auth: { source: "bearer", token: "test-sakana-token" },
    },
  ]);
  expect(invokeInput?.activeBiases).toEqual([]);
  const health = db
    .query<{ tier: string; seat: string; model: string; host: string }, []>(
      `SELECT tier, seat, model, host
       FROM subsystem_health
       WHERE subsystem = 'dream.query_rewrite'`,
    )
    .get();
  expect(health).toEqual({
    tier: "fallback",
    seat: "sakana-rewriter",
    model: "sakana-rewriter",
    host: "api.sakana.ai",
  });
});

it("P4 falls back to title when rewriter fails and does not cache on failure", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-failure-fallback";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "TypeScript strict null checks in async systems",
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  const events: { kind: string; meta: unknown }[] = [];
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
    llmInvoke: () =>
      Promise.resolve({
        ok: false as const,
        reason: "http_error",
        status: 503,
        failureMessage: "provider unavailable",
      }),
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .get() as { payload_json: string } | null;
  expect(action).not.toBeNull();
  expect((JSON.parse(action!.payload_json) as { query: string }).query).toBe(
    "TypeScript strict null checks in async systems",
  );

  const cacheRow = db
    .prepare(`SELECT COUNT(*) as n FROM dream_query_rewrites WHERE t2_memory_id=?`)
    .get(memoryId) as {
    n: number;
  };
  expect(cacheRow.n).toBe(0);
  const failureEvent = events.find((entry) => entry.kind === "dream_p4_query_rewrite_failed");
  expect(failureEvent).toBeDefined();
  expect(failureEvent?.meta).toMatchObject({ reason: "http_error", status: 503 });
  const healthRow = db
    .query<
      {
        tier: string;
        consecutive_failures: number;
        last_failure_reason: string;
        last_failure_status: number;
      },
      []
    >(
      `SELECT tier, consecutive_failures, last_failure_reason, last_failure_status
       FROM subsystem_health
       WHERE subsystem = 'dream.query_rewrite'`,
    )
    .get();
  expect(healthRow).toEqual({
    tier: "fallback",
    consecutive_failures: 1,
    last_failure_reason: "http_error",
    last_failure_status: 503,
  });
  expect(events.some((entry) => entry.kind === "dream_p4_query_skipped")).toBe(false);
});

it("P4 falls back to title when the rewriter returns an empty response", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-empty-response-fallback";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "TypeScript strict null checks in async systems",
  });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  const events: { kind: string; meta: unknown }[] = [];
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
    llmInvoke: () =>
      Promise.resolve({
        ok: false as const,
        reason: "empty_response" as const,
        failureMessage: "no response content",
      }),
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .get() as { payload_json: string } | null;
  expect(action).not.toBeNull();
  expect((JSON.parse(action!.payload_json) as { query: string }).query).toBe(
    "TypeScript strict null checks in async systems",
  );

  const cacheCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dream_query_rewrites WHERE t2_memory_id=?`)
      .get(memoryId) as { n: number }
  ).n;
  expect(cacheCount).toBe(0);
  expect(events.some((entry) => entry.kind === "dream_p4_query_rewrite_failed")).toBe(true);
});

it("P4 rewritten query rejected by guard is tracked as unsearchable content, not seat failure", async () => {
  const db = openTestDb();
  const projectId = "proj-rewriter-defense";
  const memoryId = seedT2MemoryWithProjectId(db, {
    project_id: projectId,
    title: "TypeScript strict null checks in async systems",
  });
  const events: { kind: string; meta: unknown }[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig({ rewriterEnabled: true }), {
    projectRegistry,
    dispatchEventLog: {
      record(event) {
        events.push(event);
      },
    },
    llmInvoke: () =>
      Promise.resolve({
        ok: true as const,
        value: { kind: "query", query: "parseUpdatedAtMs stable input handling behavior" },
        raw: '{"kind":"query","query":"parseUpdatedAtMs stable input handling behavior"}',
      }),
  });

  const action = db
    .prepare(
      `SELECT payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    )
    .get() as { payload_json: string } | null;
  expect(action).not.toBeNull();
  expect((JSON.parse(action!.payload_json) as { query: string }).query).toBe(
    "TypeScript strict null checks in async systems",
  );

  const cacheCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dream_query_rewrites WHERE t2_memory_id=?`)
      .get(memoryId) as { n: number }
  ).n;
  expect(cacheCount).toBe(0);

  const unsearchableEvents = events.filter(
    (entry) => entry.kind === "dream_p4_query_rejected_unsearchable",
  );
  expect(unsearchableEvents.length).toBe(1);
  expect(unsearchableEvents[0]?.meta).toMatchObject({
    t2_memory_id: memoryId,
    stage: "post_rewrite",
    cache_hit: false,
    model: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    seat: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
    host: "127.0.0.1",
    reason: "code_identifier",
  });
  expect(typeof (unsearchableEvents[0]?.meta as { latency_ms?: unknown })?.latency_ms).toBe(
    "number",
  );

  const rewriteFailedEvents = events.filter(
    (entry) => entry.kind === "dream_p4_query_rewrite_failed",
  );
  expect(rewriteFailedEvents.length).toBe(0);
  const skippedEvents = events.filter((entry) => entry.kind === "dream_p4_query_skipped");
  expect(skippedEvents.length).toBe(0);
  const healthRow = db
    .query<{ consecutive_failures: number; last_failure_reason: string }, []>(
      `SELECT consecutive_failures, last_failure_reason
       FROM subsystem_health
       WHERE subsystem = 'dream.query_rewrite'`,
    )
    .get();
  expect(healthRow).toBeNull();
});

// ── P6 brief dedup ─────────────────────────────────────────────────────────

function seedProjectBrief(db: Database, opts: { project_id: string; generated_at: number }): void {
  ensureSeedCycle(db);
  db.prepare(
    `INSERT OR REPLACE INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle, t2_shadow_memory_id)
     VALUES(?, 'old brief', '[]', ?, 'seed-cycle', NULL)`,
  ).run(opts.project_id, opts.generated_at);
}

function seedProjectBriefMarkdown(
  db: Database,
  opts: { project_id: string; brief_md: string; generated_at: number },
): void {
  ensureSeedCycle(db);
  db.prepare(
    `INSERT OR REPLACE INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle, t2_shadow_memory_id)
     VALUES(?, ?, '[]', ?, 'seed-cycle', NULL)`,
  ).run(opts.project_id, opts.brief_md, opts.generated_at);
}

it("P6 skips brief generation when last brief is within refresh window", async () => {
  const db = openTestDb();
  const projectId = "proj-fresh";
  seedProjectBrief(db, { project_id: projectId, generated_at: Date.now() - 60 * 60 * 1000 }); // 1h ago
  const observeCalls: string[] = [];
  const memoryObserve = (
    _brief: string,
    pid: string,
    _cid: string,
  ): Promise<{ memory_id: string }> => {
    observeCalls.push(pid);
    return Promise.resolve({ memory_id: crypto.randomUUID() });
  };
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), {
    projectRegistry,
    memoryObserve,
  });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM project_briefs WHERE project_id=?`).get(projectId) as {
      n: number;
    }
  ).n;
  expect(count).toBe(1);
  expect(observeCalls).not.toContain(projectId);
});

function makeMemoryObserve(
  db: Database,
): (brief: string, pid: string, _cid: string) => Promise<{ memory_id: string }> {
  return (brief: string, pid: string, _cid: string): Promise<{ memory_id: string }> => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
       VALUES(?, 'system', 'brief', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(memId, now, now, `Brief: ${pid}`, brief, now, now, pid);
    return Promise.resolve({ memory_id: memId });
  };
}

function makeRecordingMemoryObserve(db: Database, observedBriefs: string[]) {
  return (brief: string, pid: string, _cid: string): Promise<{ memory_id: string }> => {
    observedBriefs.push(brief);
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
       VALUES(?, 'system', 'brief', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(memId, now, now, `Brief: ${pid}`, brief, now, now, pid);
    return Promise.resolve({ memory_id: memId });
  };
}

it("P6 uses briefSynthesizer when provided and stores its output", async () => {
  const db = openTestDb();
  const projectId = "penumbra";
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: "important finding" });
  const memoryObserve = makeMemoryObserve(db);
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  const briefSynthesizer = {
    synthesize: (): Promise<{ markdown: string; source_memory_ids: string[] }> =>
      Promise.resolve({ markdown: "real brief content", source_memory_ids: ["mA"] }),
  };
  await runDreamCycle(db, testConfig(), { projectRegistry, memoryObserve, briefSynthesizer });
  const row = db
    .prepare(`SELECT brief_md, source_memory_ids FROM project_briefs WHERE project_id=?`)
    .get(projectId) as { brief_md: string; source_memory_ids: string } | null;
  expect(row).not.toBeNull();
  expect(row!.brief_md).toBe("real brief content");
  expect(JSON.parse(row!.source_memory_ids)).toContain("mA");
});

it("P6 does not persist or observe a content-free brief when no briefSynthesizer is provided", async () => {
  const db = openTestDb();
  const projectId = "proj-stub";
  const observeCalls: string[] = [];
  const memoryObserve = makeRecordingMemoryObserve(db, observeCalls);
  const warnCalls: { fields: Record<string, unknown>; msg: string }[] = [];
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  await runDreamCycle(db, testConfig(), {
    projectRegistry,
    memoryObserve,
    log: {
      info: () => undefined,
      warn: (fields: Record<string, unknown>, msg: string) => warnCalls.push({ fields, msg }),
    } as unknown as Logger,
  });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM project_briefs WHERE project_id=?`).get(projectId) as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(observeCalls).toEqual([]);
  expect(warnCalls.some((call) => call.msg.includes("brief synthesizer dependency absent"))).toBe(
    true,
  );
});

it("P6 retries production-shaped content-free stub rows instead of treating them as fresh", async () => {
  const db = openTestDb();
  const projectIds = ["embersynth", "llamactl", "nova", "penumbra", "sirius"];
  const generatedAt = Date.now() - 60 * 60 * 1000;
  for (const projectId of projectIds) {
    seedProjectBriefMarkdown(db, {
      project_id: projectId,
      brief_md: `# Project Brief: ${projectId}\nGenerated by P6.`,
      generated_at: generatedAt,
    });
  }
  const projectRegistry = makeProjectRegistry(
    projectIds.map((project_id) => ({ project_id, dreaming: { research_provider: "off" } })),
  );
  const observedBriefs: string[] = [];
  const memoryObserve = makeRecordingMemoryObserve(db, observedBriefs);

  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), {
    projectRegistry,
    memoryObserve,
  });

  expect(observedBriefs).toEqual([]);
  const briefSynthesizer = {
    synthesize: (input: {
      project_id: string;
    }): Promise<{ markdown: string; source_memory_ids: string[] }> =>
      Promise.resolve({
        markdown: `# Project Brief: ${input.project_id}\nReal synthesized brief`,
        source_memory_ids: [],
      }),
  };

  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), {
    projectRegistry,
    memoryObserve,
    briefSynthesizer,
  });

  expect(observedBriefs.length).toBe(projectIds.length);
  for (const projectId of projectIds) {
    const row = db
      .prepare(`SELECT brief_md, generated_at FROM project_briefs WHERE project_id=?`)
      .get(projectId) as { brief_md: string; generated_at: number };
    expect(row.brief_md).toBe(`# Project Brief: ${projectId}\nReal synthesized brief`);
    expect(row.generated_at).toBeGreaterThan(generatedAt);
  }
});

it("P6 keeps successful briefs fresh enough to suppress the next cycle", async () => {
  const db = openTestDb();
  const projectId = "proj-real-fresh";
  const observedBriefs: string[] = [];
  const memoryObserve = makeRecordingMemoryObserve(db, observedBriefs);
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  let synthCalls = 0;
  const briefSynthesizer = {
    synthesize: (): Promise<{ markdown: string; source_memory_ids: string[] }> => {
      synthCalls += 1;
      return Promise.resolve({
        markdown: `real brief ${String(synthCalls)}`,
        source_memory_ids: [],
      });
    },
  };

  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), {
    projectRegistry,
    memoryObserve,
    briefSynthesizer,
  });
  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), {
    projectRegistry,
    memoryObserve,
    briefSynthesizer,
  });

  expect(synthCalls).toBe(1);
  expect(observedBriefs).toEqual(["real brief 1"]);
});

it("P6 does not persist or observe a stub when the briefSynthesizer throws", async () => {
  const db = openTestDb();
  const projectId = "proj-throw";
  const observeCalls: string[] = [];
  const memoryObserve = makeRecordingMemoryObserve(db, observeCalls);
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  const warnCalls: { fields: Record<string, unknown>; msg: string }[] = [];
  const log = {
    info: () => undefined,
    warn: (fields: Record<string, unknown>, msg: string) => warnCalls.push({ fields, msg }),
  } as unknown as Logger;
  const throwingSynthesizer = {
    synthesize: (): Promise<{ markdown: string; source_memory_ids: string[] }> =>
      Promise.reject(new Error("backend down")),
  };

  await runDreamCycle(db, testConfig(), {
    projectRegistry,
    memoryObserve,
    briefSynthesizer: throwingSynthesizer,
    log,
  });

  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM project_briefs WHERE project_id=?`).get(projectId) as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(observeCalls).toEqual([]);
  expect(warnCalls.some((call) => call.msg.includes("brief synthesizer failed"))).toBe(true);
  expect(warnCalls.some((call) => call.msg.includes("dependency absent"))).toBe(false);

  const recoveringSynthesizer = {
    synthesize: (): Promise<{ markdown: string; source_memory_ids: string[] }> =>
      Promise.resolve({ markdown: "recovered real brief", source_memory_ids: [] }),
  };
  await runDreamCycle(db, testConfig(), {
    projectRegistry,
    memoryObserve,
    briefSynthesizer: recoveringSynthesizer,
    log,
  });

  expect(observeCalls).toEqual(["recovered real brief"]);
});

it("P6 synthesizes brief when last is older than refresh window", async () => {
  const db = openTestDb();
  const projectId = "proj-stale";
  const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
  seedProjectBrief(db, { project_id: projectId, generated_at: twentyFiveHoursAgo });
  const observeCalls: string[] = [];
  const memoryObserve = (
    _brief: string,
    pid: string,
    _cid: string,
  ): Promise<{ memory_id: string }> => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'test-user', 'feedback', ?, ?, 'brief', 'brief body', ?, ?)`,
    ).run(memId, now, now, now, now);
    observeCalls.push(pid);
    return Promise.resolve({ memory_id: memId });
  };
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  const briefSynthesizer = {
    synthesize: (): Promise<{ markdown: string; source_memory_ids: string[] }> =>
      Promise.resolve({ markdown: "refreshed real brief", source_memory_ids: [] }),
  };
  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), {
    projectRegistry,
    memoryObserve,
    briefSynthesizer,
  });
  expect(observeCalls).toContain(projectId);
  const row = db
    .prepare(`SELECT generated_at FROM project_briefs WHERE project_id=?`)
    .get(projectId) as { generated_at: number };
  expect(row.generated_at).toBeGreaterThan(twentyFiveHoursAgo);
});

it("P6 synthesizes brief when project_briefs has no row for project", async () => {
  const db = openTestDb();
  const projectId = "proj-new";
  const observeCalls: string[] = [];
  const memoryObserve = (
    _brief: string,
    pid: string,
    _cid: string,
  ): Promise<{ memory_id: string }> => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'test-user', 'feedback', ?, ?, 'brief', 'brief body', ?, ?)`,
    ).run(memId, now, now, now, now);
    observeCalls.push(pid);
    return Promise.resolve({ memory_id: memId });
  };
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "off" } },
  ]);
  const briefSynthesizer = {
    synthesize: (): Promise<{ markdown: string; source_memory_ids: string[] }> =>
      Promise.resolve({ markdown: "new real brief", source_memory_ids: [] }),
  };
  await runDreamCycle(db, testConfig(), { projectRegistry, memoryObserve, briefSynthesizer });
  expect(observeCalls).toContain(projectId);
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM project_briefs WHERE project_id=?`).get(projectId) as {
      n: number;
    }
  ).n;
  expect(count).toBe(1);
});

it("P4 deduplicates: does not add a 2nd batch if research_query already queued for project", async () => {
  const db = openTestDb();
  const projectId = "proj-dedup";
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: "prior query topic" });
  ensureSeedCycle(db);
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, 'seed-cycle', 'P4', 'research_query', 0.5, 'queued', ?, ?)`,
  ).run(crypto.randomUUID(), JSON.stringify([projectId]), '{"query":"prior"}');
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  // P5 may transition the pre-seeded action away from 'queued'; count all statuses
  // to verify the seeder didn't add a second row.
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(1); // original pre-seeded one; seeder added no new entry
});

it("P4 deduplicates research_query seeding against approved actions", async () => {
  const db = openTestDb();
  const projectId = "proj-approved";
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: "prior query topic" });
  ensureSeedCycle(db);
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, 'seed-cycle', 'P4', 'research_query', 0.5, 'approved', ?, ?)`,
  ).run(crypto.randomUUID(), JSON.stringify([projectId]), '{"query":"prior"}');
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: "firecrawl" } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
      )
      .get() as { n: number }
  ).n;
  expect(count).toBe(1); // original pre-seeded approved one; seeder added no new entry
});
