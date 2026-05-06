import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';
import { createLogger, type Logger } from '../logger.js';

const exec = promisify(execCb);
const NOOP_LOG = createLogger({ component: 'worktree-manager', level: 'silent' });

export interface WorktreeHandle {
  handoffId: string;
  path: string;
  branchName: string;
  storageRoot: string;
  createdAt: string;
  status: 'created' | 'merged' | 'failed' | 'expired';
  projectId?: string;
}

export interface CreateOpts {
  baseRef?: string;
  project_id?: string;
}

export type ResolveProjectRoot = (project_id: string) => string | undefined;

interface WorktreeManagerOpts {
  rootDir?: string;
  mainRepoDir?: string;
  log?: Logger;
  resolveProjectRoot?: ResolveProjectRoot;
}

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeHandle>();
  private rootDir: string;
  private mainRepoDir: string;
  private log: Logger;
  private resolveProjectRoot?: ResolveProjectRoot;

  constructor(opts?: WorktreeManagerOpts) {
    this.rootDir =
      opts?.rootDir ||
      process.env.PENUMBRA_WORKTREE_ROOT ||
      '/Volumes/WorkSSD/repos/penumbra-worktrees/';
    this.mainRepoDir = opts?.mainRepoDir || process.cwd();
    this.log = opts?.log ?? NOOP_LOG;
    this.resolveProjectRoot = opts?.resolveProjectRoot;
    this.rediscoverWorktrees();
  }

  private baseFor(project_id?: string): string {
    if (project_id && this.resolveProjectRoot) {
      const root = this.resolveProjectRoot(project_id);
      if (root !== undefined) return `${root}-worktrees`;
    }
    return this.rootDir;
  }

  private repoRootFor(project_id?: string): string {
    if (project_id && this.resolveProjectRoot) {
      const root = this.resolveProjectRoot(project_id);
      if (root !== undefined) return root;
    }
    return this.mainRepoDir;
  }

  private rediscoverWorktrees() {
    if (!fs.existsSync(this.rootDir)) return;

    const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const handoffId = entry.name;
        const wtPath = path.join(this.rootDir, handoffId);

        // A valid git worktree has a .git file (not directory) containing `gitdir: ...`
        if (fs.existsSync(path.join(wtPath, '.git'))) {
          const branchName = `agent/${handoffId}`;
          const storageRoot = path.join(wtPath, '.test-storage');

          let createdAt = new Date().toISOString();
          try {
            const stat = fs.statSync(wtPath);
            createdAt = stat.birthtime.toISOString();
          } catch (e) {
            // Ignore stat errors
          }

          this.worktrees.set(handoffId, {
            handoffId,
            path: wtPath,
            branchName,
            storageRoot,
            createdAt,
            status: 'created',
          });
          mirrorNodeModuleSymlinks(this.mainRepoDir, wtPath, this.log);
        }
      }
    }
  }

  async createWorktree(
    handoffId: string,
    opts?: CreateOpts
  ): Promise<WorktreeHandle> {
    if (this.worktrees.has(handoffId)) {
      throw new Error(`Worktree for handoff ${handoffId} already exists`);
    }

    const project_id = opts?.project_id;
    const base = this.baseFor(project_id);
    const repoRoot = this.repoRootFor(project_id);

    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: true });
    }

    const wtPath = path.join(base, handoffId);
    const branchName = `agent/${handoffId}`;
    const baseRef = opts?.baseRef || 'HEAD';

    try {
      // 1. Add detached worktree
      await exec(`git worktree add --detach "${wtPath}" ${baseRef}`, {
        cwd: repoRoot,
      });

      // 2. Checkout new branch
      await exec(`git -C "${wtPath}" checkout -b "${branchName}"`);

      // 3. Symlink node_modules/ — top-level + every per-package node_modules.
      //    Bun's workspace install creates a node_modules/ in the root AND in each
      //    workspace package (e.g. packages/core/node_modules/zod -> ../../../node_modules/.bun/...).
      //    Without mirroring the per-package symlinks, tsc/bun in the worktree can't resolve
      //    workspace dependencies and typecheck/test fail with "Cannot find module 'zod'" etc.
      mirrorNodeModuleSymlinks(repoRoot, wtPath, this.log);

      // 4. Copy bun.lock (do not symlink to avoid dirty git state)
      const mainBunLock = path.join(repoRoot, 'bun.lock');
      const wtBunLock = path.join(wtPath, 'bun.lock');
      if (fs.existsSync(mainBunLock)) {
        fs.rmSync(wtBunLock, { force: true });
        fs.copyFileSync(mainBunLock, wtBunLock);
      }

      // 5. Create .test-storage/ dir
      const storageRoot = path.join(wtPath, '.test-storage');
      fs.mkdirSync(storageRoot, { recursive: true });

      const handle: WorktreeHandle = {
        handoffId,
        path: wtPath,
        branchName,
        storageRoot,
        createdAt: new Date().toISOString(),
        status: 'created',
        projectId: project_id,
      };

      this.worktrees.set(handoffId, handle);
      return handle;
    } catch (err) {
      // Clean up partially created worktree on failure
      if (fs.existsSync(wtPath)) {
        try {
          await exec(`git worktree remove --force "${wtPath}"`, {
            cwd: repoRoot,
          });
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
      }
      throw err;
    }
  }

  getWorktree(handoffId: string, project_id?: string): WorktreeHandle | null {
    const cached = this.worktrees.get(handoffId);
    if (cached) return cached;
    // Fallback: the daemon and worker each hold their own WorktreeManager
    // instance with separate in-memory maps. When the worker creates a
    // worktree (via worktree-integration.ts), the daemon's map doesn't see
    // it until the next process restart's rediscoverWorktrees() pass.
    // Hydrate from disk on demand if a valid git worktree exists at the
    // expected path — cheap (one stat) and keeps Phase 1b.2's MCP-tool
    // lookups consistent across processes.
    const base = this.baseFor(project_id);
    const wtPath = path.join(base, handoffId);
    if (!fs.existsSync(path.join(wtPath, '.git'))) return null;
    const branchName = `agent/${handoffId}`;
    const storageRoot = path.join(wtPath, '.test-storage');
    let createdAt = new Date().toISOString();
    try {
      createdAt = fs.statSync(wtPath).birthtime.toISOString();
    } catch {
      // ignore stat errors — synthesize a placeholder timestamp
    }
    const handle: WorktreeHandle = {
      handoffId,
      path: wtPath,
      branchName,
      storageRoot,
      createdAt,
      status: 'created',
      projectId: project_id,
    };
    this.worktrees.set(handoffId, handle);
    return handle;
  }

  listWorktrees(): WorktreeHandle[] {
    return Array.from(this.worktrees.values());
  }

  async teardownWorktree(
    handoffId: string,
    force?: boolean,
    project_id?: string
  ): Promise<void> {
    const handle = this.worktrees.get(handoffId);
    const effectiveProjectId = handle?.projectId ?? project_id;
    const repoRoot = this.repoRootFor(effectiveProjectId);

    if (!handle) {
      // Check if it exists on disk even if not in map (edge case)
      const base = this.baseFor(effectiveProjectId);
      const wtPath = path.join(base, handoffId);
      if (fs.existsSync(wtPath)) {
         const forceFlag = force ? '--force' : '';
         await exec(`git worktree remove ${forceFlag} "${wtPath}"`, {
            cwd: repoRoot,
          }).catch(() => {});
      }
      return;
    }

    const forceFlag = force ? '--force' : '';

    if (!force) {
      // Remove framework-injected files so git doesn't complain about modified/untracked files
      const wtBunLock = path.join(handle.path, 'bun.lock');
      if (fs.existsSync(wtBunLock)) {
        fs.rmSync(wtBunLock, { force: true });
        // bun.lock is git-tracked here, so restore the tracked copy before
        // `git worktree remove` checks for local modifications.
        await exec(`git -C "${handle.path}" checkout bun.lock`).catch(() => {});
      }
      const storageRoot = path.join(handle.path, '.test-storage');
      if (fs.existsSync(storageRoot)) {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
      // Remove every node_modules symlink we mirrored in (top-level + per-package).
      // .gitignore's `node_modules/` rule matches directories but not symlinks, so without
      // cleanup `git worktree remove` (non-force) treats them as untracked.
      removeNodeModuleSymlinks(repoRoot, handle.path, this.log);
    }

    try {
      await exec(`git worktree remove ${forceFlag} "${handle.path}"`, {
        cwd: repoRoot,
      });
    } catch (err) {
      throw new Error(`Failed to remove worktree ${handle.path}: ${err}`);
    }

    try {
      await exec(`git branch -D "${handle.branchName}"`, {
        cwd: repoRoot,
      });
    } catch (err) {
      // Ignore if branch deletion fails (e.g., if it didn't exist)
    }

    this.worktrees.delete(handoffId);
  }
}

function mirrorNodeModuleSymlinks(mainRoot: string, wtRoot: string, log: Logger = NOOP_LOG): void {
  if (resolveExistingPath(mainRoot) === resolveExistingPath(wtRoot)) {
    return;
  }

  const topMain = path.join(mainRoot, 'node_modules');
  const topWt = path.join(wtRoot, 'node_modules');
  if (fs.existsSync(topMain)) {
    mirrorSingleNodeModules(topMain, topWt, log);
  }

  for (const relDir of getWorkspaceDirsWithNodeModules(mainRoot, log)) {
    mirrorSingleNodeModules(
      path.join(mainRoot, relDir, 'node_modules'),
      path.join(wtRoot, relDir, 'node_modules'),
      log
    );
  }
}

function removeNodeModuleSymlinks(
  mainRoot: string,
  wtRoot: string,
  log: Logger = NOOP_LOG
): void {
  tryRemoveNodeModules(path.join(wtRoot, 'node_modules'), log);

  for (const relDir of getWorkspaceDirsWithNodeModules(mainRoot, log)) {
    tryRemoveNodeModules(path.join(wtRoot, relDir, 'node_modules'), log);
  }
}

function mirrorSingleNodeModules(mainNm: string, wtNm: string, log: Logger): void {
  try {
    fs.rmSync(wtNm, { recursive: true, force: true });
  } catch (err) {
    logCaughtError(log, 'failed to remove existing worktree node_modules', err, { path: wtNm });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(wtNm), { recursive: true });
    fs.symlinkSync(mainNm, wtNm, 'dir');
  } catch (err) {
    logCaughtError(log, 'failed to mirror worktree node_modules symlink', err, {
      path: wtNm,
      target: mainNm,
    });
    return;
  }

  try {
    if (fs.readlinkSync(wtNm) !== mainNm) {
      log.warn({ path: wtNm, target: mainNm }, 'mirrored worktree node_modules symlink target mismatch');
    }
  } catch (err) {
    logCaughtError(log, 'failed to verify mirrored worktree node_modules symlink', err, {
      path: wtNm,
      target: mainNm,
    });
  }
}

function tryRemoveNodeModules(targetPath: string, log: Logger): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  } catch (err) {
    if (isMissingError(err)) return;
    logCaughtError(log, 'failed to remove mirrored worktree node_modules', err, {
      path: targetPath,
    });
  }
}

function getWorkspaceDirsWithNodeModules(mainRoot: string, log: Logger): string[] {
  const packageJsonPath = path.join(mainRoot, 'package.json');
  let rawPackageJson: string;
  try {
    rawPackageJson = fs.readFileSync(packageJsonPath, 'utf8');
  } catch (err) {
    logCaughtError(log, 'failed to read main repo package.json for workspaces', err, {
      path: packageJsonPath,
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPackageJson);
  } catch (err) {
    logCaughtError(log, 'failed to parse main repo package.json for workspaces', err, {
      path: packageJsonPath,
    });
    return [];
  }

  const matches = new Set<string>();
  for (const pattern of extractWorkspacePatterns(parsed)) {
    for (const relDir of expandWorkspacePattern(mainRoot, pattern, log)) {
      if (fs.existsSync(path.join(mainRoot, relDir, 'node_modules'))) {
        matches.add(relDir);
      }
    }
  }
  return [...matches];
}

function extractWorkspacePatterns(parsedPackageJson: unknown): string[] {
  if (!parsedPackageJson || typeof parsedPackageJson !== 'object') {
    return [];
  }

  const workspaces = (parsedPackageJson as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((pattern): pattern is string => typeof pattern === 'string');
  }

  if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((pattern): pattern is string => typeof pattern === 'string');
    }
  }

  return [];
}

function expandWorkspacePattern(mainRoot: string, pattern: string, log: Logger): string[] {
  const segments = pattern.replace(/\\/g, '/').split('/').filter(Boolean);
  const matches: string[] = [];

  const visit = (index: number, relDir: string) => {
    if (index === segments.length) {
      matches.push(relDir);
      return;
    }

    const segment = segments[index]!;
    if (!segment.includes('*')) {
      const nextRel = relDir ? path.join(relDir, segment) : segment;
      const nextAbs = path.join(mainRoot, nextRel);
      try {
        if (fs.statSync(nextAbs).isDirectory()) {
          visit(index + 1, nextRel);
        }
      } catch (err) {
        if (isMissingError(err)) return;
        logCaughtError(log, 'failed to inspect workspace path while expanding workspaces', err, {
          path: nextAbs,
          pattern,
        });
      }
      return;
    }

    const currentAbs = path.join(mainRoot, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    } catch (err) {
      if (isMissingError(err)) return;
      logCaughtError(log, 'failed to read workspace parent while expanding workspaces', err, {
        path: currentAbs,
        pattern,
      });
      return;
    }

    const segmentPattern = globSegmentToRegExp(segment);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!segmentPattern.test(entry.name)) continue;
      const nextRel = relDir ? path.join(relDir, entry.name) : entry.name;
      visit(index + 1, nextRel);
    }
  };

  visit(0, '');
  return matches;
}

function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function isMissingError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

function resolveExistingPath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function logCaughtError(
  log: Logger,
  message: string,
  err: unknown,
  context: Record<string, unknown>
): void {
  log.warn({ ...context, err }, message);
}
