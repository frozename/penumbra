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

function makeRecallPlaybookFs(root: string, playbookName: string) {
  mkdirSync(join(root, `playbooks/${playbookName}`), { recursive: true });
  mkdirSync(join(root, 'workflows'), { recursive: true });
  writeFileSync(
    join(root, `playbooks/${playbookName}/playbook.md`),
    `---\nname: ${playbookName}\ndescription: D\ntriggers:\n  - kind: manual\nrecall:\n  - source: memory.search\n    args:\n      query: hello\n      dateStart: "{{session_start}}"\n      limit: 50\noutput:\n  - kind: clipboard\nrun:\n  kind: markdown-template\n---\nbody\n`,
  );
}

function seedMemory(
  db: ReturnType<typeof freshDb>,
  id: string,
  body: string,
  createdAt: string,
  projectId: string | null = 'unknown',
) {
  db.prepare(
    `INSERT INTO t2_memories (
       memory_id, project_id, user_id, kind, source_session_ids,
       window_start, window_end, title, body, metadata_json,
       created_at, updated_at, obs_type, concepts, severity
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, projectId, 'u1', 'observation', JSON.stringify(['s1']),
    createdAt, createdAt, body, body, '{}',
    createdAt, createdAt, 'note', JSON.stringify([]), 'low',
  );
}

test('POST /workflows/run resolves sessionStart from claude_code_sessions when session_id is provided', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wfsid-'));
  try {
    makeRecallPlaybookFs(root, 'sid');
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    db.prepare(
      `INSERT INTO claude_code_sessions (session_id, session_start_at, last_seen_at, project_id)
       VALUES (?, ?, ?, ?)`,
    ).run('sess-A', '2026-05-05T03:00:00Z', '2026-05-05T05:00:00Z', 'demo');
    seedMemory(db, 'm-old', 'hello world before', '2026-05-05T02:00:00Z');
    seedMemory(db, 'm-new', 'hello world after', '2026-05-05T04:30:00Z');
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sid', session_id: 'sess-A', cwd: root }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    // After fix: dateStart is resolved to 2026-05-05T03:00:00Z, so only m-new should match.
    // Confirm by checking workflow_stats logged itemCount of 1.
    const stats = db
      .query('SELECT samples, successes FROM workflow_stats WHERE workflow_name = ?')
      .get('sid') as { samples: number; successes: number } | undefined;
    expect(stats?.successes).toBe(1);
    const evt = db
      .query<{ payload_json: string }, []>(
        `SELECT payload_json FROM t0_events
          WHERE event_type = 'workflow.recall'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    const payload = JSON.parse(evt!.payload_json) as { item_count: number };
    expect(payload.item_count).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POST /workflows/run falls back to now-8h when session_id is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wffb-'));
  try {
    makeRecallPlaybookFs(root, 'fb');
    const reg = await buildRegistry({ playbooksDir: join(root, 'playbooks'), workflowsDir: join(root, 'workflows') });
    const db = freshDb();
    // Within 8h: should match. Outside 8h: should not.
    const now = Date.now();
    const within = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    const outside = new Date(now - 12 * 60 * 60 * 1000).toISOString(); // 12h ago
    seedMemory(db, 'm-within', 'hello recent', within);
    seedMemory(db, 'm-outside', 'hello old', outside);
    const services = { workflowRegistry: reg, db, embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: root } } as any;
    const req = new Request('http://localhost/workflows/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'fb', cwd: root }),
    });
    const res = await workflowsRunRoute(req, services);
    expect(res.status).toBe(200);
    const evt = db
      .query<{ payload_json: string }, []>(
        `SELECT payload_json FROM t0_events
          WHERE event_type = 'workflow.recall'
          ORDER BY ts DESC LIMIT 1`,
      )
      .get();
    const payload = JSON.parse(evt!.payload_json) as { item_count: number };
    expect(payload.item_count).toBe(1);
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

test('POST /workflows/trigger filters lifecycle matches by hookContext.tool_name', async () => {
  const workflowA = {
    name: 'a',
    description: 'A',
    triggers: [
      {
        kind: 'lifecycle',
        event: 'post-tool-use',
        filter: { tool_name: ['Edit'] },
      },
    ],
    recall: [],
    output: [{ kind: 'clipboard' }],
    run: { kind: 'markdown-template', template: 'A' },
  };
  const workflowB = {
    name: 'b',
    description: 'B',
    triggers: [{ kind: 'lifecycle', event: 'post-tool-use' }],
    recall: [],
    output: [{ kind: 'clipboard' }],
    run: { kind: 'markdown-template', template: 'B' },
  };
  const reg = {
    findByTrigger: () => [workflowA, workflowB],
    getEntry: () => undefined,
  } as any;
  const services = { workflowRegistry: reg, db: freshDb(), embedder: new TestEmbedder({ dim: 384 }), settings: { storageRoot: '/tmp' } } as any;

  const makeRequest = (toolName?: string | null) =>
    new Request('http://localhost/workflows/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: { kind: 'lifecycle', event: 'post-tool-use' },
        cwd: '.',
        ...(toolName === undefined ? {} : { hookContext: { tool_name: toolName } }),
      }),
    });

  const readMatched = async (req: Request) => {
    const res = await workflowsTriggerRoute(req, services);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matched: string[] };
    return body.matched;
  };

  expect(await readMatched(makeRequest('Read'))).toEqual(['b']);
  expect(await readMatched(makeRequest('Edit'))).toEqual(['a', 'b']);
  expect(await readMatched(makeRequest())).toEqual(['b']);
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
