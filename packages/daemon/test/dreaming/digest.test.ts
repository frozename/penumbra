import { expect, it, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSqliteVec, applySchema } from '@penumbra/core';
import { writeDailyDigest } from '../../src/dreaming/digest.js';

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

function seedCycle(db: Database, cycleId: string, startedAt?: number): void {
  db.prepare(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap, outcome, phases_run)
     VALUES(?, ?, 'cron', 1.0, 'completed', '[]')`,
  ).run(cycleId, startedAt ?? Date.now());
}

function appendDreamAction(
  db: Database,
  opts: {
    cycleId: string;
    phase: string;
    actionType: string;
    status: string;
    confidence: number;
    targetIds: string[];
    untrustedSource: number;
  },
): void {
  db.prepare(
    `INSERT INTO dream_actions(action_id, cycle_id, phase, action_type, confidence, status, target_ids, payload_json, untrusted_source)
     VALUES(?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(
    crypto.randomUUID(),
    opts.cycleId,
    opts.phase,
    opts.actionType,
    opts.confidence,
    opts.status,
    JSON.stringify(opts.targetIds),
    opts.untrustedSource,
  );
}

it('writeDailyDigest writes only queued actions and flags untrusted rows', async () => {
  const db = openTestDb();
  const outDir = mkdtempSync(join(tmpdir(), 'penumbra-digest-test-'));

  try {
    seedCycle(db, 'C1');
    seedCycle(db, 'C2');
    seedCycle(db, 'C3');

    // 2 queued actions (one untrusted)
    appendDreamAction(db, {
      cycleId: 'C1',
      phase: 'P3',
      actionType: 'rewrite',
      status: 'queued',
      confidence: 0.7,
      targetIds: ['m1'],
      untrustedSource: 0,
    });
    appendDreamAction(db, {
      cycleId: 'C2',
      phase: 'P4',
      actionType: 'resolve_contradiction',
      status: 'queued',
      confidence: 0.85,
      targetIds: ['m2', 'm3'],
      untrustedSource: 1,
    });
    // 1 auto_applied — must NOT appear in digest
    appendDreamAction(db, {
      cycleId: 'C3',
      phase: 'P2',
      actionType: 'link',
      status: 'auto_applied',
      confidence: 0.95,
      targetIds: ['m4'],
      untrustedSource: 0,
    });

    const filepath = await writeDailyDigest(db, outDir);

    // file exists at expected path
    const today = new Date();
    const dateStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-');
    expect(filepath).toContain(`dream-digest-${dateStr}.md`);

    const content = readFileSync(filepath, 'utf8');

    // contains only the 2 queued rows
    expect(content).toContain('rewrite');
    expect(content).toContain('resolve_contradiction');
    expect(content).not.toContain('auto_applied');
    expect(content).not.toContain('link');

    // untrusted row is visually flagged
    expect(content).toContain('[UNTRUSTED]');

    // trusted row does NOT have the flag
    const lines = content.split('\n').filter((l) => l.includes('rewrite'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).not.toContain('[UNTRUSTED]');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
