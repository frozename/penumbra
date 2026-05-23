import { expect, it, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, applySchema } from '@penumbra/core';
import { runDreamCycle } from '../../src/dreaming/cycle.js';
import { makeFakeJudgePool } from '../../src/dreaming/judge-pool.js';
import { hashQuery } from '../../src/dreaming/research.js';
import { sanitizeTitleForQuery } from '../../src/dreaming/query-sanitize.js';
import type { DreamConfig } from '../../src/dreaming/config.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {
  // already loaded
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

function openTestDb(): Database {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  return db;
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.00,
    dailyUsd: 100.00,
    curatorEnabled: false,
    pressureGuardEnabled: true,
    perCycleEmbeddingUsd: 0.10,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    ...overrides,
  };
}

function seedTodaySpend(db: Database, opts: { llm: number; embedding: number; research: number }): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, ended_at, llm_spent_usd, embedding_spent_usd, research_spent_usd)
     VALUES('seed-spend', ?, 'cron', 1.0, 'completed', ?, ?, ?, ?)`,
  ).run(Date.now(), Date.now(), opts.llm, opts.embedding, opts.research);
}

function seedUnpromotedRollups(db: Database, n: number): void {
  for (let i = 0; i < n; i++) {
    const rollupId = `R${i + 1}`;
    const sessionId = `session-${i + 1}`;
    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
       VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', 1, ?)`,
    ).run(rollupId, sessionId, `rollup-${i + 1}`);
  }
}

function seedMemoryWithVector(db: Database, opts: { id: string; vector: number[] }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', 'feedback', ?, ?, ?, 'body', ?, ?)`,
  ).run(opts.id, now, now, opts.id, now, now);
  const { rowid } = db.prepare(`SELECT rowid FROM t2_memories WHERE memory_id = ?`).get(opts.id) as { rowid: number };
  db.prepare(`INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)`).run(rowid, new Float32Array(opts.vector));
}

function getCycleOutcome(db: Database, cycleId: string): string {
  const row = db.prepare(`SELECT outcome FROM dream_cycles WHERE cycle_id = ?`).get(cycleId) as { outcome: string } | null;
  return row?.outcome ?? '';
}

function getCycleBailReason(db: Database, cycleId: string): string {
  const row = db.prepare(`SELECT bail_reason FROM dream_cycles WHERE cycle_id = ?`).get(cycleId) as { bail_reason: string | null } | null;
  return row?.bail_reason ?? '';
}

function getClaimedRollups(db: Database, cycleId: string): string[] {
  const rows = db.prepare(`SELECT rollup_id FROM t1_rollups WHERE claimed_by_cycle = ?`).all(cycleId) as Array<{ rollup_id: string }>;
  return rows.map((r) => r.rollup_id);
}

it('P0 bails when daily cap already reached', async () => {
  const db = openTestDb();
  seedTodaySpend(db, { llm: 4.50, embedding: 0.40, research: 0.20 }); // total 5.10 > dailyUsd 5.0
  const cycleId = await runDreamCycle(db, testConfig({ dailyUsd: 5.0 }));
  expect(getCycleOutcome(db, cycleId)).toBe('bailed');
  expect(getCycleBailReason(db, cycleId)).toMatch(/daily/i);
});

it('P0 bails when per-cycle LLM cap exceeded', async () => {
  const db = openTestDb();
  const cycleId = await runDreamCycle(db, testConfig({ perCycleUsd: 0.001 }));
  expect(getCycleOutcome(db, cycleId)).toBe('bailed');
  expect(getCycleBailReason(db, cycleId)).toMatch(/per.cycle/i);
});

it('P0 bails when pressure guard sees throttled provider', async () => {
  const db = openTestDb();
  const pressureStub = { check: async () => ({ anyThrottled: true }) };
  const cycleId = await runDreamCycle(db, testConfig(), { pressureGuard: pressureStub });
  expect(getCycleOutcome(db, cycleId)).toBe('bailed');
  expect(getCycleBailReason(db, cycleId)).toMatch(/pressure/i);
});

it('P0 pressure guard: flap mid-cycle bails before next phase', async () => {
  const db = openTestDb();
  let callCount = 0;
  const pressureStub = {
    check: async () => ({ anyThrottled: callCount++ > 1 }), // flips throttled after 2nd call
  };
  const cycleId = await runDreamCycle(db, testConfig(), { pressureGuard: pressureStub });
  const row = db.prepare(`SELECT phases_run FROM dream_cycles WHERE cycle_id=?`).get(cycleId) as { phases_run: string };
  const phases = JSON.parse(row.phases_run) as string[];
  // bails after first throttled check; P0 was fine, but mid-cycle re-check trips
  expect(phases.length).toBeLessThan(4);
});

it('P1 transactional claim: two concurrent P1 invocations produce disjoint working sets', async () => {
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

it('P2 auto-applies semantic_near link when cosine >= LINK_AUTO_THRESHOLD', async () => {
  const db = openTestDb();
  seedMemoryWithVector(db, { id: 'M-A', vector: [1, 0, 0] });
  seedMemoryWithVector(db, { id: 'M-B', vector: [0.96, 0.1, 0] }); // cosine > 0.75
  await runDreamCycle(db, testConfig());
  const link = db.prepare(`SELECT * FROM memory_links WHERE link_type='semantic_near'`).get();
  expect(link).toBeDefined();
  const action = db.prepare(`SELECT * FROM dream_actions WHERE phase='P2' AND status='auto_applied'`).get();
  expect(action).toBeDefined();
});

it('P2 queues semantic_near link when cosine < LINK_AUTO_THRESHOLD', async () => {
  const db = openTestDb();
  seedMemoryWithVector(db, { id: 'M-A', vector: [1, 0, 0] });
  seedMemoryWithVector(db, { id: 'M-B', vector: [0.5, 0.5, 0] }); // cosine < 0.75
  await runDreamCycle(db, testConfig());
  const action = db.prepare(`SELECT * FROM dream_actions WHERE phase='P2' AND status='queued'`).get();
  expect(action).toBeDefined();
});

it('P8 sets completed outcome with non-null ended_at and non-empty phases_run', async () => {
  const db = openTestDb();
  const cycleId = await runDreamCycle(db, testConfig());
  const row = db.prepare(`SELECT outcome, ended_at, phases_run FROM dream_cycles WHERE cycle_id=?`).get(cycleId) as {
    outcome: string;
    ended_at: number;
    phases_run: string;
  };
  expect(row.outcome).toBe('completed');
  expect(row.ended_at).toBeGreaterThan(0);
  expect(JSON.parse(row.phases_run)).toContain('P0');
});

it('in-process mutex prevents overlapping cycles', async () => {
  const db = openTestDb();
  await Promise.all([
    runDreamCycle(db, testConfig()),
    runDreamCycle(db, testConfig()),
  ]);
  const running = db.prepare(`SELECT COUNT(*) as n FROM dream_cycles WHERE outcome='running'`).get() as { n: number };
  expect(running.n).toBe(0);
});

// ── helpers for P1/P3/P4 tests ─────────────────────────────────────────────

function ensureSeedCycle(db: Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES('seed-cycle', 1, 'seed', 0, 'completed', '[]')`,
  ).run();
}

function seedMemory(db: Database, opts: { body: string }): string {
  const memId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'test-user', 'feedback', ?, ?, 'test', ?, ?, ?)`,
  ).run(memId, now, now, opts.body, now, now);
  return memId;
}

function seedUnpromotedRollup(db: Database, opts: {
  body: string;
  userId?: string;
  firstPromptExcerpt?: string | null;
}): string {
  const rollupId = crypto.randomUUID();
  const userId = opts.userId ?? 'test-user';
  const firstPromptExcerpt = opts.firstPromptExcerpt === undefined ? opts.body : opts.firstPromptExcerpt;
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
     VALUES(?, ?, ?, '2026-01-01T00:00:00Z', 1, ?)`,
  ).run(rollupId, userId, crypto.randomUUID(), firstPromptExcerpt);
  return rollupId;
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
  db.exec('BEGIN');
  for (let i = 0; i < max; i++) {
    stmt.run(crypto.randomUUID(), JSON.stringify([`mem-seed-${i}`]));
  }
  db.exec('COMMIT');
}

function seedExpiredP4Action(db: Database, opts: { expires_at: number }): void {
  ensureSeedCycle(db);
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, expires_at)
     VALUES(?, 'seed-cycle', 'P4', 'resolve_contradiction', 0.5, 'queued', '["mem-expired"]', '{}', ?)`,
  ).run(crypto.randomUUID(), opts.expires_at);
}

// ── P1 auto-promote ────────────────────────────────────────────────────────

it('P1 auto-promotes when judge consensus >= ceil(2/3)', async () => {
  const db = openTestDb();
  seedUnpromotedRollup(db, { body: 'well-known finding with durable reasoning about dispatch policy and memory shaping.' });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.90 },
    { promote: true, confidence: 0.85 },
    { promote: false, confidence: 0.40 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool });
  const action = db
    .prepare(`SELECT status FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`)
    .get() as { status: string } | null;
  expect(action?.status).toBe('auto_applied');
});

it('P1 skips rollups whose first_prompt_excerpt is a long-lived standing prompt', async () => {
  const db = openTestDb();
  const normalRollupId = seedUnpromotedRollup(db, {
    body: 'normal user prompt about Postgres migration rollout sequencing and query planning.',
  });
  const longLivedRollupId = seedUnpromotedRollup(db, {
    body: 'ignored prompt',
    firstPromptExcerpt:
      'You are home-mgmt, a long-lived agent with persistent state. Standing brief: check house health and dispatch critical issues.',
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  const cycleId = await runDreamCycle(db, testConfig(), { judgePool: pool });
  const claimedRollups = getClaimedRollups(db, cycleId);
  expect(claimedRollups).toContain(normalRollupId);
  expect(claimedRollups).not.toContain(longLivedRollupId);
  const longLivedRow = db.prepare(`SELECT claimed_by_cycle FROM t1_rollups WHERE rollup_id=?`).get(longLivedRollupId) as {
    claimed_by_cycle: string | null;
  } | null;
  expect(longLivedRow?.claimed_by_cycle).toBeNull();
  const p1Actions = db
    .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`)
    .get() as { n: number };
  expect(p1Actions.n).toBe(1);
});

it('P1 skips dispatch-mode excerpts (Operating rules / IMPLEMENTER MODE)', async () => {
  const db = openTestDb();
  seedUnpromotedRollup(db, {
    body: 'normal user prompt about deployment',
    firstPromptExcerpt: '# Operating rules\nIMPLEMENTER MODE\nThis is a session-specific dispatch command',
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool });
  const p1Actions = db
    .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`)
    .get() as { n: number };
  expect(p1Actions.n).toBe(0);
});

it('P1 skips Fix:-prefixed excerpts', async () => {
  const db = openTestDb();
  seedUnpromotedRollup(db, {
    body: 'normal user prompt about deployment',
    firstPromptExcerpt: 'Fix: task was completed and closed by the release pipeline.',
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool });
  const p1Actions = db
    .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1'`)
    .get() as { n: number };
  expect(p1Actions.n).toBe(0);
});

it('P1 skips NULL and short first_prompt_excerpt rollups (no UUID fallback)', async () => {
  const db = openTestDb();
  const nullRollupId = seedUnpromotedRollup(db, {
    body: 'normal user prompt with no excerpt',
    firstPromptExcerpt: null,
  });
  const shortRollupId = seedUnpromotedRollup(db, {
    body: 'normal user prompt with no excerpt',
    firstPromptExcerpt: 'short',
  });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  const cycleId = await runDreamCycle(db, testConfig(), { judgePool: pool });
  const claimedRollups = getClaimedRollups(db, cycleId);
  expect(claimedRollups).toContain(nullRollupId);
  expect(claimedRollups).toContain(shortRollupId);
  const p1Actions = db
    .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' AND cycle_id=?`)
    .get(cycleId) as { n: number };
  expect(p1Actions.n).toBe(0);
});

it('P1 queues queued auto-promote when title already exists in active t2 memory', async () => {
  const db = openTestDb();
  const body = 'Design decision: prefer async-first handlers for all workflow dispatch code paths.';
  const existingTitle = `P1 auto-promote: ${body.slice(0, 80)}`;
  const existingMemoryId = seedMemory(db, { body: 'legacy body' });
  db.prepare(`UPDATE t2_memories SET title=? WHERE memory_id=?`).run(existingTitle, existingMemoryId);
  seedUnpromotedRollup(db, { body });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool });
  const action = db
    .prepare(
      `SELECT status, payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { status: string; payload_json: string } | null;
  expect(action?.status).toBe('queued');
  const payload = JSON.parse(action?.payload_json ?? '{}') as { dedup_against?: string };
  expect(payload.dedup_against).toBe(existingMemoryId);
  const t2Count = (db.prepare('SELECT COUNT(*) as n FROM t2_memories').get() as { n: number }).n;
  expect(t2Count).toBe(1);
});

it('P1 queues queued auto-promote when body already exists in active t2 memory', async () => {
  const db = openTestDb();
  const body = 'Feature flag naming conventions should always include the service suffix to avoid collisions.';
  const existingMemoryId = seedMemory(db, { body });
  seedUnpromotedRollup(db, { body });
  const pool = makeFakeJudgePool([
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
    { promote: true, confidence: 0.95 },
  ]);
  await runDreamCycle(db, testConfig(), { judgePool: pool });
  const action = db
    .prepare(
      `SELECT status, payload_json FROM dream_actions WHERE phase='P1' AND action_type='promote_t1' ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { status: string; payload_json: string } | null;
  expect(action?.status).toBe('queued');
  const payload = JSON.parse(action?.payload_json ?? '{}') as { dedup_against?: string };
  expect(payload.dedup_against).toBe(existingMemoryId);
  const t2Count = (db.prepare('SELECT COUNT(*) as n FROM t2_memories').get() as { n: number }).n;
  expect(t2Count).toBe(1);
});

// ── P3 quality signal ──────────────────────────────────────────────────────

it('P3 rewrite: never auto-applied, always queued regardless of confidence', async () => {
  const db = openTestDb();
  seedMemory(db, { body: 'vague memory that needs rewriting' });
  const scorer = {
    score: async () => ({
      verdict: 'rewrite' as const,
      composite: 0.95,
      should_auto_retire: false,
    }),
  };
  await runDreamCycle(db, testConfig(), { scorer });
  const action = db
    .prepare(`SELECT status FROM dream_actions WHERE action_type='rewrite'`)
    .get() as { status: string } | null;
  expect(action?.status).toBe('queued');
});

it('P3 auto-retire skips direct-origin memories but retires non-direct memories', async () => {
  const db = openTestDb();
  const directId = seedMemory(db, { body: 'direct source memory' });
  const nonDirectId = seedMemory(db, { body: 'non-direct source memory' });
  db.prepare(`UPDATE t2_memories SET origin = 'direct' WHERE memory_id = ?`).run(directId);

  await runDreamCycle(
    db,
    testConfig(),
    {
      scorer: {
        score: async ({ memory_id }: { memory_id: string }) => ({
          verdict: memory_id === directId ? 'keep' : 'retire',
          composite: 0.99,
          should_auto_retire: true,
        }),
      },
    },
  );

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
  expect(directAction?.status).toBe('skipped_direct_origin');
  expect(nonDirectAction?.status).toBe('auto_applied');
});

// ── P4 bounded discovery queue ─────────────────────────────────────────────

it('P4 queues bounded: evicts oldest-expired when queue hits P4_QUEUE_MAX', async () => {
  const db = openTestDb();
  seedP4QueueAtMax(db, 1000);
  seedExpiredP4Action(db, { expires_at: 1 });
  await runDreamCycle(db, testConfig({ p4QueueMax: 1000 }));
  const count = db
    .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND status='queued'`)
    .get() as { n: number };
  expect(count.n).toBeLessThanOrEqual(1000);
});

it('P4 contradiction actions deduplicated by (action_type, target_ids)', async () => {
  const db = openTestDb();
  const m1 = seedMemory(db, { body: 'X is always true' });
  const m2 = seedMemory(db, { body: 'X is never true' });
  insertLink(db, { src_id: m1, dst_id: m2, link_type: 'contradicts', weight: 0.95 });
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

function seedT2MemoryWithProjectId(db: Database, opts: { project_id: string; title: string }): void {
  const memId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
     VALUES(?, 'test-user', 'knowledge', ?, ?, ?, 'body', ?, ?, ?)`
  ).run(memId, now, now, opts.title, now, now, opts.project_id);
}

function makeProjectRegistry(projects: Array<{ project_id: string; dreaming?: { research_provider?: string } }>) {
  return {
    get: (id: string) => projects.find((p) => p.project_id === id) ?? null,
    list: () => projects,
  };
}

it('P4 seeds research_query actions for projects with research_provider != off', async () => {
  const db = openTestDb();
  const projectId = 'proj-firecrawl';
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'important topic A' });
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'important topic B' });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const actions = db.prepare(
    `SELECT target_ids, payload_json FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
  ).all() as Array<{ target_ids: string; payload_json: string }>;
  expect(actions.length).toBeGreaterThanOrEqual(1);
  expect(actions.length).toBeLessThanOrEqual(2);
  for (const a of actions) {
    expect(JSON.parse(a.target_ids)).toEqual([projectId]);
    expect(JSON.parse(a.payload_json).query).toBeTruthy();
  }
});

it('P4 skips research_query for projects with research_provider=off or no dreaming config', async () => {
  const db = openTestDb();
  seedT2MemoryWithProjectId(db, { project_id: 'proj-off', title: 'some topic' });
  seedT2MemoryWithProjectId(db, { project_id: 'proj-none', title: 'some topic' });
  const projectRegistry = makeProjectRegistry([
    { project_id: 'proj-off', dreaming: { research_provider: 'off' } },
    { project_id: 'proj-none' },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE action_type='research_query'`).get() as { n: number }
  ).n;
  expect(count).toBe(0);
});

it('P4 skips research_query seeding when t2 title looks like a URL', async () => {
  const db = openTestDb();
  const projectId = 'proj-url';
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'https://attacker.com/exfil' });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`).get() as { n: number }
  ).n;
  expect(count).toBe(0);
});

it('P4 skips research_query seeding when negative cache sentinel is fresh', async () => {
  const db = openTestDb();
  const projectId = 'proj-negative-hit';
  const now = Date.now();
  const titles = ['Concurrent boot flow assertions', 'Parallel boot actions using allSettled'];
  for (const title of titles) {
    seedT2MemoryWithProjectId(db, { project_id: projectId, title });
    seedNegativeResearchCache(db, { project_id: projectId, title, expiresAt: now + 3600000 });
  }
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`).get() as { n: number }
  ).n;
  expect(count).toBe(0);
});

it('P4 inserts research_query when negative cache sentinel is expired', async () => {
  const db = openTestDb();
  const projectId = 'proj-negative-miss';
  const now = Date.now();
  const titles = ['Concurrent boot flow assertions', 'Parallel boot actions using allSettled'];
  for (const title of titles) {
    seedT2MemoryWithProjectId(db, { project_id: projectId, title });
    seedNegativeResearchCache(db, { project_id: projectId, title, expiresAt: now - 3600000 });
  }
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`).get() as { n: number }
  ).n;
  expect(count).toBe(2);
});

it('P4 inserts research_query when no negative cache sentinel exists', async () => {
  const db = openTestDb();
  const projectId = 'proj-no-sentinel';
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'Concurrent boot flow assertions' });
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'Parallel boot actions using allSettled' });
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`).get() as { n: number }
  ).n;
  expect(count).toBe(2);
});

// ── P6 brief dedup ─────────────────────────────────────────────────────────

function seedProjectBrief(db: Database, opts: { project_id: string; generated_at: number }): void {
  ensureSeedCycle(db);
  db.prepare(
    `INSERT OR REPLACE INTO project_briefs(project_id, brief_md, source_memory_ids, generated_at, generated_by_cycle, t2_shadow_memory_id)
     VALUES(?, 'old brief', '[]', ?, 'seed-cycle', NULL)`,
  ).run(opts.project_id, opts.generated_at);
}

it('P6 skips brief generation when last brief is within refresh window', async () => {
  const db = openTestDb();
  const projectId = 'proj-fresh';
  seedProjectBrief(db, { project_id: projectId, generated_at: Date.now() - 60 * 60 * 1000 }); // 1h ago
  const observeCalls: string[] = [];
  const memoryObserve = async (_brief: string, pid: string, _cid: string) => {
    observeCalls.push(pid);
    return { memory_id: crypto.randomUUID() };
  };
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'off' } },
  ]);
  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), { projectRegistry, memoryObserve });
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM project_briefs WHERE project_id=?`).get(projectId) as { n: number }
  ).n;
  expect(count).toBe(1);
  expect(observeCalls).not.toContain(projectId);
});

function makeMemoryObserve(db: Database) {
  return async (brief: string, pid: string, _cid: string) => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at, project_id)
       VALUES(?, 'system', 'brief', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(memId, now, now, `Brief: ${pid}`, brief, now, now, pid);
    return { memory_id: memId };
  };
}

it('P6 uses briefSynthesizer when provided and stores its output', async () => {
  const db = openTestDb();
  const projectId = 'penumbra';
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'important finding' });
  const memoryObserve = makeMemoryObserve(db);
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'off' } },
  ]);
  const briefSynthesizer = {
    synthesize: async () => ({ markdown: 'real brief content', source_memory_ids: ['mA'] }),
  };
  await runDreamCycle(db, testConfig(), { projectRegistry, memoryObserve, briefSynthesizer });
  const row = db.prepare(
    `SELECT brief_md, source_memory_ids FROM project_briefs WHERE project_id=?`,
  ).get(projectId) as { brief_md: string; source_memory_ids: string } | null;
  expect(row).not.toBeNull();
  expect(row!.brief_md).toBe('real brief content');
  expect(JSON.parse(row!.source_memory_ids)).toContain('mA');
});

it('P6 falls back to stub markdown when no briefSynthesizer provided', async () => {
  const db = openTestDb();
  const projectId = 'proj-stub';
  const memoryObserve = makeMemoryObserve(db);
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'off' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry, memoryObserve });
  const row = db.prepare(
    `SELECT brief_md FROM project_briefs WHERE project_id=?`,
  ).get(projectId) as { brief_md: string } | null;
  expect(row).not.toBeNull();
  expect(row!.brief_md).toContain('# Project Brief: ' + projectId);
  expect(row!.brief_md).toContain('Generated by P6.');
});

it('P6 generates brief when last is older than refresh window', async () => {
  const db = openTestDb();
  const projectId = 'proj-stale';
  const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
  seedProjectBrief(db, { project_id: projectId, generated_at: twentyFiveHoursAgo });
  const observeCalls: string[] = [];
  const memoryObserve = async (_brief: string, pid: string, _cid: string) => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'test-user', 'feedback', ?, ?, 'brief', 'brief body', ?, ?)`,
    ).run(memId, now, now, now, now);
    observeCalls.push(pid);
    return { memory_id: memId };
  };
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'off' } },
  ]);
  await runDreamCycle(db, testConfig({ briefRefreshHours: 24 }), { projectRegistry, memoryObserve });
  expect(observeCalls).toContain(projectId);
  const row = db.prepare(
    `SELECT generated_at FROM project_briefs WHERE project_id=?`,
  ).get(projectId) as { generated_at: number };
  expect(row.generated_at).toBeGreaterThan(twentyFiveHoursAgo);
});

it('P6 generates brief when project_briefs has no row for project', async () => {
  const db = openTestDb();
  const projectId = 'proj-new';
  const observeCalls: string[] = [];
  const memoryObserve = async (_brief: string, pid: string, _cid: string) => {
    const memId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'test-user', 'feedback', ?, ?, 'brief', 'brief body', ?, ?)`,
    ).run(memId, now, now, now, now);
    observeCalls.push(pid);
    return { memory_id: memId };
  };
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'off' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry, memoryObserve });
  expect(observeCalls).toContain(projectId);
  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM project_briefs WHERE project_id=?`).get(projectId) as { n: number }
  ).n;
  expect(count).toBe(1);
});

it('P4 deduplicates: does not add a 2nd batch if research_query already queued for project', async () => {
  const db = openTestDb();
  const projectId = 'proj-dedup';
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'prior query topic' });
  ensureSeedCycle(db);
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, 'seed-cycle', 'P4', 'research_query', 0.5, 'queued', ?, ?)`,
  ).run(crypto.randomUUID(), JSON.stringify([projectId]), '{"query":"prior"}');
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  // P5 may transition the pre-seeded action away from 'queued'; count all statuses
  // to verify the seeder didn't add a second row.
  const count = (
    db.prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    ).get() as { n: number }
  ).n;
  expect(count).toBe(1); // original pre-seeded one; seeder added no new entry
});

it('P4 deduplicates research_query seeding against approved actions', async () => {
  const db = openTestDb();
  const projectId = 'proj-approved';
  seedT2MemoryWithProjectId(db, { project_id: projectId, title: 'prior query topic' });
  ensureSeedCycle(db);
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json)
     VALUES(?, 'seed-cycle', 'P4', 'research_query', 0.5, 'approved', ?, ?)`,
  ).run(crypto.randomUUID(), JSON.stringify([projectId]), '{"query":"prior"}');
  const projectRegistry = makeProjectRegistry([
    { project_id: projectId, dreaming: { research_provider: 'firecrawl' } },
  ]);
  await runDreamCycle(db, testConfig(), { projectRegistry });
  const count = (
    db.prepare(
      `SELECT COUNT(*) as n FROM dream_actions WHERE phase='P4' AND action_type='research_query'`,
    ).get() as { n: number }
  ).n;
  expect(count).toBe(1); // original pre-seeded approved one; seeder added no new entry
});
