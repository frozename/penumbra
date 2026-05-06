import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { TaskWriter } from '../../../core/src/tasks/writer.js';
import { TaskEventBus } from '../../../core/src/tasks/event-bus.js';
import { createDaemonFetchHandler } from '../../src/serve.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function startTestDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  taskWriter: TaskWriter;
  root: string;
  stop: () => void;
} {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), 'plans-route-'));
  const worktreeRootDir = join(root, 'worktrees');
  const mainRepoDir = join(root, 'main');
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const projectRegistry = new ProjectRegistry(
    new Map([
      ['penumbra', { project_id: 'penumbra', root_path: root }],
      ['other', { project_id: 'other', root_path: root }],
    ]),
  );

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-05T12:00:00.000Z'),
    worktreeRootDir,
    mainRepoDir,
    projectRegistry,
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };

  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: [
      { name: 'claude-acp-sonnet', tags: ['typescript'], tier: 'cli', cost_cents_per_run: 50 },
      { name: 'codex-acp-fast', tags: ['typescript'], tier: 'cli', cost_cents_per_run: 30 },
    ],
  };

  const taskEvents = new TaskEventBus();
  const taskWriter = new TaskWriter(db, {
    now: () => services.clock().getTime(),
    bus: taskEvents,
  });

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token, taskEvents, taskWriter });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    taskWriter,
    root,
    stop: () => {
      try { services.supervisor.stopAll(); } catch {}
      try { db.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function authHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

function fixturePlan(opts: { home_project?: string; tasks?: Array<{ id: string; project?: string }> } = {}): string {
  const home = opts.home_project ?? 'penumbra';
  const tasks = opts.tasks ?? [
    { id: '1.1' },
    { id: '1.2' },
  ];
  const header = `---\nplan_id: ignored-by-server\nhome_project: ${home}\n---\n\n# Plan\n\n`;
  const taskBlocks = tasks
    .map((t) => {
      const projectLine = t.project ? `project: ${t.project}\n` : '';
      return [
        '```yaml meta',
        `id: '${t.id}'`,
        'files:',
        `  - notes/${t.id}.md`,
        'file_scope: new',
        projectLine.trimEnd(),
        'depends_on: []',
        'parallel_with: []',
        'preferred_agent: claude-acp-sonnet',
        'fallback_agent: codex-acp-fast',
        'task_size: small',
        'risk_class: paste-ready',
        '```',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
  return header + taskBlocks + '\n';
}

function writePlanFile(root: string, name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

test('POST /plans registers a plan and GET /plans/:plan_id returns plan + tasks', async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(daemon.root, 'plan-a.md', fixturePlan());

    const create = await daemon.fetch('/plans', {
      method: 'POST',
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ file_path: planPath }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { plan_id: string; status: string };
    expect(created.status).toBe('running');
    expect(created.plan_id).toMatch(/^[0-9a-f]{12}-\d+$/);

    const get = await daemon.fetch(`/plans/${created.plan_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const body = await get.json() as { plan: any; tasks: any[] };
    expect(body.plan.plan_id).toBe(created.plan_id);
    expect(body.plan.home_project).toBe('penumbra');
    expect(body.plan.status).toBe('running');
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].status).toBe('pending');
    expect(body.tasks[0].task_id_in_board).toBeNull();
  } finally {
    daemon.stop();
  }
});

test('GET /plans filters by status', async () => {
  const daemon = startTestDaemon();
  try {
    const p1 = writePlanFile(daemon.root, 'plan-1.md', fixturePlan({ tasks: [{ id: '1.1' }] }));
    const p2 = writePlanFile(daemon.root, 'plan-2.md', fixturePlan({ tasks: [{ id: '2.1' }] }));

    for (const p of [p1, p2]) {
      const res = await daemon.fetch('/plans', {
        method: 'POST',
        headers: authJsonHeaders(daemon.token),
        body: JSON.stringify({ file_path: p }),
      });
      expect(res.status).toBe(201);
    }

    const all = await daemon.fetch('/plans', { headers: authHeaders(daemon.token) });
    expect(all.status).toBe(200);
    const allBody = await all.json() as { plans: Array<{ plan_id: string }> };
    expect(allBody.plans).toHaveLength(2);

    const running = await daemon.fetch('/plans?status=running', { headers: authHeaders(daemon.token) });
    expect(running.status).toBe(200);
    const runningBody = await running.json() as { plans: any[] };
    expect(runningBody.plans).toHaveLength(2);

    const completed = await daemon.fetch('/plans?status=completed', { headers: authHeaders(daemon.token) });
    expect(completed.status).toBe(200);
    const completedBody = await completed.json() as { plans: any[] };
    expect(completedBody.plans).toHaveLength(0);

    const bogus = await daemon.fetch('/plans?status=does-not-exist', { headers: authHeaders(daemon.token) });
    expect(bogus.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test('GET /plans/:plan_id hydrates bound task_id_in_board + status=running', async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(daemon.root, 'plan-bind.md', fixturePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] }));
    const create = await daemon.fetch('/plans', {
      method: 'POST',
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ file_path: planPath }),
    });
    expect(create.status).toBe(201);
    const { plan_id } = await create.json() as { plan_id: string };

    daemon.services.planWriter.bindTaskToBoard(plan_id, '1.1', 'task-board-aaa');

    const get = await daemon.fetch(`/plans/${plan_id}`, { headers: authHeaders(daemon.token) });
    const body = await get.json() as { tasks: Array<{ task_meta_id: string; task_id_in_board: string | null; status: string }> };
    const bound = body.tasks.find((t) => t.task_meta_id === '1.1')!;
    expect(bound.task_id_in_board).toBe('task-board-aaa');
    expect(bound.status).toBe('running');
    const unbound = body.tasks.find((t) => t.task_meta_id === '1.2')!;
    expect(unbound.task_id_in_board).toBeNull();
    expect(unbound.status).toBe('pending');
  } finally {
    daemon.stop();
  }
});

test('POST /plans/:plan_id/cancel flips plan status and cancels running children', async () => {
  const daemon = startTestDaemon();
  try {
    const planPath = writePlanFile(daemon.root, 'plan-cancel.md', fixturePlan({ tasks: [{ id: '1.1' }, { id: '1.2' }] }));
    const create = await daemon.fetch('/plans', {
      method: 'POST',
      headers: authJsonHeaders(daemon.token),
      body: JSON.stringify({ file_path: planPath }),
    });
    expect(create.status).toBe(201);
    const { plan_id } = await create.json() as { plan_id: string };

    const filed = daemon.taskWriter.file({
      prompt: 'simulated child task',
      created_by_kind: 'workflow',
      created_by_id: 'plan-runtime',
    });

    daemon.services.planWriter.bindTaskToBoard(plan_id, '1.1', filed.task_id);

    const cancel = await daemon.fetch(`/plans/${plan_id}/cancel`, {
      method: 'POST',
      headers: authHeaders(daemon.token),
    });
    expect(cancel.status).toBe(200);
    const cancelBody = await cancel.json() as {
      plan_id: string;
      status: string;
      cancelled_running_count: number;
    };
    expect(cancelBody.status).toBe('cancelled');
    expect(cancelBody.cancelled_running_count).toBe(1);

    const after = daemon.services.planWriter.getPlan(plan_id)!;
    expect(after.status).toBe('cancelled');

    const childTask = daemon.taskWriter.get(filed.task_id);
    expect(childTask.status).toBe('cancelled');

    const ghost = await daemon.fetch('/plans/no-such-plan/cancel', {
      method: 'POST',
      headers: authHeaders(daemon.token),
    });
    expect(ghost.status).toBe(404);
  } finally {
    daemon.stop();
  }
});
