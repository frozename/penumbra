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
let nextExecResult: any = { stdout: '', stderr: '' };
let execFailures: Record<string, any> = {};
const defaultDiffResult = { stdout: 'package.json\n', stderr: '' };

const mockDeps: any = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock(async (id: string, payload: any) => {
    progressCalls.push({ id, payload });
  }),
  log: mockLog,
  mainRepoDir: '/main/repo',
  exec: mock(async (cmd: string) => {
    execHistory.push(cmd);

    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    
    // Check for intentional failures
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
  execFailures = {};
  nextExecResult = { stdout: '', stderr: '' };
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) throw error;
    }
    return nextExecResult;
  });
});

const reconcile = createMergeReconciler(mockDeps);

test('Clean merge: typecheck, test, FF merge success', async () => {
  const result = await reconcile('h1');
  
  expect(result.status).toBe('merged');
  expect(execHistory).toContain('bun run typecheck');
  expect(execHistory).toContain('bun test');
  expect(execHistory).toContain('git merge --ff-only "agent/h1"');
  
  expect(progressCalls).toContainEqual({
    id: 'h1',
    payload: { type: 'merge-result', handoff_id: 'h1', status: 'merged' }
  });
});

test('Typecheck fail: returns typecheck_failed and skips merge', async () => {
  execFailures['bun run typecheck'] = { stderr: 'Syntax error' };
  
  const result = await reconcile('h2');
  
  expect(result.status).toBe('typecheck_failed');
  expect(result.regression_summary).toBe('Syntax error');
  expect(execHistory).toContain('bun run typecheck');
  expect(execHistory).not.toContain('bun test');
  expect(execHistory).not.toContain('git merge');
  
  expect(progressCalls).toContainEqual({
    id: 'h2',
    payload: { type: 'merge-result', handoff_id: 'h2', status: 'typecheck_failed', regression_summary: 'Syntax error' }
  });
});

test('Test fail: returns test_failed and skips merge', async () => {
  execFailures['bun test'] = { stderr: '1 test failed' };
  
  const result = await reconcile('h3');
  
  expect(result.status).toBe('test_failed');
  expect(result.regression_summary).toBe('1 test failed');
  expect(execHistory).toContain('bun run typecheck');
  expect(execHistory).toContain('bun test');
  expect(execHistory).not.toContain('git merge');
});

test('FF fail -> successful rebase and merge', async () => {
  let ffCalled = 0;
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    if (cmd.includes('git merge --ff-only')) {
      ffCalled++;
      if (ffCalled === 1) throw new Error('not ff');
    }
    return { stdout: '', stderr: '' };
  });

  const result = await reconcile('h4');
  
  expect(result.status).toBe('rebased');
  expect(execHistory).toContain('git rebase main');
  expect(ffCalled).toBe(2);
});

test('Rebase conflict: aborts and returns conflict list', async () => {
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);
    if (cmd.includes('git diff --name-only --diff-filter=U')) {
      return { stdout: 'src/index.ts\nREADME.md\n', stderr: '' };
    }
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    if (cmd.includes('git merge --ff-only')) throw new Error('not ff');
    if (cmd.includes('git rebase main')) throw new Error('conflict');
    return { stdout: '', stderr: '' };
  });

  const result = await reconcile('h5');
  
  expect(result.status).toBe('rebase_conflict');
  expect(result.conflict_files).toEqual(['src/index.ts', 'README.md']);
  expect(execHistory).toContain('git rebase --abort');
});

test('Parallel reconciles are serialized by the lock', async () => {
  let activeExecs = 0;
  let maxConcurrency = 0;

  mockDeps.exec.mockImplementation(async (cmd: string) => {
    if (cmd.includes('git merge')) {
      activeExecs++;
      maxConcurrency = Math.max(maxConcurrency, activeExecs);
      
      // Simulate slow git operation
      await new Promise(resolve => setTimeout(resolve, 50));
      activeExecs--;
    }
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    return { stdout: '', stderr: '' };
  });

  // Run two in parallel
  const p1 = reconcile('h6');
  const p2 = reconcile('h7');
  
  await Promise.all([p1, p2]);
  
  expect(maxConcurrency).toBe(1);
});

test('Mutex isolation: subsequent merges run even if previous one throws', async () => {
  let ffCount = 0;
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    if (cmd.includes('git merge --ff-only')) {
      ffCount++;
      if (ffCount === 1) throw new Error('Boom');
    }
    return { stdout: '', stderr: '' };
  });

  // Start two in parallel. They share the global lock.
  const p1 = reconcile('h_mutex_1').catch(() => ({ status: 'failed' }));
  const p2 = reconcile('h_mutex_2');

  const [r1, r2] = await Promise.all([p1, p2]);
  expect(ffCount).toBe(3);
  expect((r2 as any).status).toBe('merged');
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

test('Pre-rebase dirty check: aborts if worktree is dirty', async () => {
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    if (cmd.includes('git merge --ff-only')) throw new Error('not ff');
    if (cmd.includes('git status --porcelain')) {
      return { stdout: ' M modified.ts\n?? new.ts\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  });

  const result = await reconcile('h_dirty_1');
  expect(result.status).toBe('rebase_conflict');
  expect(result.regression_summary).toBe('worktree dirty before rebase');
  expect(result.conflict_files).toEqual(['modified.ts', 'new.ts']);
  expect(execHistory).not.toContain('git rebase main');
});

test('Post-abort dirty check: marks worktree_dirty: true', async () => {
  mockDeps.exec.mockImplementation(async (cmd: string) => {
    execHistory.push(cmd);
    if (cmd.startsWith('git diff --name-only')) {
      return defaultDiffResult;
    }
    if (cmd.includes('git merge --ff-only')) throw new Error('not ff');
    if (cmd.includes('git status --porcelain')) {
      // First call (pre-rebase) is clean
      if (execHistory.filter(c => c.includes('git status --porcelain')).length === 1) {
        return { stdout: '', stderr: '' };
      }
      // Second call (post-abort) is dirty
      return { stdout: '?? messy.ts\n', stderr: '' };
    }
    if (cmd.includes('git rebase main')) throw new Error('conflict');
    return { stdout: '', stderr: '' };
  });

  const result = await reconcile('h_dirty_2');
  expect(result.status).toBe('rebase_conflict');
  expect(result.worktree_dirty).toBe(true);
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
