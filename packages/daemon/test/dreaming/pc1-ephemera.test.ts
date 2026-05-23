import { expect, it, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { loadSqliteVec, applySchema } from '@penumbra/core';
import type { DreamConfig } from '../../src/dreaming/config.js';
import { detectT2Ephemera } from '../../src/dreaming/curator/t2-ephemera-detector.js';
import { runPC1Phase } from '../../src/dreaming/curator/pc1-ephemera.js';
import { revertDreamAction } from '../../src/dreaming/reembed.js';

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
  try { db.exec('ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER'); } catch { /* already present */ }
  return db;
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.00,
    dailyUsd: 100.00,
    pressureGuardEnabled: false,
    perCycleEmbeddingUsd: 0.10,
    perCycleResearchUsd: 0.25,
    linkAutoThreshold: 0.75,
    p1BatchSize: 10,
    pc1BatchSize: 100,
    reembedBatchSize: 100,
    skipPhases: new Set<string>(),
    eventTriggerEnabled: false,
    idleMinutes: 15,
    triggerCooldownMinutes: 5,
    briefRefreshHours: 24,
    curatorEnabled: false,
    ...overrides,
  };
}

function seedCycle(db: Database, cycleId: string): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', 1.0, 'running', '[]')`,
  ).run(cycleId, Date.now());
}

function seedMemory(
  db: Database,
  opts: { body: string; kind?: string; title?: string; retired_at?: number | null },
): string {
  const memoryId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
     VALUES(?, 'system', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(memoryId, opts.kind ?? 'promoted', now, now, opts.title ?? 'title', opts.body, now, now);
  if (opts.retired_at != null) {
    db.prepare('UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?').run(opts.retired_at, memoryId);
  }
  return memoryId;
}

// ── detectT2Ephemera unit tests ──────────────────────────────────────────────

it('detectT2Ephemera flags UUID-only body', () => {
  const r = detectT2Ephemera({ title: 'item', body: '429c79cc-6240-43bb-bd97-4ef675382c35', kind: 'promoted' });
  expect(r).toMatchObject({ isEphemera: true, reason: 'uuid_body', confidence: 0.99 });
});

it('detectT2Ephemera flags URL title', () => {
  const r = detectT2Ephemera({ title: 'https://reddit.com/r/bun', body: 'content', kind: 'promoted' });
  expect(r).toMatchObject({ isEphemera: true, reason: 'url_title' });
});

it('detectT2Ephemera flags stub brief', () => {
  const r = detectT2Ephemera({ title: 'Project X', body: 'Stub.', kind: 'brief' });
  expect(r).toMatchObject({ isEphemera: true, reason: 'stub_brief' });
});

it('detectT2Ephemera flags dispatch-prompt body', () => {
  const r = detectT2Ephemera({ title: 'P1 auto-promote: fix', body: 'Fix: P1 phase is promoting...', kind: 'promoted' });
  expect(r.isEphemera).toBe(true);
});

it('detectT2Ephemera passes normal knowledge memory', () => {
  const r = detectT2Ephemera({ title: 'Agent branch naming', body: 'Use agent/<id> prefix for handoff worktrees.', kind: 'knowledge' });
  expect(r.isEphemera).toBe(false);
});

it('detectT2Ephemera respects approved runtime pattern', () => {
  const r = detectT2Ephemera(
    { title: 'OK', body: 'Recall context: prior session data', kind: 'promoted' },
    ['%Recall context:%'],
  );
  expect(r).toMatchObject({ isEphemera: true, reason: 'runtime_pattern' });
});

// ── runPC1Phase integration tests ─────────────────────────────────────────────

it('runPC1Phase auto-retires UUID-body memory', async () => {
  const db = openTestDb();
  seedCycle(db, 'cycle-1');
  const memId = seedMemory(db, { body: '429c79cc-6240-43bb-bd97-4ef675382c35' });
  await runPC1Phase(db, 'cycle-1', testConfig(), {});
  const action = db.prepare(`SELECT * FROM dream_actions WHERE action_type='ephemera_retire'`).get() as any;
  expect(action).toBeDefined();
  expect(action.status).toBe('auto_applied');
  const mem = db.prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`).get(memId) as any;
  expect(mem.retired_at).toBeTruthy();
});

it('runPC1Phase skips already-retired memories', async () => {
  const db = openTestDb();
  seedCycle(db, 'cycle-1');
  seedMemory(db, { body: '429c79cc-6240-43bb-bd97-4ef675382c35', retired_at: Date.now() });
  await runPC1Phase(db, 'cycle-1', testConfig(), {});
  const count = (db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE action_type='ephemera_retire'`).get() as any).n;
  expect(count).toBe(0);
});

it('runPC1Phase dedup: second cycle does not queue duplicate ephemera_retire for same memory', async () => {
  const db = openTestDb();
  seedCycle(db, 'cycle-1');
  seedCycle(db, 'cycle-2');
  const memId = seedMemory(db, { body: '429c79cc-6240-43bb-bd97-4ef675382c35' });
  await runPC1Phase(db, 'cycle-1', testConfig(), {});
  await runPC1Phase(db, 'cycle-2', testConfig(), {});
  const count = (db.prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE action_type='ephemera_retire' AND target_ids LIKE ?`).get(`%${memId}%`) as any).n;
  expect(count).toBe(1);
});

it('runPC1Phase advances cursor across non-multiple batches and wraps on the final partial batch', async () => {
  const db = openTestDb();
  seedCycle(db, 'cycle-cursor');

  // Seed 250 memories with sortable IDs; none are ephemeral
  for (let i = 1; i <= 250; i++) {
    const id = `mem-${String(i).padStart(4, '0')}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?)`,
    ).run(id, now, now, id, 'normal knowledge content not ephemeral', now, now);
  }

  const cfg = testConfig({ pc1BatchSize: 100 });

  // Cycle 1: cursor starts at '' → scans mem-0001..mem-0100
  await runPC1Phase(db, 'cycle-cursor', cfg, {});
  const after1 = (db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as any).value;
  expect(after1).toBe('mem-0100');

  // Cycle 2: cursor at mem-0100 → scans mem-0101..mem-0200
  await runPC1Phase(db, 'cycle-cursor', cfg, {});
  const after2 = (db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as any).value;
  expect(after2).toBe('mem-0200');

  // Cycle 3: cursor at mem-0200 → scans mem-0201..mem-0250 (50 < 100) → wraps to ''
  await runPC1Phase(db, 'cycle-cursor', cfg, {});
  const after3 = (db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as any).value;
  expect(after3).toBe('');
});

it('runPC1Phase wraps cursor after exact multiple of batch size', async () => {
  const db = openTestDb();
  seedCycle(db, 'cycle-cursor-exact');

  for (let i = 1; i <= 200; i++) {
    const id = `mem-${String(i).padStart(4, '0')}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?)`,
    ).run(id, now, now, id, 'normal knowledge content not ephemeral', now, now);
  }

  const cfg = testConfig({ pc1BatchSize: 100 });

  await runPC1Phase(db, 'cycle-cursor-exact', cfg, {});
  const after1 = (db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as any).value;
  expect(after1).toBe('mem-0100');

  await runPC1Phase(db, 'cycle-cursor-exact', cfg, {});
  const after2 = (db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as any).value;
  expect(after2).toBe('');
});

it('revertDreamAction un-retires t2 memory on ephemera_retire revert', async () => {
  const db = openTestDb();
  seedCycle(db, 'cycle-1');
  const memId = seedMemory(db, { body: '429c79cc-6240-43bb-bd97-4ef675382c35' });
  await runPC1Phase(db, 'cycle-1', testConfig(), {});
  const action = db.prepare(`SELECT action_id FROM dream_actions WHERE action_type='ephemera_retire'`).get() as any;
  revertDreamAction(db, action.action_id, 'none');
  const mem = db.prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`).get(memId) as any;
  expect(mem.retired_at).toBeNull();
});
