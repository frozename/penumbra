import { expect, test, spyOn, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, loadSqliteVec, migrate, type Services, type WorktreeHandle } from '@penumbra/core';
import { TestEmbedder } from '@penumbra/core/testing';
import { worktreesListRoute, worktreesInspectRoute, worktreesCleanupRoute } from '../../src/routes/worktrees.js';
import { chainsStartRoute } from '../../src/routes/chains.js';

try { if (process.platform === 'darwin') Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'); } catch {}

function tempServices(): Services {
  const db = new Database(':memory:');
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {}, input: {}, storageRoot: '/tmp/worktrees-test', db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date('2026-04-26T00:00:00Z'),
    uuid: () => `id-${++n}`,
    agentRegistry: ['gemini'],
  });
  services.watchdog = {
    recordHeartbeat: () => {},
    hasActiveWorker: () => true,
    tick: async () => {},
  };
  return services;
}

test('worktree.list with no worktrees', async () => {
  const services = tempServices();
  spyOn(services.worktreeManager, 'listWorktrees').mockReturnValue([]);
  
  const res = await worktreesListRoute(new Request('http://h/worktrees'), services);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body).toEqual({ worktrees: [] });
});

test('worktree.list returns tracked worktrees', async () => {
  const services = tempServices();
  const handle: WorktreeHandle = {
    handoffId: 'h1',
    path: '/tmp/wt1',
    branchName: 'agent/h1',
    storageRoot: '/tmp/wt1/.test-storage',
    createdAt: '2026-04-26T00:00:00Z',
    status: 'created',
  };
  spyOn(services.worktreeManager, 'listWorktrees').mockReturnValue([handle]);
  
  const res = await worktreesListRoute(new Request('http://h/worktrees'), services);
  const body = await res.json() as any;
  expect(body.worktrees).toHaveLength(1);
  expect(body.worktrees[0].handoffId).toBe('h1');
});

test('worktree.inspect returns 404 if not found', async () => {
  const services = tempServices();
  spyOn(services.worktreeManager, 'getWorktree').mockReturnValue(null);
  
  const res = await worktreesInspectRoute(new Request('http://h/worktrees/h1'), 'h1', services);
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error.code).toBe('not_found');
});

test('worktree.inspect includes relevant untracked files but filters framework symlinks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-inspect-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
    writeFileSync(join(dir, 'acp-promotion-smoke.txt'), 'ACP_WRITE_OK');
    writeFileSync(join(dir, 'node_modules'), 'framework symlink placeholder');

    const services = tempServices();
    const handle: WorktreeHandle = {
      handoffId: 'h-untracked',
      path: dir,
      branchName: 'agent/h-untracked',
      storageRoot: join(dir, '.test-storage'),
      createdAt: '2026-04-26T00:00:00Z',
      status: 'created',
    };
    spyOn(services.worktreeManager, 'getWorktree').mockReturnValue(handle);

    const res = await worktreesInspectRoute(new Request('http://h/worktrees/h-untracked'), 'h-untracked', services);
    expect(res.status).toBe(200);
    const body = await res.json() as any;

    expect(body.diff_against_main).toContain('?? acp-promotion-smoke.txt');
    expect(body.diff_against_main).not.toContain('node_modules');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worktree.cleanup calls manager', async () => {
  const services = tempServices();
  const handle: WorktreeHandle = {
    handoffId: 'h1',
    path: '/tmp/wt1',
    branchName: 'agent/h1',
    storageRoot: '/tmp/wt1/.test-storage',
    createdAt: '2026-04-26T00:00:00Z',
    status: 'created',
  };
  spyOn(services.worktreeManager, 'getWorktree').mockReturnValue(handle);
  const teardownSpy = spyOn(services.worktreeManager, 'teardownWorktree').mockResolvedValue(undefined);
  
  const res = await worktreesCleanupRoute(new Request('http://h/worktrees/h1/cleanup?force=true'), 'h1', services);
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe('torn_down');
  expect(teardownSpy).toHaveBeenCalledWith('h1', true);
});

test('chain.start respects use_worktree: false', async () => {
  const services = tempServices();
  const req = new Request('http://h/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'gemini',
      message: 'hello',
      use_worktree: false,
    }),
  });
  
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const { handoff_id } = await res.json() as any;
  
  const row = services.handoffReader.get(handoff_id);
  expect(row?.use_worktree).toBe(0); // sqlite boolean stored as 0/1
});

test('chain.start respects use_worktree: true', async () => {
  const services = tempServices();
  const req = new Request('http://h/chains/start', {
    method: 'POST',
    body: JSON.stringify({
      initial_agent: 'gemini',
      message: 'hello',
      use_worktree: true,
    }),
  });
  
  const res = await chainsStartRoute(req, services);
  expect(res.status).toBe(200);
  const { handoff_id } = await res.json() as any;
  
  const row = services.handoffReader.get(handoff_id);
  expect(row?.use_worktree).toBe(1);
});

test('chain.start rejects when use_worktree is omitted (strict project_id gate)', async () => {
  const prior = process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = '1';
  try {
    const services = tempServices();
    const req = new Request('http://h/chains/start', {
      method: 'POST',
      body: JSON.stringify({
        initial_agent: 'gemini',
        message: 'hello',
      }),
    });

    const res = await chainsStartRoute(req, services);
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body).toEqual({
      error: 'project_id_required',
      hint: 'pass project_id explicitly, or unset PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy behavior',
    });
  } finally {
    if (prior === undefined) delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
    else process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = prior;
  }
});
