import { expect, it, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, applySchema } from '@penumbra/core';
import { runDreamCycle } from '../../src/dreaming/cycle.js';
import { makeFakeJudgePool } from '../../src/dreaming/judge-pool.js';
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
    db.prepare(
      `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events)
       VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', 1)`,
    ).run(`R${i + 1}`, `session-${i + 1}`);
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

function seedUnpromotedRollup(db: Database, opts: { body: string }): void {
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt)
     VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', 1, ?)`,
  ).run(crypto.randomUUID(), crypto.randomUUID(), opts.body);
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
  seedUnpromotedRollup(db, { body: 'well-known finding' });
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

function seedRollupWithProjectId(db: Database, opts: { project_id: string; body: string }): void {
  db.prepare(
    `INSERT INTO t1_rollups(rollup_id, user_id, session_id, started_at, n_events, first_prompt_excerpt, project_id)
     VALUES(?, 'test-user', ?, '2026-01-01T00:00:00Z', 1, ?, ?)`,
  ).run(crypto.randomUUID(), crypto.randomUUID(), opts.body, opts.project_id);
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
  seedRollupWithProjectId(db, { project_id: projectId, body: 'important topic A' });
  seedRollupWithProjectId(db, { project_id: projectId, body: 'important topic B' });
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
  seedRollupWithProjectId(db, { project_id: 'proj-off', body: 'some topic' });
  seedRollupWithProjectId(db, { project_id: 'proj-none', body: 'some topic' });
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
  seedRollupWithProjectId(db, { project_id: projectId, body: 'prior query topic' });
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
