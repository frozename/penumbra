import { spawn } from 'node:child_process';
import type { HandoffRow, Logger, WorktreeManager } from '@penumbra/core';
import { createDispatchPR, renderDispatchPRBody } from './github-pr-helper.js';
import type { RuntimeThoughtsConfig } from './thought-config.js';
import { runThoughtAnalyzer, type ThoughtRow, type ThoughtAnalyzerDeps } from './thought-analyzer.js';

export interface MergeResult {
  status:
    | 'merged'
    | 'rebased'
    | 'rebase_conflict'
    | 'verified'
    | 'test_failed'
    | 'typecheck_failed'
    | 'pr_opened'
    | 'pr_creation_failed'
    | 'no_changes';
  conflict_files?: string[];
  regression_summary?: string;
  timed_out?: boolean;
  worktree_dirty?: boolean;
  pr_url?: string;
  pr_number?: number;
}

type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface ReconcilerVerdict {
  handoff_id: string;
  conversation_id: string;
  branch: string;
  head_sha: string;
  base_sha: string;
  typecheck: CheckStatus;
  tests: CheckStatus;
  files_changed: number;
  lines_added: number;
  lines_deleted: number;
  ff_mergeable: boolean;
  rebase_required: boolean;
  pr_url: string | null;
  verified_at: string;
  duration_ms: number;
  summary: string;
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
  notifyResult?: (handoffId: string, result: MergeResult) => Promise<void> | void;
  captureResult?: (handoffId: string, result: MergeResult) => Promise<void> | void;
  emitVerdict?: (verdict: ReconcilerVerdict) => Promise<void> | void;
  log: Logger;
  mainRepoDir: string;
  getHandoff: (handoffId: string) => Promise<HandoffRow | null>;
  createDispatchPR?: typeof createDispatchPR;
  exec?: (command: string, options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
  thoughtsConfig?: RuntimeThoughtsConfig;
  thoughtAnalyzerDeps?: ThoughtAnalyzerDeps;
  runThoughtAnalyzer?: typeof runThoughtAnalyzer;
  listThoughtEvents?: (handoffId: string) => Promise<ThoughtRow[]>;
  getParentHandoffId?: (handoffId: string) => Promise<string | null>;
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

function parseShortStat(shortStat: string): { filesChanged: number; linesAdded: number; linesDeleted: number } {
  const filesChangedMatch = shortStat.match(/(\d+)\s+file[s]?\s+changed/);
  const linesAddedMatch = shortStat.match(/(\d+)\s+insertion[s]?\(\+\)/);
  const linesDeletedMatch = shortStat.match(/(\d+)\s+deletion[s]?\(-\)/);
  return {
    filesChanged: filesChangedMatch ? Number.parseInt(filesChangedMatch[1]!, 10) : 0,
    linesAdded: linesAddedMatch ? Number.parseInt(linesAddedMatch[1]!, 10) : 0,
    linesDeleted: linesDeletedMatch ? Number.parseInt(linesDeletedMatch[1]!, 10) : 0,
  };
}

export function createMergeReconciler(deps: ReconcilerDeps) {
  return async function reconcileWorktree(handoffId: string): Promise<MergeResult> {
    const wt = deps.worktreeManager.getWorktree(handoffId);
    if (!wt) {
      deps.log.debug({ handoffId }, 'no worktree found for reconciliation, skipping');
      return { status: 'merged' };
    }

    deps.log.info({ handoffId, path: wt.path }, 'starting worktree reconciliation');
    const startedAtMs = Date.now();
    const handoff = await deps.getHandoff(handoffId);
    let typecheckStatus: CheckStatus = 'skipped';
    let testStatus: CheckStatus = 'skipped';
    let diffStats = { filesChanged: 0, linesAdded: 0, linesDeleted: 0 };

    const runCmd = async (cmd: string, cwd: string, timeoutSeconds?: number) => {
      return runCommand(cmd, cwd, deps.log, deps.exec, timeoutSeconds);
    };

    const runCmdSafe = async (cmd: string, cwd: string) => {
      try {
        return await runCmd(cmd, cwd);
      } catch {
        return null;
      }
    };

    const buildVerdict = async (result: MergeResult): Promise<ReconcilerVerdict> => {
      const [headShaRes, baseShaRes, ffRes] = await Promise.all([
        runCmdSafe(`git rev-parse ${wt.branchName}`, deps.mainRepoDir),
        runCmdSafe('git rev-parse main', deps.mainRepoDir),
        runCmdSafe(`git merge-base --is-ancestor main ${wt.branchName}`, deps.mainRepoDir),
      ]);

      const head_sha = headShaRes?.stdout.trim() || 'unknown';
      const base_sha = baseShaRes?.stdout.trim() || 'unknown';
      const ff_mergeable = ffRes !== null;
      const rebase_required = !ff_mergeable;
      const pr_url = result.pr_url ?? null;
      const duration_ms = Date.now() - startedAtMs;
      const summaryParts = [
        `typecheck:${typecheckStatus}`,
        `tests:${testStatus}`,
        `files:${diffStats.filesChanged}`,
        ff_mergeable ? 'ff-ready' : 'rebase-required',
      ];
      if (pr_url) summaryParts.push('pr-opened');
      if (result.status === 'no_changes') summaryParts.push('no-changes');
      if (result.status === 'typecheck_failed' || result.status === 'test_failed') summaryParts.push('verification-failed');

      return {
        handoff_id: handoffId,
        conversation_id: handoff?.conversation_id ?? 'unknown',
        branch: wt.branchName,
        head_sha,
        base_sha,
        typecheck: typecheckStatus,
        tests: testStatus,
        files_changed: diffStats.filesChanged,
        lines_added: diffStats.linesAdded,
        lines_deleted: diffStats.linesDeleted,
        ff_mergeable,
        rebase_required,
        pr_url,
        verified_at: new Date().toISOString(),
        duration_ms,
        summary: summaryParts.join(' | ').slice(0, 220),
      };
    };

    const emitResult = async (result: MergeResult): Promise<void> => {
      await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
      if (deps.captureResult) {
        try {
          await deps.captureResult(handoffId, result);
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'agent performance capture failed');
        }
      }
      if (deps.emitVerdict) {
        try {
          await deps.emitVerdict(await buildVerdict(result));
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'reconciler verdict emit failed');
        }
      }
      if (deps.notifyResult) {
        try {
          await deps.notifyResult(handoffId, result);
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'merge-result notification failed');
        }
      }
      try {
        if (deps.thoughtsConfig?.analyze?.enabled
          && deps.thoughtsConfig.analyze.onlyWhen.includes(result.status)
          && deps.listThoughtEvents
          && deps.runThoughtAnalyzer) {
          const parentHandoffId = deps.getParentHandoffId ? await deps.getParentHandoffId(handoffId) : null;
          if (parentHandoffId == null) {
            const thoughts = await deps.listThoughtEvents(handoffId);
            if (thoughts.length > 0) {
              await deps.runThoughtAnalyzer({
                handoffId,
                thoughts,
                mergeStatus: result.status,
                config: deps.thoughtsConfig,
                deps: deps.thoughtAnalyzerDeps!,
              });
            }
          }
        }
      } catch (err) {
        deps.log?.warn?.('thought analyzer failed', { handoffId, err: String(err) });
      }
    };

    // 1. Run typecheck
    try {
      deps.log.debug({ handoffId }, 'running typecheck in worktree');
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TYPECHECK_TIMEOUT_S) || 120;
      const res = await runCmd('bun run typecheck', wt.path, timeout);
      if (res.timedOut) {
        typecheckStatus = 'fail';
        const result: MergeResult = { status: 'typecheck_failed', timed_out: true, regression_summary: 'typecheck timed out' };
        await emitResult(result);
        return result;
      }
      typecheckStatus = 'pass';
    } catch (err: any) {
      typecheckStatus = 'fail';
      const result: MergeResult = {
        status: 'typecheck_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await emitResult(result);
      return result;
    }

    // 2. Run tests
    let testCommandUsed = 'bun test';
    try {
      deps.log.debug({ handoffId }, 'scoping tests from git diff');
      const timeout = Number(process.env.PENUMBRA_RECONCILE_TEST_TIMEOUT_S) || 300;
      let affectedPackages: string[] | null = null;
      const baseRef = handoff?.branch_base && handoff.branch_base !== 'main'
        ? handoff.branch_base
        : 'main';

      try {
        const diffRes = await runCmd(`git diff --name-only ${baseRef}..${wt.branchName}`, deps.mainRepoDir, timeout);
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
          testStatus = 'fail';
          const result: MergeResult = { status: 'test_failed', timed_out: true, regression_summary: 'tests timed out' };
          await emitResult(result);
          return result;
        }
        testStatus = 'pass';
      } else if (affectedPackages.length === 0) {
        deps.log.debug({ handoffId }, 'skipping tests for docs-only diff');
        testCommandUsed = 'skipped (docs-only diff)';
        testStatus = 'skipped';
      } else {
        deps.log.debug({ handoffId, affectedPackages }, 'running scoped tests in worktree');
        testCommandUsed = `bun test ${affectedPackages.map(pkg => `${pkg}/test/`).join(' ')}`;
        const res = await runCmd(testCommandUsed, wt.path, timeout);
        if (res.timedOut) {
          testStatus = 'fail';
          const result: MergeResult = { status: 'test_failed', timed_out: true, regression_summary: 'tests timed out' };
          await emitResult(result);
          return result;
        }
        testStatus = 'pass';
      }
    } catch (err: any) {
      testStatus = 'fail';
      const result: MergeResult = {
        status: 'test_failed',
        regression_summary: err.stderr || err.stdout || String(err),
      };
      await emitResult(result);
      return result;
    }

    // 3. Serialized PR creation block
    return globalMergeLock.withLock(async () => {
      deps.log.debug({ handoffId }, 'acquired global merge lock');

      // 4. Gather diff metadata and optionally open PR
      try {
        const dispatchPrompt = handoff?.message ?? '<unknown>';
        const agentName = handoff?.to_agent ?? '<unknown>';
        const conversationId = handoff?.conversation_id ?? null;
        const diffNames = await runCmd(`git diff --name-only main...${wt.branchName}`, deps.mainRepoDir);
        if (!diffNames.stdout.trim()) {
          const result: MergeResult = { status: 'no_changes' };
          deps.log.info({ handoffId, branch: wt.branchName }, 'reconciliation complete — no branch changes');
          await emitResult(result);
          return result;
        }
        const diffStatsRes = await runCmd(`git diff main...${wt.branchName} --shortstat`, wt.path);
        diffStats = parseShortStat(diffStatsRes.stdout);
        const shouldOpenPr = handoff?.open_pr_on_review === true
          || (handoff as unknown as { open_pr_on_review?: unknown })?.open_pr_on_review === 1;
        if (!shouldOpenPr) {
          const result: MergeResult = { status: 'verified' };
          deps.log.info({ handoffId, branch: wt.branchName }, 'reconciliation complete — verified without PR');
          await emitResult(result);
          return result;
        }
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
            diffStats: diffStatsRes.stdout,
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
        await emitResult(result);
        return result;
      } catch (err: any) {
        deps.log.error({ handoffId, err: String(err) }, 'PR creation failed');
        const result: MergeResult = { status: 'pr_creation_failed', regression_summary: String(err) };
        await emitResult(result);
        return result;
      }
    });
  };
}
