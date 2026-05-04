import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import {
  buildRegistry,
  composeRecall,
  executeWorkflow,
  evaluateTriggerEvent,
} from '../../src/index.js';

function seedRepo(dir: string): string {
  execSync('git init -q -b main', { cwd: dir });
  execSync('git config user.email t@t', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execSync('git add . && git commit -q -m "first commit"', { cwd: dir, shell: '/bin/bash' });
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  execSync('git add . && git commit -q -m "second commit"', { cwd: dir, shell: '/bin/bash' });
  return dir;
}

test('session-handoff playbook fires on pre-compact, renders file, captures outcome', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sh-int-'));
  const repo = seedRepo(mkdtempSync(join(tmpdir(), 'sh-repo-')));
  const playbookSrc = join(import.meta.dir, '../../../../plugin/playbooks/session-handoff');
  try {
    const pbDir = join(root, 'playbooks/session-handoff');
    mkdirSync(pbDir, { recursive: true });
    writeFileSync(
      join(pbDir, 'playbook.md'),
      readFileSync(join(playbookSrc, 'playbook.md'), 'utf8'),
    );
    mkdirSync(join(root, 'workflows'), { recursive: true });

    const reg = await buildRegistry({
      playbooksDir: join(root, 'playbooks'),
      workflowsDir: join(root, 'workflows'),
    });
    expect(reg.errors).toEqual([]);
    const matched = evaluateTriggerEvent(reg, { kind: 'lifecycle', event: 'pre-compact' });
    expect(matched.map((s) => s.name)).toEqual(['session-handoff']);

    const db = new Database(':memory:');
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });

    const ts1 = '2026-05-04T10:00:00Z';
    const ts2 = '2026-05-04T11:00:00Z';
    const t2Insert = db.prepare(`
      INSERT INTO t2_memories (
        memory_id, project_id, user_id, kind,
        source_session_ids, window_start, window_end,
        title, body, metadata_json, created_at, updated_at,
        obs_type, concepts, severity
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    t2Insert.run(
      'm1', 'penumbra', 'u', 'observation',
      JSON.stringify(['s1']), ts1, ts1,
      'session kickoff notes', 'Started session work on workflow runtime', '{}', ts1, ts1,
      'session', JSON.stringify(['session']), 'low',
    );
    t2Insert.run(
      'm2', 'penumbra', 'u', 'observation',
      JSON.stringify(['s1']), ts2, ts2,
      'session midpoint review', 'Mid-session review of progress', '{}', ts2, ts2,
      'session', JSON.stringify(['session']), 'low',
    );

    db.exec(`
      INSERT INTO dispatch_events (id, handoff_id, source, kind, ts, meta_json)
      VALUES
        (1, 'h-pending-1', 'worker', 'dispatch.start', '2026-05-04T10:05:00Z', '{}'),
        (2, 'h-pending-1', 'worker', 'dispatch.end',   '2026-05-04T10:10:00Z', '{}');
    `);

    db.exec(`
      INSERT INTO handoffs (handoff_id, ts, conversation_id, from_agent, to_agent, message, status)
      VALUES
        ('h-pending-1', '2026-05-04T10:05:00Z', 'c1', 'maestro', 'worker', 'session-handoff seed message', 'pending');
    `);

    const spec = matched[0]!;
    const bundle = await composeRecall({
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      cwd: repo,
      project: 'penumbra',
      sources: spec.recall,
      budgetTokens: spec.recall_budget_tokens,
    });

    const tempOutFile = join(root, 'maestro-continuation.md');
    const patchedSpec = {
      ...spec,
      output: [
        { kind: 'file' as const, path: tempOutFile },
        { kind: 'next-session-prompt' as const },
      ],
    };

    const result = await executeWorkflow({
      spec: patchedSpec,
      bundle,
      storageRoot: root,
      captureCtx: { db, project: 'penumbra', sessionId: 's1', userId: 'u', machineId: 'm' },
    });

    expect(result.outcome).toBe('success');
    expect(existsSync(tempOutFile)).toBe(true);
    const body = readFileSync(tempOutFile, 'utf8');
    expect(body).toContain('Maestro continuation prompt');
    expect(body).toContain('second commit');
    expect(body).toContain('h-pending-1');

    const stats = db
      .query("SELECT samples, successes FROM workflow_stats WHERE workflow_name='session-handoff'")
      .get() as { samples: number; successes: number };
    expect(stats.samples).toBe(1);
    expect(stats.successes).toBe(1);

    const events = db
      .query("SELECT event_type FROM t0_events WHERE event_type LIKE 'workflow.%' ORDER BY ts")
      .all() as Array<{ event_type: string }>;
    expect(events.map((e) => e.event_type)).toEqual([
      'workflow.run',
      'workflow.recall',
      'workflow.outcome',
    ]);

    expect(existsSync(join(root, 'pending-handoff.md'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
