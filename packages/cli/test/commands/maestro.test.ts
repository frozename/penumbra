import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { createDaemonFetchHandler } from '../../../daemon/src/serve.js';
import { runMaestroList } from '../../src/commands/maestro.js';
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
