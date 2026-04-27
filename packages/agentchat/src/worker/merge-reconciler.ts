import { promisify } from 'node:util';
import { exec as execCb, spawn } from 'node:child_process';
import type { Logger, WorktreeManager } from '@penumbra/core';

const exec = promisify(execCb);

export interface MergeResult {
  status: 'merged' | 'rebased' | 'rebase_conflict' | 'test_failed' | 'typecheck_failed';
  conflict_files?: string[];
  regression_summary?: string;
  timed_out?: boolean;
  worktree_dirty?: boolean;
}

class Mutex {
  private last: Promise<void> = Promise.resolve();

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.last;
    let release!: () => void;
    this.last = new Promise<void>(resolve => { release = resolve; });
    try {
      await prev;
    } catch {
      // swallow upstream errors so we still acquire
    }
    try {
      return await fn();
    } finally {
      release();
    }
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

/**
 * Runs a command with a timeout. If it times out, kills the process group.
 */
async function runWithTimeout(
  cmd: string,
  options: { cwd: string; timeoutSeconds: number; log: Logger }
): Promise<{ stdout: string; stderr: string; timedOut?: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, {
      cwd: options.cwd,
      shell: true,
      detached: process.platform !== 'win32'
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      options.log.warn({ cmd, pid: proc.pid }, 'command timed out, killing process group');
      if (proc.pid) {
        try {
          if (process.platform !== 'win32') {
            process.kill(-proc.pid, 'SIGKILL');
          } else {
            proc.kill('SIGKILL');
          }
        } catch (e) {
          // ignore
        }
      }
      resolve({ stdout, stderr, timedOut: true });
    }, options.timeoutSeconds * 1000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err: any = new Error(`Command failed with code ${code}: ${cmd}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export function createMergeReconciler(deps: ReconcilerDeps) {
  const run = deps.exec || exec;

  return async function reconcileWorktree(handoffId: string): Promise<MergeResult> {
    const wt = deps.worktreeManager.getWorktree(handoffId);
    if (!wt) {
      throw new Error(`Worktree for handoff ${handoffId} not found`);
    }

    deps.log.info({ handoffId, path: wt.path }, 'starting worktree reconciliation');

    // Helper for running commands with optional timeout
    const runCmd = async (cmd: string, cwd: string, timeoutSeconds?: number) => {
      if (timeoutSeconds && !deps.exec) {
        return runWithTimeout(cmd, { cwd, timeoutSeconds, log: deps.log });
      }
      // If deps.exec is provided (test mock), we just use it directly
      // but we still want to support timeout if the mock is slow.
      // For simplicity in this logic, we only use runWithTimeout if no deps.exec
      // or if we want to wrap deps.exec.
      if (timeoutSeconds && deps.exec) {
        return Promise.race([
          deps.exec(cmd, { cwd }),
          new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((_, reject) => {
            setTimeout(() => reject({ timedOut: true, stdout: '', stderr: '' }), timeoutSeconds * 1000);
          })
        ]).catch(err => {
          if (err && (err as any).timedOut) return err;
          throw err;
        });
      }
      return run(cmd, { cwd });
    };

    // 1. Run typecheck
    try {
      deps.log.debug({ handoffId }, 'running typecheck in worktree');
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S) || 120;
      const res = await runCmd('bun run typecheck', wt.path, timeout);
      if (res.timedOut) {
        const result: MergeResult = { status: 'typecheck_failed', timed_out: true, regression_summary: 'typecheck timed out' };
        await deps.postProgress(handoffId, { type: 'merge-result', ...result });
        return result;
      }
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
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S) || 300;
      const res = await runCmd('bun test', wt.path, timeout);
      if (res.timedOut) {
        const result: MergeResult = { status: 'test_failed', timed_out: true, regression_summary: 'tests timed out' };
        await deps.postProgress(handoffId, { type: 'merge-result', ...result });
        return result;
      }
    } catch (err: any) {
      const result: MergeResult = {
        status: 'test_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', ...result });
      return result;
    }

    // 3. Serialized merge/rebase block
    return globalMergeLock.withLock(async () => {
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

        // PRE-REBASE DIRTY CHECK
        const statusOutput = await run('git status --porcelain', { cwd: wt.path }).catch(() => ({ stdout: '' }));
        if (statusOutput.stdout.trim()) {
          const conflict_files = statusOutput.stdout.split('\n').filter(Boolean).map(l => l.slice(3));
          const result: MergeResult = {
            status: 'rebase_conflict',
            conflict_files,
            regression_summary: 'worktree dirty before rebase',
          };
          await deps.postProgress(handoffId, { type: 'merge-result', ...result });
          return result;
        }

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

          // POST-ABORT DIRTY CHECK
          const postAbortStatus = await run('git status --porcelain', { cwd: wt.path }).catch(() => ({ stdout: '' }));
          const worktree_dirty = !!postAbortStatus.stdout.trim();

          const result: MergeResult = {
            status: 'rebase_conflict',
            conflict_files,
            worktree_dirty,
          };
          await deps.postProgress(handoffId, { type: 'merge-result', ...result });
          return result;
        }
      }
    });
  };
}
