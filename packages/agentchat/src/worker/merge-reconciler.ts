import { spawn } from 'node:child_process';
import type { HandoffRow, Logger, WorktreeManager } from '@penumbra/core';
import { createDispatchPR, renderDispatchPRBody } from './github-pr-helper.js';

export interface MergeResult {
  status: 'merged' | 'rebased' | 'rebase_conflict' | 'test_failed' | 'typecheck_failed' | 'pr_opened' | 'pr_creation_failed';
  conflict_files?: string[];
  regression_summary?: string;
  timed_out?: boolean;
  worktree_dirty?: boolean;
  pr_url?: string;
  pr_number?: number;
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

/**
 * Maps changed file paths to affected package roots.
 *
 * Returns:
 * - null for conservative full-suite fallback when any non-package path is touched
 * - [] when only docs/non-code paths changed
 * - a deduplicated sorted list of `packages/<name>` roots otherwise
 */
export function resolveAffectedPackages(paths: string[]): string[] | null {
  const packageRoots = new Set<string>();
  let docsOnly = true;

  for (const p of paths) {
    if (p.startsWith('packages/')) {
      const segment = p.split('/', 2)[1];
      if (!segment) continue;
      packageRoots.add(`packages/${segment}`);
      docsOnly = false;
      continue;
    }

    if (p.startsWith('docs/') || p.startsWith('.github/')) {
      continue;
    }

    return null;
  }

  if (packageRoots.size === 0 && docsOnly) {
    return [];
  }

  return Array.from(packageRoots).sort();
}

export interface ReconcilerDeps {
  worktreeManager: WorktreeManager;
  postProgress: (handoffId: string, payload: any) => Promise<void>;
  log: Logger;
  mainRepoDir: string;
  getHandoff: (handoffId: string) => Promise<HandoffRow | null>;
  createDispatchPR?: typeof createDispatchPR;
  exec?: (command: string, options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandRun {
  promise: Promise<CommandResult>;
  cancel: () => void;
}

/**
 * Runs a command with a timeout. If it times out, kills the process group.
 */
function startCommand(
  cmd: string,
  cwd: string,
  log: Logger,
  execFn?: ReconcilerDeps['exec'],
): CommandRun {
  if (execFn) {
    return {
      promise: execFn(cmd, { cwd }),
      cancel: () => {},
    };
  }

  const proc = spawn(cmd, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';

  proc.stdout?.on('data', (d) => { stdout += d.toString(); });
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });

  return {
    promise: new Promise<CommandResult>((resolve, reject) => {
      proc.on('close', (code) => {
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
        reject(err);
      });
    }),
    cancel: () => {
      log.warn({ cmd, pid: proc.pid }, 'command timed out, killing process group');
      if (!proc.pid) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-proc.pid, 'SIGKILL');
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
    },
  };
}

async function runCommand(
  cmd: string,
  cwd: string,
  log: Logger,
  exec: ReconcilerDeps['exec'],
  timeoutSeconds?: number,
): Promise<CommandResult & { timedOut?: boolean }> {
  const run = startCommand(cmd, cwd, log, exec);
  if (!timeoutSeconds) {
    return run.promise;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      run.cancel();
      resolve({ stdout: '', stderr: '', timedOut: true });
    }, timeoutSeconds * 1000);

    run.promise.then(
      (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(res);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

export function createMergeReconciler(deps: ReconcilerDeps) {
  return async function reconcileWorktree(handoffId: string): Promise<MergeResult> {
    const wt = deps.worktreeManager.getWorktree(handoffId);
    if (!wt) {
      deps.log.debug({ handoffId }, 'no worktree found for reconciliation, skipping');
      return { status: 'merged' };
    }

    deps.log.info({ handoffId, path: wt.path }, 'starting worktree reconciliation');

    const runCmd = async (cmd: string, cwd: string, timeoutSeconds?: number) => {
      return runCommand(cmd, cwd, deps.log, deps.exec, timeoutSeconds);
    };

    // 1. Run typecheck
    try {
      deps.log.debug({ handoffId }, 'running typecheck in worktree');
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S) || 120;
      const res = await runCmd('bun run typecheck', wt.path, timeout);
      if (res.timedOut) {
        const result: MergeResult = { status: 'typecheck_failed', timed_out: true, regression_summary: 'typecheck timed out' };
        await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
        return result;
      }
    } catch (err: any) {
      const result: MergeResult = {
        status: 'typecheck_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
      return result;
    }

    // 2. Run tests
    let testCommandUsed = 'bun test';
    try {
      deps.log.debug({ handoffId }, 'scoping tests from git diff');
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S) || 300;
      let affectedPackages: string[] | null = null;

      try {
        const diffRes = await runCmd(`git diff --name-only main..${wt.branchName}`, deps.mainRepoDir, timeout);
        if (!diffRes.timedOut) {
          affectedPackages = resolveAffectedPackages(
            diffRes.stdout.split('\n').map(line => line.trim()).filter(Boolean),
          );
        }
      } catch {
        affectedPackages = null;
      }

      if (affectedPackages === null) {
        deps.log.debug({ handoffId }, 'running full test suite in worktree');
        testCommandUsed = 'bun test';
        const res = await runCmd('bun test', wt.path, timeout);
        if (res.timedOut) {
          const result: MergeResult = { status: 'test_failed', timed_out: true, regression_summary: 'tests timed out' };
          await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
          return result;
        }
      } else if (affectedPackages.length === 0) {
        deps.log.debug({ handoffId }, 'skipping tests for docs-only diff');
        testCommandUsed = 'skipped (docs-only diff)';
      } else {
        deps.log.debug({ handoffId, affectedPackages }, 'running scoped tests in worktree');
        testCommandUsed = `bun test ${affectedPackages.map(pkg => `${pkg}/test/`).join(' ')}`;
        const res = await runCmd(testCommandUsed, wt.path, timeout);
        if (res.timedOut) {
          const result: MergeResult = { status: 'test_failed', timed_out: true, regression_summary: 'tests timed out' };
          await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
          return result;
        }
      }
    } catch (err: any) {
      const result: MergeResult = {
        status: 'test_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
      return result;
    }

    // 3. Serialized PR creation block
    return globalMergeLock.withLock(async () => {
      deps.log.debug({ handoffId }, 'acquired global merge lock');

      // 4. Push branch and open PR
      try {
        const handoff = await deps.getHandoff(handoffId);
        const dispatchPrompt = handoff?.message ?? '<unknown>';
        const agentName = handoff?.to_agent ?? '<unknown>';
        const conversationId = handoff?.conversation_id ?? null;
        const diffStats = await runCmd(`git diff main...${wt.branchName} --shortstat`, wt.path);
        const createPR = deps.createDispatchPR ?? createDispatchPR;
        const prResult = await createPR({
          branch: wt.branchName,
          baseBranch: 'main',
          title: `[${agentName}] ${dispatchPrompt.split('\n')[0].slice(0, 60)}`,
          body: renderDispatchPRBody({
            agentName,
            handoffId,
            conversationId,
            prompt: dispatchPrompt,
            typecheckStatus: 'pass',
            testCommand: testCommandUsed,
            testSummary: 'pass',
            diffStats: diffStats.stdout,
          }),
          draft: false,
          cwd: wt.path,
        }, deps.log);

        const result: MergeResult = {
          status: 'pr_opened',
          pr_url: prResult.url,
          pr_number: prResult.number,
        };
        deps.log.info({ handoffId, prUrl: prResult.url, prNumber: prResult.number }, 'reconciliation complete — PR opened');
        await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
        return result;
      } catch (err: any) {
        deps.log.error({ handoffId, err: String(err) }, 'PR creation failed');
        const result: MergeResult = { status: 'pr_creation_failed', regression_summary: String(err) };
        await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
        return result;
      }
    });
  };
}
