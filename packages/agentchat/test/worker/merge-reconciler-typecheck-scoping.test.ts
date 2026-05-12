import { beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { WorktreeManager } from '@penumbra/core';
import { createMergeReconciler } from '../../src/worker/merge-reconciler.js';

const execHistory: string[] = [];
const execFailures: Record<string, any> = {};
let diffOutput = 'packages/daemon/src/routes/handoffs.ts\n';

const mockDeps: any = {
  worktreeManager: new WorktreeManager(),
  postProgress: mock(async () => {}),
  notifyResult: mock(async () => {}),
  captureResult: mock(async () => {}),
  emitVerdict: mock(async () => {}),
  log: {
    info: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  },
  mainRepoDir: '/main/repo',
  getHandoff: mock(async () => ({
    handoff_id: 'h1',
    ts: '2026-05-12T00:00:00.000Z',
    project_id: null,
    conversation_id: 'c-123',
    from_agent: 'user',
    to_agent: 'codex',
    to_role: null,
    message: 'scope typecheck',
    status: 'completed',
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    use_worktree: null,
    open_pr_on_review: 0,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  })),
  createDispatchPR: mock(async () => ({
    url: 'https://github.com/acordeiro/penumbra/pull/1',
    number: 1,
  })),
  exec: mock(async (argv: string[]) => {
    const cmd = argv.join(' ');
    execHistory.push(cmd);
    for (const [pattern, error] of Object.entries(execFailures)) {
      if (cmd.includes(pattern)) throw error;
    }
    if (cmd.startsWith('git diff --name-only')) {
      return { stdout: diffOutput, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }),
  settings: {
    reconcileTypecheckTimeoutSec: 120,
    reconcileTestTimeoutSec: 300,
  },
};

spyOn(WorktreeManager.prototype, 'getWorktree').mockImplementation((id: string) => {
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
  execHistory.length = 0;
  diffOutput = 'packages/daemon/src/routes/handoffs.ts\n';
  for (const key of Object.keys(execFailures)) {
    delete execFailures[key];
  }
});

function makeReconciler() {
  return createMergeReconciler(mockDeps);
}

test('scopes typecheck to the affected package when one package changed', async () => {
  diffOutput = 'packages/daemon/src/routes/handoffs.ts\n';
  const reconciler = makeReconciler();

  await reconciler('h1');

  expect(execHistory).toContain('bun tsc -b packages/core packages/daemon');
  expect(execHistory).not.toContain('bun run typecheck');
});

test('scopes typecheck to multiple affected packages', async () => {
  diffOutput = 'packages/daemon/src/routes/handoffs.ts\npackages/mcp/src/server.ts\n';
  const reconciler = makeReconciler();

  await reconciler('h1');

  expect(execHistory).toContain('bun tsc -b packages/core packages/daemon packages/mcp');
  expect(execHistory).not.toContain('bun run typecheck');
});

test('does not duplicate packages/core when it is already affected', async () => {
  diffOutput = 'packages/core/src/index.ts\npackages/daemon/src/routes/handoffs.ts\n';
  const reconciler = makeReconciler();

  await reconciler('h1');

  expect(execHistory).toContain('bun tsc -b packages/core packages/daemon');
});

test('skips typecheck for docs-only diffs', async () => {
  diffOutput = 'docs/superpowers/plans/quality-push.md\n';
  const reconciler = makeReconciler();

  await reconciler('h1');

  expect(execHistory.find((cmd) => cmd.includes('typecheck'))).toBeUndefined();
});

test('falls back to full-tree typecheck when git diff fails', async () => {
  execFailures['git diff --name-only'] = { stderr: 'diff failed' };
  const reconciler = makeReconciler();

  await reconciler('h1');

  expect(execHistory).toContain('bun run typecheck');
});

test('reports scoped typecheck failures with affected packages in the regression summary', async () => {
  diffOutput = 'packages/daemon/src/routes/handoffs.ts\npackages/mcp/src/server.ts\n';
  execFailures['bun tsc -b packages/core packages/daemon packages/mcp'] = { stderr: 'tsc failed' };
  const reconciler = makeReconciler();

  const result = await reconciler('h1');

  expect(result.status).toBe('typecheck_failed');
  expect(result.regression_summary).toContain('packages/core');
  expect(result.regression_summary).toContain('packages/daemon');
  expect(result.regression_summary).toContain('packages/mcp');
});
