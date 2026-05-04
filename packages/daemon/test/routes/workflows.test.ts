import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  workflowsListRoute,
  workflowsRunRoute,
  workflowsTriggerRoute,
  workflowsHistoryRoute,
  workflowsSuggestRoute,
} from '../../src/routes/workflows.js';
import { buildRegistry } from '../../../workflows/src/registry.js';
import { composeRecall } from '@penumbra/workflows';
import { loadSqliteVec, migrate } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';

if (process.platform === 'darwin') {
  try { Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}
}

function freshDb() {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

async function setupReg() {
  const root = mkdtempSync(join(tmpdir(), 'wfd-'));
  mkdirSync(join(root, 'playbooks/x'), { recursive: true });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  writeFileSync(
    join(root, 'playbooks/x/playbook.md'),
    `---\nname: x\ndescription: D\ntriggers:\n  - kind: manual\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
  );
  const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
  return { reg, root };
}

test('GET /workflows/list returns registry list', async () => {
  const { reg, root } = await setupReg();
  try {
    const services = { workflowRegistry: reg } as any;
    const req = new Request('http://localhost/workflows/list');
    const res = await workflowsListRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workflows: Array<{ name: string; description: string }> };
    expect(body.workflows.map((w) => w.name)).toEqual(['x']);
    expect(body.workflows[0].description).toBe('D');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST /workflows/run executes a registered workflow', async () => {
  const { reg, root } = await setupReg();
  try {
    const db = freshDb();
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; composedPrompt: string };
    expect(body.outcome).toBe('success');
    expect(body.composedPrompt).toContain('body');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('composeRecall resolves {{today}} when templateCtx is provided', async () => {
  const db = freshDb();
  const bundle = await composeRecall({
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    cwd: process.cwd(),
    project: 'p',
    sources: [{ source: 'memory.search', args: { query: 'q', dateStart: '{{today}}', limit: 1 } }],
    templateCtx: {
      now: () => new Date('2026-05-04T12:00:00Z'),
      project: 'p',
      sessionStart: '2026-05-04T10:00:00Z',
      tz: 'UTC',
    },
  });

  expect(bundle.warnings.find((w) => w.includes('{{today}}'))).toBeUndefined();
});

test('POST /workflows/run unknown name → 404', async () => {
  const { reg, root } = await setupReg();
  try {
    const services = { workflowRegistry: reg, db: freshDb(), embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(404);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /workflows/trigger runs session-reminder sinks inline and returns additionalContext', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfsr-'));
  try {
    mkdirSync(join(root, 'playbooks/sr'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/sr/playbook.md'),
      `---\nname: sr\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall: []\noutput:\n  - kind: session-reminder\nrun:\n  kind: markdown-template\n---\nremind body\n`,
    );
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/trigger', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'lifecycle', event: 'session-start' }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[]; additionalContext: string | null };
    expect(body.matched).toEqual(['sr']);
    expect(body.additionalContext).toContain('remind body');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /workflows/trigger without session-reminder sinks returns null additionalContext', async () => {
  const { reg, root } = await setupReg();
  try {
    mkdirSync(join(root, 'playbooks/lt2'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/lt2/playbook.md'),
      `---\nname: lt2\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: session-start\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
    );
    const reg2 = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    const services = { workflowRegistry: reg2, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/trigger', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'lifecycle', event: 'session-start' }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[]; additionalContext: string | null };
    expect(body.matched).toEqual(['lt2']);
    expect(body.additionalContext).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /workflows/trigger fires lifecycle event and returns matched names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wft-'));
  try {
    mkdirSync(join(root, 'playbooks/lt'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/lt/playbook.md'),
      `---\nname: lt\ndescription: D\ntriggers:\n  - kind: lifecycle\n    event: pre-compact\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nlife body\n`,
    );
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/trigger', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { kind: 'lifecycle', event: 'pre-compact' }, cwd: root }),
    });
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[] };
    expect(body.matched).toEqual(['lt']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GET /workflows/history returns workflow_stats row', async () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO workflow_stats (workflow_name, samples, successes, failures, avg_latency_ms, last_run_at, consecutive_failures, quarantined)
    VALUES ('demo', 5, 4, 1, 200, '2026-05-04T15:00:00Z', 0, 0);
  `);
  const services = { db } as any;
  const req = new Request('http://localhost/workflows/history?name=demo');
  const res = await workflowsHistoryRoute(req, services);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { stats: any; recent: any[] };
  expect(body.stats.samples).toBe(5);
});

test('POST /workflows/suggest returns workflows matching state thresholds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfs-'));
  try {
    mkdirSync(join(root, 'playbooks/idle'), { recursive: true });
    mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(
      join(root, 'playbooks/idle/playbook.md'),
      `---\nname: idle\ndescription: D\ntriggers:\n  - kind: state-threshold\n    metric: queue-idle-min\n    op: ">"\n    value: 20\nrecall: []\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nidle body\n`,
    );
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    const services = { workflowRegistry: reg, db } as any;
    const req = new Request('http://localhost/workflows/suggest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: '2026-05-04T15:00:00Z' }),
    });
    const res = await workflowsSuggestRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<{ name: string }>; metrics: Record<string, number> };
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.metrics['queue-idle-min']).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
