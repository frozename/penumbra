import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '../../../daemon/src/serve.js';
import { runMaestroList, runMaestroSessionGet, runMaestroSessionStart } from '../../src/commands/maestro.js';
import { runTaskNew, runTaskShow } from '../../src/commands/task.js';

try {
  if (process.platform === 'darwin') {
    Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
  }
} catch {}

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function setupDaemon(): {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  stop: () => void;
} {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  root = mkdtempSync(join(tmpdir(), 'penumbra-maestro-cli-'));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-05-05T12:00:00.000Z'),
  });
  (services as Services & { agentchatConfig?: any }).agentchatConfig = {
    agents: [{ name: 'stub-maestro', adapter: 'noop', options: {}, maestro_capable: true, roles: [] }],
    default_roles: {},
  };
  const handler = createDaemonFetchHandler({ services, token: 'tok' });
  return {
    fetch: (path, init = {}) => handler(new Request(`http://x${path}`, {
      ...init,
      headers: {
        authorization: 'Bearer tok',
        ...(init.headers ?? {}),
      },
    })),
    stop: () => {
      try { services.supervisor.stopAll(); } catch {}
      try { db.close(); } catch {}
    },
  };
}

test('task new --kind orchestrate happy path stores orchestrate kind', async () => {
  const daemon = setupDaemon();
  try {
    const created: string[] = [];
    await runTaskNew({
      prompt: 'foo',
      kind: 'orchestrate',
      allow_agents: ['stub-maestro'],
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => created.push(line),
    });
    expect(created[0]).toMatch(/^task_/);

    const listed: string[] = [];
    await runTaskShow({
      id: created[0]!,
      json: true,
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => listed.push(line),
    });
    expect(JSON.parse(listed.join('\n')).kind).toBe('orchestrate');
  } finally {
    daemon.stop();
  }
});

test('task new --kind orchestrate without --allow-agent fails locally', async () => {
  await expect(runTaskNew({
    prompt: 'foo',
    kind: 'orchestrate',
    storageRoot: root,
  })).rejects.toThrow('kind=orchestrate requires at least one --allow-agent');
});

test('task show and maestro list render maestro session information', async () => {
  const daemon = setupDaemon();
  try {
    const created: string[] = [];
    await runTaskNew({
      prompt: 'foo',
      kind: 'orchestrate',
      allow_agents: ['stub-maestro'],
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => created.push(line),
    });
    const taskId = created[0]!;

    const shown: string[] = [];
    await runTaskShow({
      id: taskId,
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (String(path).startsWith('/maestro/sessions/')) {
          return Response.json({
            task_id: taskId,
            agent_id: 'stub-maestro',
            chain_handoff_id: 'chain-123456',
            started_at: Date.now() - 120_000,
            consumed_wall_clock_ms: 120_000,
            wall_clock_budget_ms: 1_800_000,
            consumed_cost_cents: 20,
            cost_budget_cents: 200,
            consumed_sub_dispatches: 2,
            sub_dispatch_budget: 10,
            warned_at: null,
            terminated_at: null,
            terminated_reason: null,
          });
        }
        return daemon.fetch(path, init);
      },
      print: (line) => shown.push(line),
    });
    expect(shown.join('\n')).toContain('Maestro session');

    const table: string[] = [];
    await runMaestroList({
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (String(path).startsWith('/maestro/sessions/')) {
          return Response.json({
            task_id: taskId,
            agent_id: 'stub-maestro',
            chain_handoff_id: 'chain-123456',
            started_at: Date.now() - 120_000,
            consumed_wall_clock_ms: 120_000,
            wall_clock_budget_ms: 1_800_000,
            consumed_cost_cents: 20,
            cost_budget_cents: 200,
            consumed_sub_dispatches: 2,
            sub_dispatch_budget: 10,
            warned_at: null,
            terminated_at: null,
            terminated_reason: null,
          });
        }
        return daemon.fetch(path, init);
      },
      print: (line) => table.push(line),
    });
    expect(table.join('\n')).toContain('wall_clock_pct');
    expect(table.join('\n')).toContain(taskId.slice(0, 8));

    const json: string[] = [];
    await runMaestroList({
      json: true,
      storageRoot: root,
      fetch: daemon.fetch,
      print: (line) => json.push(line),
    });
    expect(() => JSON.parse(json.join('\n'))).not.toThrow();
  } finally {
    daemon.stop();
  }
});

test('task show renders maestro session budgets from canonical fields', async () => {
  const daemon = setupDaemon();
  try {
    const taskId = 'task-render';
    const completed: string[] = [];
    await runTaskShow({
      id: taskId,
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (String(path).startsWith('/tasks/task-render?')) {
          return Response.json({
            id: taskId,
            created_at: Date.now() - 240_000,
            updated_at: Date.now() - 120_000,
            created_by_kind: 'human',
            created_by_id: 'cli',
            parent_task_id: null,
            kind: 'orchestrate',
            priority: 'normal',
            prompt: 'render maestro',
            acceptance_criteria: null,
            expected_artifacts: null,
            eligibility: {},
            review_eligibility: null,
            requires_review: false,
            status: 'running',
            result_summary: null,
            result_artifacts: null,
            failure_reason: null,
            chain_id: null,
            origin: 'cli',
            lease: null,
            events: [],
          });
        }
        if (String(path).startsWith('/maestro/sessions/')) {
          return Response.json({
            task_id: taskId,
            agent_id: 'stub-maestro',
            chain_handoff_id: 'chain-123456',
            started_at: Date.now() - 120_000,
            wall_clock_budget_ms: 1_800_000,
            cost_consumed_cents: 218,
            cost_budget_cents: 200,
            sub_dispatches_consumed: 0,
            sub_dispatch_budget: 4,
            soft_warned_at: null,
            terminated_at: Date.now(),
            termination_reason: 'bounds_exceeded:cost',
          });
        }
        return daemon.fetch(path, init);
      },
      print: (line) => completed.push(line),
    });

    const rendered = completed.join('\n');
    expect(rendered).toContain('$2.18 / $2.00');
    expect(rendered).toContain('terminated:bounds_exceeded:cost');
    expect(rendered).toContain('0 / 4  (0%)');
  } finally {
    daemon.stop();
  }
});

test('task show renders running sessions and null counters without NaN', async () => {
  const daemon = setupDaemon();
  try {
    const taskId = 'task-running';
    const output: string[] = [];
    await runTaskShow({
      id: taskId,
      json: false,
      storageRoot: root,
      fetch: async (path, init) => {
        if (String(path).startsWith('/tasks/task-running?')) {
          return Response.json({
            id: taskId,
            created_at: Date.now() - 60_000,
            updated_at: Date.now() - 30_000,
            created_by_kind: 'human',
            created_by_id: 'cli',
            parent_task_id: null,
            kind: 'orchestrate',
            priority: 'normal',
            prompt: 'render running maestro',
            acceptance_criteria: null,
            expected_artifacts: null,
            eligibility: {},
            review_eligibility: null,
            requires_review: false,
            status: 'running',
            result_summary: null,
            result_artifacts: null,
            failure_reason: null,
            chain_id: null,
            origin: 'cli',
            lease: null,
            events: [],
          });
        }
        if (String(path).startsWith('/maestro/sessions/')) {
          return Response.json({
            task_id: taskId,
            agent_id: 'stub-maestro',
            chain_handoff_id: null,
            started_at: Date.now() - 30_000,
            wall_clock_budget_ms: 1_800_000,
            cost_consumed_cents: null,
            cost_budget_cents: 200,
            sub_dispatches_consumed: 2,
            sub_dispatch_budget: 4,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          });
        }
        return daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });

    const rendered = output.join('\n');
    expect(rendered).toContain('$0.00 / $2.00');
    expect(rendered).toContain('running');
    expect(rendered).toContain('2 / 4  (50%)');
    expect(rendered).not.toContain('NaN');
  } finally {
    daemon.stop();
  }
});

test('maestro session start posts to daemon and prints the created session', async () => {
  const daemon = setupDaemon();
  try {
    const output: string[] = [];
    await runMaestroSessionStart({
      json: true,
      storageRoot: root,
      task_id: 'task-session-1',
      chain_handoff_id: 'handoff-session-1',
      agent: 'stub-maestro',
      wall_budget_ms: 90_000,
      cost_budget_cents: 120,
      sub_dispatch_budget: 5,
      fetch: async (path, init) => {
        if (String(path) === '/maestro/sessions') {
          expect(init?.method).toBe('POST');
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({
            task_id: 'task-session-1',
            chain_handoff_id: 'handoff-session-1',
            agent_id: 'stub-maestro',
            wall_clock_budget_ms: 90_000,
            cost_budget_cents: 120,
            sub_dispatch_budget: 5,
          });
          return Response.json({
            task_id: 'task-session-1',
            chain_handoff_id: 'handoff-session-1',
            agent_id: 'stub-maestro',
            started_at: 1_746_000_000_000,
            wall_clock_budget_ms: 90_000,
            cost_budget_cents: 120,
            sub_dispatch_budget: 5,
            cost_consumed_cents: 0,
            sub_dispatches_consumed: 0,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          }, { status: 201 });
        }
        return daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });
    const payload = JSON.parse(output.join('\n'));
    expect(payload.task_id).toBe('task-session-1');
    expect(payload.agent_id).toBe('stub-maestro');
  } finally {
    daemon.stop();
  }
});

test('maestro session get fetches one session by task id', async () => {
  const daemon = setupDaemon();
  try {
    const output: string[] = [];
    await runMaestroSessionGet({
      json: true,
      storageRoot: root,
      task_id: 'task-session-get',
      fetch: async (path, init) => {
        if (String(path) === '/maestro/sessions/task-session-get') {
          return Response.json({
            task_id: 'task-session-get',
            chain_handoff_id: 'handoff-session-get',
            agent_id: 'stub-maestro',
            started_at: 1_746_000_000_001,
            wall_clock_budget_ms: 120_000,
            cost_budget_cents: 150,
            sub_dispatch_budget: 6,
            cost_consumed_cents: 25,
            sub_dispatches_consumed: 1,
            soft_warned_at: null,
            terminated_at: null,
            termination_reason: null,
          });
        }
        return daemon.fetch(path, init);
      },
      print: (line) => output.push(line),
    });
    const payload = JSON.parse(output.join('\n'));
    expect(payload.task_id).toBe('task-session-get');
    expect(payload.chain_handoff_id).toBe('handoff-session-get');
  } finally {
    daemon.stop();
  }
});
