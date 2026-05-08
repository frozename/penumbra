import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServices, loadSqliteVec, migrate, type Services } from '../../../core/src/index.js';
import { TestEmbedder } from '../../../core/src/testing/index.js';
import { createDaemonFetchHandler } from '../../src/serve.js';
import type { GhClient } from '../../src/services/gh-client.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

function startTestDaemon(opts: { ghClient?: GhClient } = {}): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  token: string;
  stop: () => void;
} {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const root = mkdtempSync(join(tmpdir(), 'tasks-route-'));
  const worktreeRootDir = join(root, 'worktrees');
  const mainRepoDir = join(root, 'main');
  mkdirSync(worktreeRootDir, { recursive: true });
  mkdirSync(mainRepoDir, { recursive: true });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-23T12:00:00.000Z'),
    worktreeRootDir,
    mainRepoDir,
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };

  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: [{ name: 'codex', tags: ['typescript'], tier: 'oc', cost_cents_per_run: 15 }],
  };

  const token = 'tok';
  const handler = createDaemonFetchHandler({ services, token, ghClient: opts.ghClient });

  return {
    fetch: (path, init) => handler(new Request(`http://x${path}`, init)),
    services,
    token,
    stop: () => {
      try { services.supervisor.stopAll(); } catch {}
      try { db.close(); } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('POST /tasks with gh_create queues github issue creation and returns queued status', async () => {
  const createCalls: Array<{
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }> = [];
  const daemon = startTestDaemon({
    ghClient: {
      viewIssue: async () => {
        throw new Error('not used');
      },
      closeIssue: async () => {
        throw new Error('not used');
      },
      reopenIssue: async () => {
        throw new Error('not used');
      },
      createIssue: async (input) => {
        createCalls.push(input);
        return {
          number: 42,
          url: 'https://github.com/acordeiro/penumbra/issues/42',
        };
      },
    },
  });
  try {
    const create = await postJson(daemon, '/tasks', {
      prompt: 'build task board route',
      created_by_kind: 'human',
      created_by_id: 'cli',
      gh_create: {
        repo: 'acordeiro/penumbra',
        labels: ['tasks'],
      },
    });
    expect(create.status).toBe(201);
    const created = await create.json() as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
      gh_issue_url?: string;
      gh_issue_number?: number;
      gh_issue_repo?: string;
    };
    expect(created.gh_create_status).toBe('queued');
    expect(created.gh_create_error).toBeNull();
    expect(created.gh_issue_url).toBeUndefined();
    expect(created.gh_issue_number).toBeUndefined();
    expect(created.gh_issue_repo).toBeUndefined();
    expect(createCalls).toEqual([]);

    const get = await daemon.fetch(`/tasks/${created.task_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = await get.json() as {
      gh_issue_number: number | null;
      gh_issue_repo: string | null;
      gh_create_status?: string;
      gh_create_error?: string | null;
    };
    expect(task.gh_issue_number).toBeNull();
    expect(task.gh_issue_repo).toBeNull();
    expect(task.gh_create_status).toBe('queued');
    expect(task.gh_create_error).toBeNull();
  } finally {
    daemon.stop();
  }
});

test('POST /tasks with gh_create remains success even when GH would fail later', async () => {
  const daemon = startTestDaemon({
    ghClient: {
      viewIssue: async () => {
        throw new Error('not used');
      },
      closeIssue: async () => {
        throw new Error('not used');
      },
      reopenIssue: async () => {
        throw new Error('not used');
      },
      createIssue: async () => {
        throw new Error('gh create failed');
      },
    },
  });
  try {
    const create = await postJson(daemon, '/tasks', {
      prompt: 'build task board route',
      created_by_kind: 'human',
      created_by_id: 'cli',
      gh_create: {
        repo: 'acordeiro/penumbra',
      },
    });
    expect(create.status).toBe(201);
    const created = await create.json() as {
      task_id: string;
      gh_create_status?: string;
      gh_create_error?: string;
      gh_issue_url?: string;
      gh_issue_number?: number;
      gh_issue_repo?: string;
    };
    expect(typeof created.task_id).toBe('string');
    expect(created.gh_create_status).toBe('queued');
    expect(created.gh_create_error).toBeNull();
    expect(created.gh_issue_url).toBeUndefined();
    expect(created.gh_issue_number).toBeUndefined();
    expect(created.gh_issue_repo).toBeUndefined();

    const get = await daemon.fetch(`/tasks/${created.task_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = await get.json() as {
      gh_issue_number: number | null;
      gh_issue_repo: string | null;
      gh_create_status?: string;
      gh_create_error?: string | null;
    };
    expect(task.gh_issue_number).toBeNull();
    expect(task.gh_issue_repo).toBeNull();
    expect(task.gh_create_status).toBe('queued');
    expect(task.gh_create_error).toBeNull();
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/comment-gh posts manual comment for linked task', async () => {
  const comments: string[] = [];
  const daemon = startTestDaemon({
    ghClient: {
      createIssue: async () => ({ number: 99, url: 'https://github.com/acordeiro/penumbra/issues/99' }),
      viewIssue: async () => ({
        number: 99,
        state: 'OPEN',
        stateReason: null,
        updatedAt: '2026-05-08T00:00:00.000Z',
        title: 'Issue 99',
        url: 'https://github.com/acordeiro/penumbra/issues/99',
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async (_repo, _issue, body) => {
        comments.push(body);
        return { comment_url: 'https://github.com/acordeiro/penumbra/issues/99#issuecomment-999' };
      },
      listComments: async () => [],
      getAuthenticatedLogin: async () => 'penumbra-bot',
    },
  });

  try {
    const create = await postJson(daemon, '/tasks', {
      prompt: 'manual note test',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });
    const created = await create.json() as { task_id: string };

    const link = await postJson(daemon, `/tasks/${created.task_id}/link-gh`, {
      repo: 'acordeiro/penumbra',
      issue_number: 99,
    });
    expect(link.status).toBe(200);

    const comment = await postJson(daemon, `/tasks/${created.task_id}/comment-gh`, {
      body: 'please check this edge case',
    });
    expect(comment.status).toBe(200);
    const payload = await comment.json() as { comment_url: string };
    expect(payload.comment_url).toContain('issuecomment');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain('manual note');
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/comment-gh returns 503 when github client is unavailable', async () => {
  const daemon = startTestDaemon({
    ghClient: {
      createIssue: async () => ({ number: 101, url: 'https://github.com/acordeiro/penumbra/issues/101' }),
      viewIssue: async () => ({
        number: 101,
        state: 'OPEN',
        stateReason: null,
        updatedAt: '2026-05-08T00:00:00.000Z',
        title: 'Issue 101',
        url: 'https://github.com/acordeiro/penumbra/issues/101',
      }),
      closeIssue: async () => {},
      reopenIssue: async () => {},
      commentIssue: async () => {
        throw new Error('github client unavailable');
      },
      listComments: async () => [],
      getAuthenticatedLogin: async () => null,
    },
  });

  try {
    const create = await postJson(daemon, '/tasks', {
      prompt: 'manual note unavailable path',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });
    const created = await create.json() as { task_id: string };

    const link = await postJson(daemon, `/tasks/${created.task_id}/link-gh`, {
      repo: 'acordeiro/penumbra',
      issue_number: 101,
    });
    expect(link.status).toBe(200);

    const comment = await postJson(daemon, `/tasks/${created.task_id}/comment-gh`, {
      body: 'status ping',
    });
    expect(comment.status).toBe(503);
    const payload = await comment.json() as { error: string };
    expect(payload.error).toBe('github_client_unavailable');
  } finally {
    daemon.stop();
  }
});

function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    ...headers,
  };
}

async function postJson(
  daemon: ReturnType<typeof startTestDaemon>,
  path: string,
  body: unknown,
  headers: HeadersInit = {},
): Promise<Response> {
  return daemon.fetch(path, {
    method: 'POST',
    headers: authHeaders(daemon.token, {
      'content-type': 'application/json',
      ...headers,
    }),
    body: JSON.stringify(body),
  });
}

async function fileTask(daemon: ReturnType<typeof startTestDaemon>, body: Record<string, unknown> = {}): Promise<string> {
  const res = await postJson(daemon, '/tasks', {
    prompt: 'implement route',
    created_by_kind: 'human',
    created_by_id: 'cli',
    ...body,
  });
  expect(res.status).toBe(201);
  const json = await res.json() as { task_id: string };
  return json.task_id;
}

test('POST /tasks returns 201 {task_id} and GET /tasks/:id returns the row', async () => {
  const daemon = startTestDaemon();
  try {
    const create = await postJson(
      daemon,
      '/tasks',
      {
        prompt: 'build task board route',
        created_by_kind: 'human',
        created_by_id: 'cli',
      },
      { 'x-penumbra-origin': 'http-test' },
    );
    expect(create.status).toBe(201);
    const created = await create.json() as { task_id: string };

    const get = await daemon.fetch(`/tasks/${created.task_id}`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = await get.json() as { id: string; prompt: string; origin: string | null };
    expect(task.id).toBe(created.task_id);
    expect(task.prompt).toBe('build task board route');
    expect(task.origin).toBe('http-test');
  } finally {
    daemon.stop();
  }
});

test('GET /tasks?status=pending lists the filed task', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const res = await daemon.fetch('/tasks?status=pending', {
      headers: authHeaders(daemon.token),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: Array<{ id: string; status: string }> };
    expect(body.tasks.some((task) => task.id === taskId && task.status === 'pending')).toBe(true);
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/lease leases a task and GET /tasks/:id?include=lease shows the open lease', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { task_id: string; lease_id: string };
    expect(leased.task_id).toBe(taskId);

    const get = await daemon.fetch(`/tasks/${taskId}?include=lease`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = await get.json() as { status: string; lease: { id: string; agent_id: string } | null };
    expect(task.status).toBe('leased');
    expect(task.lease?.id).toBe(leased.lease_id);
    expect(task.lease?.agent_id).toBe('codex');
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/heartbeat bumps expires_at', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { lease_id: string; expires_at: number };

    (daemon.services as any).clock = () => new Date('2026-04-23T12:00:10.000Z');

    const hb = await postJson(daemon, `/tasks/${taskId}/heartbeat`, {
      lease_id: leased.lease_id,
    });
    expect(hb.status).toBe(200);
    const body = await hb.json() as { expires_at: number };
    expect(body.expires_at).toBeGreaterThan(leased.expires_at);
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/complete transitions to done when review is not required', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: 'implemented',
    });
    expect(complete.status).toBe(200);
    const body = await complete.json() as { status: string };
    expect(body.status).toBe('done');

    const get = await daemon.fetch(`/tasks/${taskId}`, {
      headers: authHeaders(daemon.token),
    });
    const task = await get.json() as { status: string; result_summary: string | null };
    expect(task.status).toBe('done');
    expect(task.result_summary).toBe('implemented');
  } finally {
    daemon.stop();
  }
});

test('requires_review flow files a child review task visible via descendants include', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon, { requires_review: true });
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: 'ready for review',
    });
    expect(complete.status).toBe(200);

    const get = await daemon.fetch(`/tasks/${taskId}?include=descendants`, {
      headers: authHeaders(daemon.token),
    });
    expect(get.status).toBe(200);
    const task = await get.json() as {
      status: string;
      descendants?: { count: number; ids: string[] };
    };
    expect(task.status).toBe('done_pending_review');
    expect(task.descendants?.count).toBe(1);
    expect(task.descendants?.ids).toHaveLength(1);
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/cancel transitions pending task to cancelled', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const cancel = await postJson(daemon, `/tasks/${taskId}/cancel`, { reason: 'no longer needed' });
    expect(cancel.status).toBe(200);
    const body = await cancel.json() as { status: string };
    expect(body.status).toBe('cancelled');

    const get = await daemon.fetch(`/tasks/${taskId}`, {
      headers: authHeaders(daemon.token),
    });
    const task = await get.json() as { status: string };
    expect(task.status).toBe('cancelled');
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/fail releases lease and transitions to failed', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { lease_id: string };

    const fail = await postJson(daemon, `/tasks/${taskId}/fail`, {
      lease_id: leased.lease_id,
      reason: 'tool crashed',
    });
    expect(fail.status).toBe(200);
    const body = await fail.json() as { status: string };
    expect(body.status).toBe('failed');

    const get = await daemon.fetch(`/tasks/${taskId}?include=lease`, {
      headers: authHeaders(daemon.token),
    });
    const task = await get.json() as { status: string; lease: unknown };
    expect(task.status).toBe('failed');
    expect(task.lease).toBeNull();
  } finally {
    daemon.stop();
  }
});

test('POST /tasks with empty prompt returns 400', async () => {
  const daemon = startTestDaemon();
  try {
    const res = await postJson(daemon, '/tasks', {
      prompt: '',
      created_by_kind: 'human',
      created_by_id: 'cli',
    });
    expect(res.status).toBe(400);
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/cancel on a done task returns 409', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: 'done',
    });
    expect(complete.status).toBe(200);

    const cancel = await postJson(daemon, `/tasks/${taskId}/cancel`, { reason: 'too late' });
    expect(cancel.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/:id/heartbeat with stale lease returns 409', async () => {
  const daemon = startTestDaemon();
  try {
    const taskId = await fileTask(daemon);
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(200);
    const leased = await lease.json() as { lease_id: string };

    const complete = await postJson(daemon, `/tasks/${taskId}/complete`, {
      lease_id: leased.lease_id,
      result_summary: 'done',
    });
    expect(complete.status).toBe(200);

    const hb = await postJson(daemon, `/tasks/${taskId}/heartbeat`, {
      lease_id: leased.lease_id,
    });
    expect(hb.status).toBe(409);
  } finally {
    daemon.stop();
  }
});

test('POST /tasks/lease with no tasks returns 204', async () => {
  const daemon = startTestDaemon();
  try {
    const lease = await postJson(daemon, '/tasks/lease', { agent_id: 'codex' });
    expect(lease.status).toBe(204);
  } finally {
    daemon.stop();
  }
});
