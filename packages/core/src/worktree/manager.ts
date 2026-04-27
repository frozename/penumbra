import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

export interface WorktreeHandle {
  handoffId: string;
  path: string;
  branchName: string;
  storageRoot: string;
  createdAt: string;
  status: 'created' | 'merged' | 'failed' | 'expired';
}

export interface CreateOpts {
  baseRef?: string;
}

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeHandle>();
  private rootDir: string;
  private mainRepoDir: string;

  constructor(opts?: { rootDir?: string; mainRepoDir?: string }) {
    this.rootDir =
      opts?.rootDir ||
      process.env.PENUMBRA_WORKTREE_ROOT ||
      '/Volumes/WorkSSD/repos/penumbra-worktrees/';
    this.mainRepoDir = opts?.mainRepoDir || process.cwd();
    this.rediscoverWorktrees();
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

    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }

    const wtPath = path.join(this.rootDir, handoffId);
    const branchName = `agent/${handoffId}`;
    const baseRef = opts?.baseRef || 'HEAD';

    try {
      // 1. Add detached worktree
      await exec(`git worktree add --detach "${wtPath}" ${baseRef}`, {
        cwd: this.mainRepoDir,
      });

      // 2. Checkout new branch
      await exec(`git -C "${wtPath}" checkout -b "${branchName}"`);

      // 3. Symlink node_modules/ — top-level + every per-package node_modules.
      //    Bun's workspace install creates a node_modules/ in the root AND in each
      //    workspace package (e.g. packages/core/node_modules/zod -> ../../../node_modules/.bun/...).
      //    Without mirroring the per-package symlinks, tsc/bun in the worktree can't resolve
      //    workspace dependencies and typecheck/test fail with "Cannot find module 'zod'" etc.
      mirrorNodeModuleSymlinks(this.mainRepoDir, wtPath);

      // 4. Copy bun.lock (do not symlink to avoid dirty git state)
      const mainBunLock = path.join(this.mainRepoDir, 'bun.lock');
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
      };

      this.worktrees.set(handoffId, handle);
      return handle;
    } catch (err) {
      // Clean up partially created worktree on failure
      if (fs.existsSync(wtPath)) {
        try {
          await exec(`git worktree remove --force "${wtPath}"`, {
            cwd: this.mainRepoDir,
          });
        } catch (cleanupErr) {
          // Ignore cleanup errors
        }
      }
      throw err;
    }
  }

  getWorktree(handoffId: string): WorktreeHandle | null {
    return this.worktrees.get(handoffId) || null;
  }

  listWorktrees(): WorktreeHandle[] {
    return Array.from(this.worktrees.values());
  }

  async teardownWorktree(handoffId: string, force?: boolean): Promise<void> {
    const handle = this.worktrees.get(handoffId);
    if (!handle) {
      // Check if it exists on disk even if not in map (edge case)
      const wtPath = path.join(this.rootDir, handoffId);
      if (fs.existsSync(wtPath)) {
         const forceFlag = force ? '--force' : '';
         await exec(`git worktree remove ${forceFlag} "${wtPath}"`, {
            cwd: this.mainRepoDir,
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
        await exec(`git -C "${handle.path}" checkout bun.lock`).catch(() => {});
      }
      const storageRoot = path.join(handle.path, '.test-storage');
      if (fs.existsSync(storageRoot)) {
        fs.rmSync(storageRoot, { recursive: true, force: true });
      }
      // Remove every node_modules symlink we mirrored in (top-level + per-package).
      // .gitignore's `node_modules/` rule matches directories but not symlinks, so without
      // cleanup `git worktree remove` (non-force) treats them as untracked.
      removeNodeModuleSymlinks(handle.path);
    }

    try {
      await exec(`git worktree remove ${forceFlag} "${handle.path}"`, {
        cwd: this.mainRepoDir,
      });
    } catch (err) {
      throw new Error(`Failed to remove worktree ${handle.path}: ${err}`);
    }

    try {
      await exec(`git branch -D "${handle.branchName}"`, {
        cwd: this.mainRepoDir,
      });
    } catch (err) {
      // Ignore if branch deletion fails (e.g., if it didn't exist)
    }

    this.worktrees.delete(handoffId);
  }
}

function mirrorNodeModuleSymlinks(mainRoot: string, wtRoot: string): void {
  const visit = (relDir: string) => {
    const mainAbs = path.join(mainRoot, relDir);
    const wtAbs = path.join(wtRoot, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(mainAbs, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink())) {
        const wtNm = path.join(wtAbs, 'node_modules');
        try {
          fs.rmSync(wtNm, { recursive: true, force: true });
        } catch {
          // ignore
        }
        try {
          fs.mkdirSync(wtAbs, { recursive: true });
          fs.symlinkSync(path.join(mainAbs, 'node_modules'), wtNm, 'dir');
        } catch {
          // ignore — symlink failures are best-effort per directory
        }
        continue;
      }
      if (entry.isDirectory() && entry.name !== '.git' && !entry.name.startsWith('.')) {
        visit(path.join(relDir, entry.name));
      }
    }
  };

  // Top-level node_modules
  const topMain = path.join(mainRoot, 'node_modules');
  const topWt = path.join(wtRoot, 'node_modules');
  if (fs.existsSync(topMain)) {
    try { fs.rmSync(topWt, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.symlinkSync(topMain, topWt, 'dir');
  }

  // Per-package node_modules under packages/**
  const pkgRoot = path.join(mainRoot, 'packages');
  if (fs.existsSync(pkgRoot)) {
    visit('packages');
  }
}

function removeNodeModuleSymlinks(wtRoot: string): void {
  const tryRemove = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {
      // doesn't exist — fine
    }
  };

  tryRemove(path.join(wtRoot, 'node_modules'));

  const visit = (relDir: string) => {
    const abs = path.join(wtRoot, relDir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') {
        tryRemove(path.join(abs, 'node_modules'));
        continue;
      }
      if (entry.isDirectory() && entry.name !== '.git' && !entry.name.startsWith('.')) {
        visit(path.join(relDir, entry.name));
      }
    }
  };
  if (fs.existsSync(path.join(wtRoot, 'packages'))) {
    visit('packages');
  }
}
