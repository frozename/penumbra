import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { workflowsListRoute, workflowsRunRoute } from '../../src/routes/workflows.js';
import { buildRegistry } from '../../../workflows/src/registry.js';
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
