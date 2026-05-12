import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type HandoffRow, type Logger, type Settings, type WorktreeManager } from '@penumbra/core';
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
  error_code?: 'invalid_branch_base' | 'invalid_branch' | 'invalid_test_package_path';
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
  rebase_attempted: boolean;
  rebase_result: 'success' | 'conflict' | 'skipped' | 'success_local_only';
  rebase_conflict_files?: string[];
  rebased_branch?: string;
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
  reconcilerAutoRebase?: boolean;
  rebaseScratchRoot?: string;
  getHandoff: (handoffId: string) => Promise<HandoffRow | null>;
  createDispatchPR?: typeof createDispatchPR;
  exec?: (argv: string[], options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>;
  thoughtsConfig?: RuntimeThoughtsConfig;
  thoughtAnalyzerDeps?: ThoughtAnalyzerDeps;
  runThoughtAnalyzer?: typeof runThoughtAnalyzer;
  listThoughtEvents?: (handoffId: string) => Promise<ThoughtRow[]>;
  getParentHandoffId?: (handoffId: string) => Promise<string | null>;
  settings?: Pick<Settings, 'reconcileTypecheckTimeoutSec' | 'reconcileTestTimeoutSec'>;
}

interface RebaseOutcome {
  attempted: boolean;
  result: 'success' | 'conflict' | 'skipped' | 'success_local_only';
  conflictFiles?: string[];
  rebasedBranch?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandRun {
  promise: Promise<CommandResult>;
  cancel: () => void;
}

type CommandArgs = [string, ...string[]];

const REF_TOKEN_RE = /^[A-Za-z0-9._/^~-]{1,200}$/;
const TEST_PACKAGE_PATH_RE = /^[a-zA-Z0-9._/-]{1,200}$/;
const PACKAGE_ROOT_RE = /^[a-zA-Z0-9._/-]{1,200}$/;

function hasForbiddenRefChars(value: string): boolean {
  return value.includes('\0') || value.includes('\n') || value.includes('\r');
}

function isValidGitRefToken(token: string): boolean {
  if (token.length === 0 || token.length > 200) return false;
  if (token.startsWith('-')) return false;
  if (token.includes('../')) return false;
  if (token.includes('..')) return false;
  if (hasForbiddenRefChars(token)) return false;
  return REF_TOKEN_RE.test(token);
}

function isValidGitRef(ref: string): boolean {
  const value = ref.trim();
  if (value.length === 0) return false;
  if (value.startsWith('--')) return false;
  if (hasForbiddenRefChars(value)) return false;

  const tripleIdx = value.indexOf('...');
  if (tripleIdx !== -1) {
    if (tripleIdx !== value.lastIndexOf('...')) return false;
    const left = value.slice(0, tripleIdx);
    const right = value.slice(tripleIdx + 3);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  const doubleIdx = value.indexOf('..');
  if (doubleIdx !== -1) {
    if (doubleIdx !== value.lastIndexOf('..')) return false;
    const left = value.slice(0, doubleIdx);
    const right = value.slice(doubleIdx + 2);
    return isValidGitRefToken(left) && isValidGitRefToken(right);
  }

  return isValidGitRefToken(value);
}

function isValidTestPackagePath(path: string): boolean {
  if (!TEST_PACKAGE_PATH_RE.test(path)) return false;
  if (path.includes('..')) return false;
  if (path.startsWith('-')) return false;
  if (path.split('/').some(segment => segment.startsWith('-'))) return false;
  return true;
}

function isValidPackageRoot(path: string): boolean {
  if (!PACKAGE_ROOT_RE.test(path)) return false;
  if (path.includes('..')) return false;
  if (!path.startsWith('packages/')) return false;
  if (path.split('/').some(segment => segment.startsWith('-'))) return false;
  return true;
}

function toCommandArgs(file: string, args: string[]): CommandArgs {
  return [file, ...args];
}

/**
 * Runs a command with a timeout. If it times out, kills the process group.
 */
function startCommand(
  argv: CommandArgs,
  cwd: string,
  log: Logger,
  execFn?: ReconcilerDeps['exec'],
): CommandRun {
  const [file, ...args] = argv;
  const commandText = argv.join(' ');
  if (execFn) {
    return {
      promise: execFn(argv, { cwd }),
      cancel: () => {},
    };
  }

  const proc = spawn(file, args, {
    cwd,
    shell: false,
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
          const err: any = new Error(`Command failed with code ${code}: ${commandText}`);
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
      log.warn({ cmd: commandText, pid: proc.pid }, 'command timed out, killing process group');
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
  argv: CommandArgs,
  cwd: string,
  log: Logger,
  exec: ReconcilerDeps['exec'],
  timeoutSeconds?: number,
): Promise<CommandResult & { timedOut?: boolean }> {
  const run = startCommand(argv, cwd, log, exec);
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
    let rebaseOutcome: RebaseOutcome = { attempted: false, result: 'skipped' };

    const runCmd = async (argv: CommandArgs, cwd: string, timeoutSeconds?: number) => {
      return runCommand(argv, cwd, deps.log, deps.exec, timeoutSeconds);
    };
    const runGit = async (args: string[], cwd: string, timeoutSeconds?: number) => {
      return runCmd(toCommandArgs('git', args), cwd, timeoutSeconds);
    };

    const runGitSafe = async (args: string[], cwd: string) => {
      try {
        return await runGit(args, cwd);
      } catch {
        return null;
      }
    };

    const attemptAutoRebaseIfNeeded = async (): Promise<void> => {
      if (deps.reconcilerAutoRebase === false) {
        rebaseOutcome = { attempted: false, result: 'skipped' };
        return;
      }
      const ffStatus = await runGitSafe(['merge-base', '--is-ancestor', 'main', wt.branchName], deps.mainRepoDir);
      if (ffStatus !== null) {
        rebaseOutcome = { attempted: false, result: 'skipped' };
        return;
      }

      rebaseOutcome = { attempted: true, result: 'skipped' };
      const scratchRoot = deps.rebaseScratchRoot ?? join(homedir(), '.penumbra', 'rebase-scratch');
      const scratchPath = join(scratchRoot, handoffId);
      await mkdir(scratchRoot, { recursive: true });

      await runGitSafe(['worktree', 'remove', '--force', scratchPath], deps.mainRepoDir);
      await rm(scratchPath, { recursive: true, force: true }).catch(() => {});

      try {
        await runGit(['worktree', 'add', '--detach', scratchPath, 'main'], deps.mainRepoDir);
        await runGit(['checkout', wt.branchName], scratchPath);
        try {
          await runGit(['rebase', 'main'], scratchPath);
        } catch {
          const conflictRes = await runGitSafe(['diff', '--name-only', '--diff-filter=U'], scratchPath);
          const files = conflictRes?.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean) ?? [];
          await runGitSafe(['rebase', '--abort'], scratchPath);
          rebaseOutcome = {
            attempted: true,
            result: 'conflict',
            conflictFiles: files,
          };
          return;
        }

        const rebasedTip = (await runGit(['rev-parse', wt.branchName], scratchPath)).stdout.trim();
        await runGit(['merge-base', '--is-ancestor', 'main', rebasedTip], scratchPath);
        try {
          await runGit(['push', '--force-with-lease', 'origin', `${wt.branchName}:${wt.branchName}`], scratchPath);
          rebaseOutcome = {
            attempted: true,
            result: 'success',
            rebasedBranch: wt.branchName,
          };
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'auto-rebase push failed; keeping local rebase');
          rebaseOutcome = {
            attempted: true,
            result: 'success_local_only',
            rebasedBranch: wt.branchName,
          };
        }
      } catch (err) {
        deps.log.warn({ handoffId, err: String(err) }, 'auto-rebase failed unexpectedly');
      } finally {
        await runGitSafe(['worktree', 'remove', '--force', scratchPath], deps.mainRepoDir);
        await rm(scratchPath, { recursive: true, force: true }).catch(() => {});
      }
    };

    const buildVerdict = async (result: MergeResult): Promise<ReconcilerVerdict> => {
      const [headShaRes, baseShaRes, ffRes] = await Promise.all([
        runGitSafe(['rev-parse', wt.branchName], deps.mainRepoDir),
        runGitSafe(['rev-parse', 'main'], deps.mainRepoDir),
        runGitSafe(['merge-base', '--is-ancestor', 'main', wt.branchName], deps.mainRepoDir),
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
        `rebase:${rebaseOutcome.result}`,
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
        rebase_attempted: rebaseOutcome.attempted,
        rebase_result: rebaseOutcome.result,
        ...(rebaseOutcome.conflictFiles ? { rebase_conflict_files: rebaseOutcome.conflictFiles } : {}),
        ...(rebaseOutcome.rebasedBranch ? { rebased_branch: rebaseOutcome.rebasedBranch } : {}),
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
        deps.log?.warn?.({ handoffId, err: String(err) }, 'thought analyzer failed');
      }
    };

    const emitInvalidInputResult = async (
      code: NonNullable<MergeResult['error_code']>,
      details: Record<string, string>,
    ): Promise<MergeResult> => {
      const result: MergeResult = {
        status: 'test_failed',
        error_code: code,
        regression_summary: JSON.stringify({ code, ...details }),
      };
      await deps.postProgress(handoffId, { type: 'merge-result', handoff_id: handoffId, ...result });
      if (deps.captureResult) {
        try {
          await deps.captureResult(handoffId, result);
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'agent performance capture failed');
        }
      }
      if (deps.notifyResult) {
        try {
          await deps.notifyResult(handoffId, result);
        } catch (err) {
          deps.log.warn({ handoffId, err: String(err) }, 'merge-result notification failed');
        }
      }
      return result;
    };

    if (!isValidGitRef(wt.branchName)) {
      return emitInvalidInputResult('invalid_branch', { field: 'branch', value: wt.branchName });
    }

    const baseRef = handoff?.branch_base && handoff.branch_base !== 'main'
      ? handoff.branch_base
      : 'main';

    if (!isValidGitRef(baseRef)) {
      return emitInvalidInputResult('invalid_branch_base', { field: 'branch_base', value: baseRef });
    }

    const timeout = deps.settings?.reconcileTypecheckTimeoutSec ?? 120;
    let affectedPackages: string[] | null = null;
    try {
      const diffRes = await runGit(['diff', '--name-only', `${baseRef}..${wt.branchName}`], deps.mainRepoDir, timeout);
      affectedPackages = resolveAffectedPackages(
        diffRes.stdout.split('\n').map(line => line.trim()).filter(Boolean),
      );
    } catch {
      affectedPackages = null;
    }

    // 1. Run typecheck
    try {
      if (affectedPackages === null) {
        deps.log.debug({ handoffId }, 'running full typecheck in worktree');
        const res = await runCmd(['bun', 'run', 'typecheck'], wt.path, timeout);
        if (res.timedOut) {
          typecheckStatus = 'fail';
          const result: MergeResult = { status: 'typecheck_failed', timed_out: true, regression_summary: 'typecheck timed out' };
          await emitResult(result);
          return result;
        }
        typecheckStatus = 'pass';
      } else if (affectedPackages.length === 0) {
        deps.log.debug({ handoffId }, 'skipping typecheck for docs-only diff');
        typecheckStatus = 'skipped';
      } else {
        for (const packageRoot of affectedPackages) {
          if (!isValidPackageRoot(packageRoot)) {
            return await emitInvalidInputResult('invalid_test_package_path', { field: 'package_root', value: packageRoot });
          }
        }
        deps.log.debug({ handoffId, affectedPackages }, 'running scoped typecheck in worktree');
        const typecheckCommand = ['bun', 'tsc', '-b', ...affectedPackages];
        const res = await runCmd(typecheckCommand, wt.path, timeout);
        if (res.timedOut) {
          typecheckStatus = 'fail';
          const result: MergeResult = {
            status: 'typecheck_failed',
            timed_out: true,
            regression_summary: `typecheck timed out for ${affectedPackages.join(', ')}`,
          };
          await emitResult(result);
          return result;
        }
        typecheckStatus = 'pass';
      }
    } catch (err: any) {
      typecheckStatus = 'fail';
      const result: MergeResult = {
        status: 'typecheck_failed',
        regression_summary: affectedPackages && affectedPackages.length > 0
          ? `${affectedPackages.join(', ')}: ${err.stderr || err.stdout || String(err)}`
          : err.stderr || err.stdout || String(err),
      };
      await emitResult(result);
      return result;
    }

    // 2. Run tests
    let testCommandUsed = 'bun test';
    try {
      deps.log.debug({ handoffId }, 'scoping tests from git diff');
      const timeout = deps.settings?.reconcileTestTimeoutSec ?? 300;

      if (affectedPackages === null) {
        deps.log.debug({ handoffId }, 'running full test suite in worktree');
        testCommandUsed = 'bun test';
        const res = await runCmd(['bun', 'test'], wt.path, timeout);
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
        const scopedTestPaths = affectedPackages.map(pkg => `${pkg}/test/`);
        for (const testPath of scopedTestPaths) {
          if (!isValidTestPackagePath(testPath)) {
            return await emitInvalidInputResult('invalid_test_package_path', { field: 'test_path', value: testPath });
          }
        }
        deps.log.debug({ handoffId, affectedPackages }, 'running scoped tests in worktree');
        testCommandUsed = `bun test ${scopedTestPaths.join(' ')}`;
        const res = await runCmd(['bun', 'test', ...scopedTestPaths], wt.path, timeout);
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
        const diffNames = await runGit(['diff', '--name-only', `main...${wt.branchName}`], deps.mainRepoDir);
        if (!diffNames.stdout.trim()) {
          const result: MergeResult = { status: 'no_changes' };
          deps.log.info({ handoffId, branch: wt.branchName }, 'reconciliation complete — no branch changes');
          await emitResult(result);
          return result;
        }
        const diffStatsRes = await runGit(['diff', `main...${wt.branchName}`, '--shortstat'], wt.path);
        diffStats = parseShortStat(diffStatsRes.stdout);
        await attemptAutoRebaseIfNeeded();
        const shouldOpenPr = handoff?.open_pr_on_review === true
          || (handoff as unknown as { open_pr_on_review?: unknown })?.open_pr_on_review === 1;
        if (!shouldOpenPr) {
          const result: MergeResult = { status: 'verified' };
          deps.log.info({ handoffId, branch: wt.branchName }, 'reconciliation complete — verified without PR');
          await emitResult(result);
          return result;
        }
        const createPR = deps.createDispatchPR ?? createDispatchPR;
        const titleLine = dispatchPrompt.split('\n')[0] ?? '';
        const prResult = await createPR({
          branch: wt.branchName,
          baseBranch: 'main',
          title: `[${agentName}] ${titleLine.slice(0, 60)}`,
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
