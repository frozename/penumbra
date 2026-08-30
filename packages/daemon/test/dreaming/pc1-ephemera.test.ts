import type { DreamConfig } from "@src/dreaming/config.js";

import { applySchema, loadSqliteVec } from "@penumbra/core";
import { runPC1Phase } from "@src/dreaming/curator/pc1-ephemera.js";
import { detectT2Ephemera } from "@src/dreaming/curator/t2-ephemera-detector.js";
import { revertDreamAction } from "@src/dreaming/reembed.js";
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

beforeEach(() => {
  delete process.env.PENUMBRA_PC1_AUTORETIRE;
});

afterEach(() => {
  delete process.env.PENUMBRA_PC1_AUTORETIRE;
});

interface DreamActionRow {
  action_id: string;
  status: string;
  target_ids: string;
  action_type: string;
}

interface MemoryRetiredRow {
  retired_at: number | null;
}

interface CountRow {
  n: number;
}

interface CursorRow {
  value: string;
}

function openTestDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 3 });
  try {
    db.run("ALTER TABLE t2_memories ADD COLUMN retired_at INTEGER");
  } catch {
    /* already present */
  }
  return db;
}

function testConfig(overrides?: Partial<DreamConfig>): DreamConfig {
  return {
    enabled: true,
    cronMinutes: 30,
    perCycleUsd: 1.0,
    dailyUsd: 100.0,
    pressureGuardEnabled: false,
    perCycleEmbeddingUsd: 0.1,
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
  } as DreamConfig;
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
  ).run(memoryId, opts.kind ?? "promoted", now, now, opts.title ?? "title", opts.body, now, now);
  if (opts.retired_at !== null && opts.retired_at !== undefined) {
    db.prepare("UPDATE t2_memories SET retired_at = ? WHERE memory_id = ?").run(
      opts.retired_at,
      memoryId,
    );
  }
  return memoryId;
}

// ── detectT2Ephemera unit tests ──────────────────────────────────────────────

it("detectT2Ephemera flags UUID-only body", () => {
  const r = detectT2Ephemera({
    title: "item",
    body: "429c79cc-6240-43bb-bd97-4ef675382c35",
    kind: "promoted",
  });
  expect(r).toMatchObject({ isEphemera: true, reason: "uuid_body", confidence: 0.99 });
});

it("detectT2Ephemera flags URL title", () => {
  const r = detectT2Ephemera({
    title: "https://reddit.com/r/bun",
    body: "content",
    kind: "promoted",
  });
  expect(r).toMatchObject({ isEphemera: true, reason: "url_title" });
});

it("detectT2Ephemera flags stub brief", () => {
  const r = detectT2Ephemera({ title: "Project X", body: "Stub.", kind: "brief" });
  expect(r).toMatchObject({ isEphemera: true, reason: "stub_brief" });
});

it("detectT2Ephemera flags dispatch-prompt body", () => {
  const r = detectT2Ephemera({
    title: "P1 auto-promote: fix",
    body: "Fix: P1 phase is promoting...",
    kind: "promoted",
  });
  expect(r.isEphemera).toBe(true);
});

it("detectT2Ephemera does not flag mid-string Fix prefix text", () => {
  const r = detectT2Ephemera({
    title: "normal note",
    body: "After review, we will Fix: the bug in a follow-up task.",
    kind: "knowledge",
  });
  expect(r.isEphemera).toBe(false);
});

it("detectT2Ephemera keeps substring matching for %...% prompt patterns", () => {
  const r = detectT2Ephemera({
    title: "normal note",
    body: "Team guidance: # Operating rules are documented in the runbook.",
    kind: "knowledge",
  });
  expect(r).toMatchObject({ isEphemera: true, reason: "dispatch_prompt_body" });
});

it("detectT2Ephemera passes normal knowledge memory", () => {
  const r = detectT2Ephemera({
    title: "Agent branch naming",
    body: "Use agent/<id> prefix for handoff worktrees.",
    kind: "knowledge",
  });
  expect(r.isEphemera).toBe(false);
});

it("detectT2Ephemera respects approved runtime pattern", () => {
  const r = detectT2Ephemera(
    { title: "OK", body: "Recall context: prior session data", kind: "promoted" },
    ["%Recall context:%"],
  );
  expect(r).toMatchObject({ isEphemera: true, reason: "runtime_pattern" });
});

// ── runPC1Phase integration tests ─────────────────────────────────────────────

it("runPC1Phase queues ephemera_retire by default without retiring memory", () => {
  const db = openTestDb();
  seedCycle(db, "cycle-1");
  const memId = seedMemory(db, { body: "429c79cc-6240-43bb-bd97-4ef675382c35" });
  runPC1Phase(db, "cycle-1", testConfig(), {});
  const action = db
    .prepare(`SELECT * FROM dream_actions WHERE action_type='ephemera_retire'`)
    .get() as DreamActionRow | undefined;
  expect(action).toBeDefined();
  expect(action!.status).toBe("queued");
  const mem = db
    .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`)
    .get(memId) as MemoryRetiredRow;
  expect(mem.retired_at).toBeNull();
});

it("runPC1Phase auto-applies retire when PENUMBRA_PC1_AUTORETIRE is enabled", () => {
  process.env.PENUMBRA_PC1_AUTORETIRE = "1";
  const db = openTestDb();
  seedCycle(db, "cycle-1");
  const memId = seedMemory(db, { body: "429c79cc-6240-43bb-bd97-4ef675382c35" });
  runPC1Phase(db, "cycle-1", testConfig(), {});
  const action = db
    .prepare(`SELECT * FROM dream_actions WHERE action_type='ephemera_retire'`)
    .get() as DreamActionRow | undefined;
  expect(action).toBeDefined();
  expect(action!.status).toBe("auto_applied");
  const mem = db
    .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`)
    .get(memId) as MemoryRetiredRow;
  expect(mem.retired_at).toBeTruthy();
});

it("runPC1Phase skips already-retired memories", () => {
  const db = openTestDb();
  seedCycle(db, "cycle-1");
  seedMemory(db, { body: "429c79cc-6240-43bb-bd97-4ef675382c35", retired_at: Date.now() });
  runPC1Phase(db, "cycle-1", testConfig(), {});
  const count = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dream_actions WHERE action_type='ephemera_retire'`)
      .get() as CountRow
  ).n;
  expect(count).toBe(0);
});

it("runPC1Phase dedup: second cycle does not queue duplicate ephemera_retire for same memory", () => {
  const db = openTestDb();
  seedCycle(db, "cycle-1");
  seedCycle(db, "cycle-2");
  const memId = seedMemory(db, { body: "429c79cc-6240-43bb-bd97-4ef675382c35" });
  runPC1Phase(db, "cycle-1", testConfig(), {});
  runPC1Phase(db, "cycle-2", testConfig(), {});
  const count = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM dream_actions WHERE action_type='ephemera_retire' AND target_ids LIKE ?`,
      )
      .get(`%${memId}%`) as CountRow
  ).n;
  expect(count).toBe(1);
});

it("runPC1Phase advances cursor across non-multiple batches and wraps on the final partial batch", () => {
  const db = openTestDb();
  seedCycle(db, "cycle-cursor");

  // Seed 250 memories with sortable IDs; none are ephemeral
  for (let i = 1; i <= 250; i++) {
    const id = `mem-${String(i).padStart(4, "0")}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?)`,
    ).run(id, now, now, id, "normal knowledge content not ephemeral", now, now);
  }

  const cfg = testConfig({ pc1BatchSize: 100 });

  // Cycle 1: cursor starts at '' → scans mem-0001..mem-0100
  runPC1Phase(db, "cycle-cursor", cfg, {});
  const after1 = (
    db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as CursorRow
  ).value;
  expect(after1).toBe("mem-0100");

  // Cycle 2: cursor at mem-0100 → scans mem-0101..mem-0200
  runPC1Phase(db, "cycle-cursor", cfg, {});
  const after2 = (
    db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as CursorRow
  ).value;
  expect(after2).toBe("mem-0200");

  // Cycle 3: cursor at mem-0200 → scans mem-0201..mem-0250 (50 < 100) → wraps to ''
  runPC1Phase(db, "cycle-cursor", cfg, {});
  const after3 = (
    db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as CursorRow
  ).value;
  expect(after3).toBe("");
});

it("runPC1Phase wraps cursor after exact multiple of batch size", () => {
  const db = openTestDb();
  seedCycle(db, "cycle-cursor-exact");

  for (let i = 1; i <= 200; i++) {
    const id = `mem-${String(i).padStart(4, "0")}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO t2_memories(memory_id, user_id, kind, window_start, window_end, title, body, created_at, updated_at)
       VALUES(?, 'system', 'promoted', ?, ?, ?, ?, ?, ?)`,
    ).run(id, now, now, id, "normal knowledge content not ephemeral", now, now);
  }

  const cfg = testConfig({ pc1BatchSize: 100 });

  runPC1Phase(db, "cycle-cursor-exact", cfg, {});
  const after1 = (
    db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as CursorRow
  ).value;
  expect(after1).toBe("mem-0100");

  runPC1Phase(db, "cycle-cursor-exact", cfg, {});
  const after2 = (
    db.prepare(`SELECT value FROM curator_cursors WHERE name='pc1_memory_id'`).get() as CursorRow
  ).value;
  expect(after2).toBe("");
});

it("revertDreamAction un-retires t2 memory on ephemera_retire revert", () => {
  const db = openTestDb();
  seedCycle(db, "cycle-1");
  const memId = seedMemory(db, { body: "429c79cc-6240-43bb-bd97-4ef675382c35" });
  runPC1Phase(db, "cycle-1", testConfig(), {});
  const action = db
    .prepare(`SELECT action_id FROM dream_actions WHERE action_type='ephemera_retire'`)
    .get() as DreamActionRow;
  revertDreamAction(db, action.action_id, "none");
  const mem = db
    .prepare(`SELECT retired_at FROM t2_memories WHERE memory_id=?`)
    .get(memId) as MemoryRetiredRow;
  expect(mem.retired_at).toBeNull();
});
