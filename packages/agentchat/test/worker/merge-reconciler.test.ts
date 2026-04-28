import { expect, test, mock, spyOn, beforeEach, describe } from 'bun:test';
import { createMergeReconciler, resolveAffectedPackages } from '../../src/worker/merge-reconciler.js';
import { WorktreeManager } from '@penumbra/core';

const mockLog: any = {
  info: mock(() => {}),
  debug: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

const progressCalls: any[] = [];
const execHistory: string[] = [];
const prCalls: any[] = [];
const handoffRows: Record<string, any> = {};
let nextExecResult: any = { stdout: '', stderr: '' };
let execFailures: Record<string, any> = {};
let createDispatchPRFailOnCall: number | null = null;
let createDispatchPRCallCount = 0;
let createDispatchPRDelayMs = 0;
const defaultDiffResult = { stdout: 'packages/daemon/src/routes/handoffs.ts\n', stderr: '' };
const defaultShortStat = { stdout: ' 1 file changed, 2 insertions(+), 1 deletion(-)\n', stderr: '' };

const mockDeps: any = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock(async (id: string, payload: any) => {
    progressCalls.push({ id, payload });
  }),
  log: mockLog,
  mainRepoDir: '/main/repo',
  getHandoff: mock(async (id: string) => {
    return handoffRows[id] ?? null;
  }),
  createDispatchPR: mock(async (args: any) => {
    createDispatchPRCallCount += 1;
    prCalls.push(args);
    if (createDispatchPRDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, createDispatchPRDelayMs));
    }
    if (createDispatchPRFailOnCall === createDispatchPRCallCount) {
      throw new Error('Boom');
    }
    return {
      url: 'https://github.com/acordeiro/penumbra/pull/321',
      number: 321,
    };
  }),
  exec: mock(async (cmd: string) => {
    execHistory.push(cmd);

    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }

    if (cmd.startsWith('git diff main...')) {
      return defaultShortStat;
    }

    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) {
        throw error;
      }
    }

    return nextExecResult;
  }),
};

spyOn(WorktreeManager.prototype, 'getWorktree').mockImplementation((id: string) => {
  if (id === 'missing') return null;
  return {
    handoffId: id,
    path: `/worktree/${id}`,
    branchName: `agent/${id}`,
    storageRoot: `/worktree/${id}/.test-storage`,
    createdAt: '',
    status: 'created',
  } as any;
});

beforeEach(() => {
  progressCalls.length = 0;
  execHistory.length = 0;
  prCalls.length = 0;
  createDispatchPRCallCount = 0;
  createDispatchPRDelayMs = 0;
  createDispatchPRFailOnCall = null;
  nextExecResult = { stdout: '', stderr: '' };
  execFailures = {};
  for (const key of Object.keys(handoffRows)) {
    delete handoffRows[key];
  }
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);

    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }

    if (cmd.startsWith('git diff main...')) {
      return defaultShortStat;
    }

    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) throw error;
    }

    return nextExecResult;
  });
  mockDeps.createDispatchPR.mockImplementation(async (args: any) => {
    createDispatchPRCallCount += 1;
    prCalls.push(args);
    if (createDispatchPRDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, createDispatchPRDelayMs));
    }
    if (createDispatchPRFailOnCall === createDispatchPRCallCount) {
      throw new Error('Boom');
    }
    return {
      url: 'https://github.com/acordeiro/penumbra/pull/321',
      number: 321,
    };
  });
  mockDeps.getHandoff.mockImplementation(async (id: string) => {
    return handoffRows[id] ?? null;
  });
});

const reconcile = createMergeReconciler(mockDeps);

test('Clean merge: typecheck, test, PR opened', async () => {
  handoffRows.h1 = {
    handoff_id: 'h1',
    ts: '2026-04-28T00:00:00.000Z',
    project_id: null,
    conversation_id: 'c-456',
    from_agent: 'user',
    to_agent: 'codex-mini',
    to_role: null,
    message: 'dispatch prompt with $(touch /tmp/pwned) literally',
    status: 'completed',
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  } as any;

  const result = await reconcile('h1');

  expect(result.status).toBe('pr_opened');
  expect(result.pr_url).toBe('https://github.com/acordeiro/penumbra/pull/321');
  expect(result.pr_number).toBe(321);
  expect(execHistory).toContain('bun run typecheck');
  expect(execHistory).toContain('bun test packages/daemon/test/');
  expect(execHistory).toContain('git diff main...agent/h1 --shortstat');
  expect(prCalls).toHaveLength(1);
  expect(prCalls[0]).toMatchObject({
    branch: 'agent/h1',
    baseBranch: 'main',
    title: '[codex-mini] dispatch prompt with $(touch /tmp/pwned) literally',
    draft: false,
    cwd: '/worktree/h1',
  });
  expect(prCalls[0].body).toContain('## Dispatched');
  expect(prCalls[0].body).toContain('- **agent:** codex-mini');
  expect(prCalls[0].body).toContain('- **handoff:** h1');
  expect(prCalls[0].body).toContain('- **conversation:** c-456');
  expect(prCalls[0].body).toContain('dispatch prompt with $(touch /tmp/pwned) literally');
  expect(prCalls[0].body).toContain('- typecheck: pass');
  expect(prCalls[0].body).toContain('- tests: bun test packages/daemon/test/ → pass');
  expect(prCalls[0].body).toContain('1 file changed, 2 insertions(+), 1 deletion(-)');
  expect(progressCalls).toContainEqual({
    id: 'h1',
    payload: {
      type: 'merge-result',
      handoff_id: 'h1',
      status: 'pr_opened',
      pr_url: 'https://github.com/acordeiro/penumbra/pull/321',
      pr_number: 321,
    },
  });
});

test('Typecheck fail: returns typecheck_failed and skips PR creation', async () => {
  execFailures['bun run typecheck'] = { stderr: 'Syntax error' };

  const result = await reconcile('h2');

  expect(result.status).toBe('typecheck_failed');
  expect(result.regression_summary).toBe('Syntax error');
  expect(execHistory).toContain('bun run typecheck');
  expect(execHistory).not.toContain('bun test');
  expect(prCalls).toHaveLength(0);
  expect(progressCalls).toContainEqual({
    id: 'h2',
    payload: { type: 'merge-result', handoff_id: 'h2', status: 'typecheck_failed', regression_summary: 'Syntax error' }
  });
});

test('Test fail: returns test_failed and skips PR creation', async () => {
  execFailures['bun test'] = { stderr: '1 test failed' };

  const result = await reconcile('h3');

  expect(result.status).toBe('test_failed');
  expect(result.regression_summary).toBe('1 test failed');
  expect(execHistory).toContain('bun run typecheck');
  expect(execHistory).toContain('bun test packages/daemon/test/');
  expect(prCalls).toHaveLength(0);
});

test('PR creation failure returns pr_creation_failed', async () => {
  handoffRows.h4 = {
    handoff_id: 'h4',
    ts: '2026-04-28T00:00:00.000Z',
    project_id: null,
    conversation_id: 'c-999',
    from_agent: 'user',
    to_agent: 'codex-mini',
    to_role: null,
    message: 'failing PR flow',
    status: 'completed',
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  } as any;
  createDispatchPRFailOnCall = 1;

  const result = await reconcile('h4');

  expect(result.status).toBe('pr_creation_failed');
  expect(result.regression_summary).toContain('Boom');
  expect(progressCalls).toContainEqual({
    id: 'h4',
    payload: {
      type: 'merge-result',
      handoff_id: 'h4',
      status: 'pr_creation_failed',
      regression_summary: 'Error: Boom',
    },
  });
});

test('Parallel reconciles are serialized by the lock', async () => {
  let activePRs = 0;
  let maxConcurrency = 0;
  mockDeps.createDispatchPR.mockImplementation(async (args: any) => {
    prCalls.push(args);
    activePRs += 1;
    maxConcurrency = Math.max(maxConcurrency, activePRs);
    await new Promise(resolve => setTimeout(resolve, 50));
    activePRs -= 1;
    return {
      url: 'https://github.com/acordeiro/penumbra/pull/321',
      number: 321,
    };
  });

  const p1 = reconcile('h6');
  const p2 = reconcile('h7');

  await Promise.all([p1, p2]);

  expect(maxConcurrency).toBe(1);
});

test('Mutex isolation: subsequent PR flows run even if previous one throws', async () => {
  let callCount = 0;
  mockDeps.createDispatchPR.mockImplementation(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error('Boom');
    }
    return {
      url: 'https://github.com/acordeiro/penumbra/pull/321',
      number: 321,
    };
  });

  const p1 = reconcile('h_mutex_1');
  const p2 = reconcile('h_mutex_2');

  const [r1, r2] = await Promise.all([p1, p2]);
  expect((r1 as any).status).toBe('pr_creation_failed');
  expect((r2 as any).status).toBe('pr_opened');
});

test('Typecheck timeout returns timed_out: true', async () => {
  process.env.PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S = '0.1';
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    if (cmd.includes('bun run typecheck')) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { stdout: '', stderr: '' };
  });

  const result = await reconcile('h_timeout_1');
  expect(result.status).toBe('typecheck_failed');
  expect(result.timed_out).toBe(true);
  delete process.env.PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S;
});

test('Test timeout returns timed_out: true', async () => {
  process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S = '0.1';
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    if (cmd.includes('bun test')) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { stdout: '', stderr: '' };
  });

  const result = await reconcile('h_timeout_2');
  expect(result.status).toBe('test_failed');
  expect(result.timed_out).toBe(true);
  delete process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S;
});

describe('resolveAffectedPackages', () => {
  test('resolveAffectedPackages returns single package for one daemon path', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/src/routes/handoffs.ts',
    ]);
    expect(result).toEqual(['packages/daemon']);
  });

  test('resolveAffectedPackages returns multiple distinct packages, deduplicated', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/src/routes/handoffs.ts',
      'packages/mcp/src/tools/chain-status.ts',
      'packages/daemon/test/routes/handoffs-status.test.ts',
    ]);
    expect(result?.sort()).toEqual(['packages/daemon', 'packages/mcp']);
  });

  test('resolveAffectedPackages returns null when a non-package path is touched', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/src/routes/handoffs.ts',
      'tsconfig.base.json',
    ]);
    expect(result).toBeNull();
  });

  test('resolveAffectedPackages returns null when bun.lock or root package.json is touched', () => {
    expect(resolveAffectedPackages(['bun.lock'])).toBeNull();
    expect(resolveAffectedPackages(['package.json'])).toBeNull();
  });

  test('resolveAffectedPackages returns empty array for docs-only changes', () => {
    const result = resolveAffectedPackages([
      'docs/superpowers/plans/some-plan.md',
      'docs/notes/some-note.md',
    ]);
    expect(result).toEqual([]);
  });

  test('resolveAffectedPackages returns empty array for empty diff', () => {
    expect(resolveAffectedPackages([])).toEqual([]);
  });

  test('resolveAffectedPackages scopes package.json inside a package root', () => {
    const result = resolveAffectedPackages([
      'packages/daemon/package.json',
    ]);
    expect(result).toEqual(['packages/daemon']);
  });
});

function makeScopedReconciler(exec: (cmd: string, opts: { cwd: string }) => Promise<{ stdout: string; stderr: string }>) {
  return createMergeReconciler({
    worktreeManager: new WorktreeManager(),
    postProgress: mock(async () => {}),
    log: mockLog,
    mainRepoDir: '/repo',
    getHandoff: mock(async () => null),
    createDispatchPR: mock(async () => ({
      url: 'https://github.com/acordeiro/penumbra/pull/999',
      number: 999,
    })),
    exec,
  });
}

describe('reconciler test step is diff-scoped', () => {
  test('runs bun test packages/daemon/test/ when only daemon changed', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string, _opts: { cwd: string }) => {
      execCalls.push(cmd);
      if (cmd.startsWith('git diff --name-only')) {
        return { stdout: 'packages/daemon/src/routes/handoffs.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler('diff-scoped-1');

    expect(execCalls.find((cmd) => cmd.startsWith('bun test'))).toBe('bun test packages/daemon/test/');
  });

  test('skips test step entirely when diff is docs-only', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string, _opts: { cwd: string }) => {
      execCalls.push(cmd);
      if (cmd.startsWith('git diff --name-only')) {
        return { stdout: 'docs/plans/foo.md\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler('diff-scoped-2');

    expect(execCalls.find((cmd) => cmd.startsWith('bun test'))).toBeUndefined();
  });

  test('falls back to full bun test when a root file changed', async () => {
    const execCalls: string[] = [];
    const exec = async (cmd: string, _opts: { cwd: string }) => {
      execCalls.push(cmd);
      if (cmd.startsWith('git diff --name-only')) {
        return { stdout: 'packages/daemon/src/foo.ts\nbun.lock\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };

    const reconciler = makeScopedReconciler(exec);
    await reconciler('diff-scoped-3');

    expect(execCalls).toContain('bun test');
  });
});
