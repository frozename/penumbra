import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServices, loadSqliteVec, migrate } from '../../src/index.js';
import { validateBasis } from '../../src/memory-verify/basis.js';
import { TestEmbedder } from '../../src/testing/index.js';

function freshServices() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), 'memory-basis-'));
  const reviewsDir = join(root, '.penumbra', 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: join(root, 'storage'),
    reviewsDir,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    mainRepoDir: process.cwd(),
    worktreeRootDir: join(root, 'worktrees'),
  });
  return { db, root, reviewsDir, services, stop: () => rmSync(root, { recursive: true, force: true }) };
}

function seedHandoff(db: Database, handoffId: string, fromAgent: string, toAgent: string, taskType: string): void {
  db.run(
    `INSERT INTO handoffs(handoff_id, ts, conversation_id, from_agent, to_agent, message, status, chain_task_type)
     VALUES (?, '2026-05-17T12:00:00.000Z', ?, ?, ?, 'prompt', 'dispatched', ?)`,
    [handoffId, `c-${handoffId}`, fromAgent, toAgent, taskType],
  );
}

test('validateBasis accepts lane_close bases when the lane is closed and reviewer differs', async () => {
  const ctx = freshServices();
  try {
    ctx.db.run(
      `INSERT INTO lane_ledger(lane_id, ts_opened, ts_closed, task_class, implementer_handoff, reviewer_handoff, gate_status)
       VALUES ('lane-1', '2026-05-17T10:00:00.000Z', '2026-05-17T11:00:00.000Z', 'implement', 'h-impl', 'h-review', 'closed')`,
    );
    const result = await validateBasis(ctx.services, {
      kind: 'lane_close',
      lane_id: 'lane-1',
      reviewer_handoff: 'h-review',
    });
    expect(result).toEqual({ ok: true });
  } finally {
    ctx.stop();
  }
});

test('validateBasis accepts dispatch_land bases when the commit exists', async () => {
  const ctx = freshServices();
  try {
    seedHandoff(ctx.db, 'h-review', 'h-impl', 'h-review', 'review_adversarial');
    const result = await validateBasis(ctx.services, {
      kind: 'dispatch_land',
      merge_commit: 'f128dd9',
      reviewer_handoff: 'h-review',
    });
    expect(result).toEqual({ ok: true });
  } finally {
    ctx.stop();
  }
});

test('validateBasis rejects adversarial_review traversal via ..', async () => {
  const ctx = freshServices();
  try {
    const result = await validateBasis(ctx.services, {
      kind: 'adversarial_review',
      synthesis_path: '../escape.md',
      synthesizer_handoff: 'h-synth',
    });
    expect(result).toEqual({ ok: false, status: 400, reason: 'synthesis_path contains traversal' });
  } finally {
    ctx.stop();
  }
});

test('validateBasis rejects adversarial_review traversal via absolute path outside reviews dir', async () => {
  const ctx = freshServices();
  try {
    const result = await validateBasis(ctx.services, {
      kind: 'adversarial_review',
      synthesis_path: '/tmp/outside.md',
      synthesizer_handoff: 'h-synth',
    });
    expect(result).toEqual({ ok: false, status: 400, reason: expect.any(String) });
  } finally {
    ctx.stop();
  }
});

test('validateBasis rejects adversarial_review symlink escapes', async () => {
  const ctx = freshServices();
  try {
    const outside = join(ctx.root, 'outside.md');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(ctx.reviewsDir, 'link.md'));
    const result = await validateBasis(ctx.services, {
      kind: 'adversarial_review',
      synthesis_path: 'link.md',
      synthesizer_handoff: 'h-synth',
    });
    expect(result).toEqual({ ok: false, status: 400, reason: expect.stringContaining('escapes') });
  } finally {
    ctx.stop();
  }
});
