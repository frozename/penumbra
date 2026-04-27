import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';
import type { Logger, WorktreeManager } from '@penumbra/core';

const exec = promisify(execCb);

export interface MergeResult {
  status: 'merged' | 'rebased' | 'rebase_conflict' | 'test_failed' | 'typecheck_failed';
  conflict_files?: string[];
  regression_summary?: string;
}

class Mutex {
  private queue = Promise.resolve();
  async acquire() {
    let release!: () => void;
    const p = new Promise<void>((r) => { release = r; });
    const wait = this.queue.then(() => release);
    this.queue = p;
    return wait;
  }
}

const globalMergeLock = new Mutex();

export interface ReconcilerDeps {
  worktreeManager: WorktreeManager;
  postProgress: (handoffId: string, payload: any) => Promise<void>;
  log: Logger;
  mainRepoDir: string;
  exec?: (command: string, options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
}

export function createMergeReconciler(deps: ReconcilerDeps) {
  const run = deps.exec || exec;
  return async function reconcileWorktree(handoffId: string): Promise<MergeResult> {
    const wt = deps.worktreeManager.getWorktree(handoffId);
    if (!wt) {
      throw new Error(`Worktree for handoff ${handoffId} not found`);
    }

    deps.log.info({ handoffId, path: wt.path }, 'starting worktree reconciliation');

    // 1. Run typecheck
    try {
      deps.log.debug({ handoffId }, 'running typecheck in worktree');
      await run('bun run typecheck', { cwd: wt.path });
    } catch (err: any) {
      const result: MergeResult = {
        status: 'typecheck_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', ...result });
      return result;
    }

    // 2. Run tests
    try {
      deps.log.debug({ handoffId }, 'running tests in worktree');
      // For performance in real use, we might want to scope this, but per spec: bun test
      await run('bun test', { cwd: wt.path });
    } catch (err: any) {
      const result: MergeResult = {
        status: 'test_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', ...result });
      return result;
    }

    // 3. Acquire global merge lock
    const releaseLock = await globalMergeLock.acquire();
    try {
      deps.log.debug({ handoffId }, 'acquired global merge lock');

      // 4. Try FF merge to main
      try {
        deps.log.debug({ handoffId, branch: wt.branchName }, 'attempting fast-forward merge');
        await run(`git merge --ff-only "${wt.branchName}"`, { cwd: deps.mainRepoDir });
        
        const result: MergeResult = { status: 'merged' };
        await deps.postProgress(handoffId, { type: 'merge-result', ...result });
        return result;
      } catch (ffErr) {
        // 5. If FF fails, try rebase
        deps.log.info({ handoffId, branch: wt.branchName }, 'FF merge failed, attempting rebase');
        try {
          await run('git rebase main', { cwd: wt.path });
          
          // FF again after rebase
          await run(`git merge --ff-only "${wt.branchName}"`, { cwd: deps.mainRepoDir });
          
          const result: MergeResult = { status: 'rebased' };
          await deps.postProgress(handoffId, { type: 'merge-result', ...result });
          return result;
        } catch (rebaseErr: any) {
          // 6. If rebase has conflicts
          const conflictFilesOutput = await run('git diff --name-only --diff-filter=U', { cwd: wt.path }).catch(() => ({ stdout: '' }));
          const conflict_files = conflictFilesOutput.stdout.split('\n').filter(Boolean);
          
          await run('git rebase --abort', { cwd: wt.path }).catch(() => {});
          
          const result: MergeResult = {
            status: 'rebase_conflict',
            conflict_files,
          };
          await deps.postProgress(handoffId, { type: 'merge-result', ...result });
          return result;
        }
      }
    } finally {
      releaseLock();
    }
  };
}
