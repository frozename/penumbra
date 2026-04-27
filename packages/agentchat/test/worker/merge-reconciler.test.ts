import { expect, test, mock, spyOn, beforeEach } from 'bun:test';
import { createMergeReconciler } from '../../src/worker/merge-reconciler.js';
import { WorktreeManager } from '../../src/worktree/manager.js';

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

const mockDeps: any = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock(async (id: string, payload: any) => {
    progressCalls.push({ id, payload });
  }),
  log: mockLog,
  mainRepoDir: '/main/repo',
  exec: mock(async (cmd: string) => {
    execHistory.push(cmd);
    
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
    payload: { type: 'merge-result', status: 'merged' }
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
    payload: { type: 'merge-result', status: 'typecheck_failed', regression_summary: 'Syntax error' }
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
    if (cmd.includes('git merge --ff-only')) throw new Error('not ff');
    if (cmd.includes('git rebase main')) throw new Error('conflict');
    if (cmd.includes('git diff --name-only --diff-filter=U')) {
      return { stdout: 'src/index.ts\nREADME.md\n', stderr: '' };
    }
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
    return { stdout: '', stderr: '' };
  });

  // Run two in parallel
  const p1 = reconcile('h6');
  const p2 = reconcile('h7');
  
  await Promise.all([p1, p2]);
  
  expect(maxConcurrency).toBe(1);
});
