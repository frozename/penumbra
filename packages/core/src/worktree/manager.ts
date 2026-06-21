import { execFile as execFileCb, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { createLogger, type Logger } from "../logger.js";

const execFile = promisify(execFileCb);
const NOOP_LOG = createLogger({ component: "worktree-manager", level: "silent" });
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKTREE_MODE_FILE = ".test-storage/worktree-mode";
const WORKTREE_READY_FILE = ".test-storage/worktree-ready";
const DEFAULT_ISOLATED_INSTALL_TIMEOUT_MS = 120_000;
const ISOLATED_INSTALL_MAX_BUFFER = 1024 * 1024 * 10;
const UNREADY_WORKTREE_ORPHAN_GRACE_MS = 15 * 60_000;
// Stderr kept for error context only; cap it so a chatty child cannot balloon memory.
const SPAWN_STDERR_CAP = 16 * 1024;

export type WorktreeMode = "symlink_mirror" | "isolated_install";

export interface WorktreeCommandRunnerOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  stdio?: "ignore";
}

export type WorktreeCommandRunner = (
  cmd: string,
  args: string[],
  opts?: WorktreeCommandRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeHandle {
  handoffId: string;
  path: string;
  branchName: string;
  storageRoot: string;
  createdAt: string;
  status: "created" | "merged" | "failed" | "expired";
  projectId?: string;
  worktreeMode: WorktreeMode;
}

export interface OrphanWorktreeHandle {
  path: string;
  handoffId: string;
}

export interface CreateOpts {
  baseRef?: string;
  project_id?: string;
  isolated_install?: boolean;
  signal?: AbortSignal;
}

export type ResolveProjectRoot = (project_id: string) => string | undefined;

interface WorktreeManagerOpts {
  rootDir?: string;
  mainRepoDir?: string;
  log?: Logger;
  resolveProjectRoot?: ResolveProjectRoot;
  runner?: WorktreeCommandRunner;
}

function defaultRunner(
  cmd: string,
  args: string[],
  opts?: WorktreeCommandRunnerOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (opts?.stdio === "ignore") {
    return spawnSilent(cmd, args, opts);
  }
  return execFile(cmd, args, { ...opts, encoding: opts?.encoding ?? "utf8" });
}

function spawnSilent(
  cmd: string,
  args: string[],
  opts: WorktreeCommandRunnerOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    let timedOut = false;
    let stderrText = "";
    const stderrCap = opts.maxBuffer ?? SPAWN_STDERR_CAP;
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrText.length < stderrCap) {
        stderrText = (stderrText + String(chunk)).slice(0, stderrCap);
      }
    });
    // On timeout the child is killed but the rejection waits for the exit
    // event: rejecting early would let the caller tear the worktree down
    // underneath a still-running process.
    const timeout =
      opts.timeout !== undefined
        ? setTimeout(() => {
            if (settled) return;
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeout)
        : null;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      fn();
    };
    // An external AbortSignal surfaces here as an unwrapped ABORT_ERR — it
    // must stay distinguishable from a timeout for the caller's retry logic.
    child.on("error", (err) => {
      settle(() => {
        reject(err);
      });
    });
    child.on("exit", (code, signal) => {
      settle(() => {
        const detail = stderrText.trim();
        if (timedOut) {
          const timeoutMs = opts.timeout ?? 0;
          const err = new Error(
            `spawn ${cmd} timed out after ${String(timeoutMs)}ms${detail ? `: ${detail}` : ""}`,
          ) as Error & { code: string; signal: NodeJS.Signals | null };
          err.code = "ETIMEDOUT";
          err.signal = signal;
          reject(err);
          return;
        }
        if (code === 0) {
          resolve({ stdout: "", stderr: stderrText });
          return;
        }
        const reason = signal ? `signal ${signal}` : `code ${String(code)}`;
        const err = new Error(
          `${cmd} exited with ${reason}${detail ? `: ${detail}` : ""}`,
        ) as Error & {
          code?: number | string | null;
          signal?: NodeJS.Signals | null;
        };
        err.code = code;
        err.signal = signal;
        reject(err);
      });
    });
  });
}

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeHandle>();
  private rootDir: string;
  #mainRepoDir: string;
  private log: Logger;
  private resolveProjectRoot?: ResolveProjectRoot;
  private runner: WorktreeCommandRunner;

  constructor(opts?: WorktreeManagerOpts) {
    this.#mainRepoDir = opts?.mainRepoDir ?? process.cwd();
    this.log = opts?.log ?? NOOP_LOG;
    this.resolveProjectRoot = opts?.resolveProjectRoot;
    this.runner = opts?.runner ?? defaultRunner;
    this.rootDir =
      opts?.rootDir ??
      process.env["PENUMBRA_WORKTREE_ROOT"] ??
      `${this.repoRootFor(undefined)}-worktrees`;
    this.rediscoverWorktrees();
  }

  public get mainRepoDir(): string {
    return this.#mainRepoDir;
  }

  private git(
    args: string[],
    opts?: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return this.runner("git", args, { ...opts, encoding: "utf8" });
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
    return this.#mainRepoDir;
  }

  public projectRootFor(project_id?: string): string | undefined {
    if (project_id && this.resolveProjectRoot) {
      return this.resolveProjectRoot(project_id);
    }
    return undefined;
  }

  private discoveryBases(): string[] {
    return [...new Set([this.baseFor(undefined)])];
  }

  private rediscoverEntry(base: string, entry: fs.Dirent): void {
    if (!entry.isDirectory()) return;
    const handoffId = entry.name;
    const wtPath = path.join(base, handoffId);
    if (!fs.existsSync(path.join(wtPath, ".git"))) return;
    const branchName = `agent/${handoffId}`;
    const storageRoot = path.join(wtPath, ".test-storage");
    const worktreeMode = inferWorktreeMode(wtPath);
    if (!isWorktreeReadySync(wtPath, worktreeMode, handoffId)) return;

    let createdAt = new Date().toISOString();
    try {
      createdAt = fs.statSync(wtPath).birthtime.toISOString();
    } catch {
      // ignore stat errors
    }

    this.worktrees.set(handoffId, {
      handoffId,
      path: wtPath,
      branchName,
      storageRoot,
      createdAt,
      status: "created",
      worktreeMode,
    });
    if (worktreeMode === "symlink_mirror") {
      mirrorNodeModuleSymlinks(this.#mainRepoDir, wtPath, this.log);
    }
  }

  private rediscoverWorktrees(): void {
    for (const base of this.discoveryBases()) {
      if (!fs.existsSync(base)) continue;
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const entry of entries) this.rediscoverEntry(base, entry);
    }
  }

  private copyBunLockIfNeeded(wtPath: string, repoRoot: string, worktreeMode: WorktreeMode): void {
    if (worktreeMode === "isolated_install") return;
    const mainBunLock = path.join(repoRoot, "bun.lock");
    const wtBunLock = path.join(wtPath, "bun.lock");
    if (fs.existsSync(mainBunLock)) {
      fs.rmSync(wtBunLock, { force: true });
      fs.copyFileSync(mainBunLock, wtBunLock);
    }
  }

  private async finalizeWorktreeMode(
    wtPath: string,
    repoRoot: string,
    handoffId: string,
    worktreeMode: WorktreeMode,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (worktreeMode === "isolated_install") {
      await this.runIsolatedInstall(wtPath, signal);
    } else {
      mirrorNodeModuleSymlinks(repoRoot, wtPath, this.log);
    }
    writeWorktreeReady(wtPath, handoffId);
  }

  async createWorktree(handoffId: string, opts?: CreateOpts): Promise<WorktreeHandle> {
    if (this.worktrees.has(handoffId)) {
      throw new Error(`Worktree for handoff ${handoffId} already exists`);
    }

    const project_id = opts?.project_id;
    if (
      project_id &&
      this.resolveProjectRoot &&
      this.resolveProjectRoot(project_id) === undefined
    ) {
      throw new Error(`unknown_project_id: ${project_id}`);
    }
    const base = this.baseFor(project_id);
    const repoRoot = this.repoRootFor(project_id);

    if (!fs.existsSync(base)) {
      fs.mkdirSync(base, { recursive: true });
    }

    const wtPath = path.join(base, handoffId);
    const branchName = `agent/${handoffId}`;
    const baseRef = opts?.baseRef ?? "HEAD";
    const worktreeMode: WorktreeMode = opts?.isolated_install
      ? "isolated_install"
      : "symlink_mirror";

    try {
      await this.git(["worktree", "add", "--detach", wtPath, baseRef], { cwd: repoRoot });
      await this.git(["-C", wtPath, "checkout", "-b", branchName]);
      this.copyBunLockIfNeeded(wtPath, repoRoot, worktreeMode);

      const storageRoot = path.join(wtPath, ".test-storage");
      fs.mkdirSync(storageRoot, { recursive: true });
      writeWorktreeMode(wtPath, worktreeMode);

      await this.finalizeWorktreeMode(wtPath, repoRoot, handoffId, worktreeMode, opts?.signal);

      const handle: WorktreeHandle = {
        handoffId,
        path: wtPath,
        branchName,
        storageRoot,
        createdAt: new Date().toISOString(),
        status: "created",
        projectId: project_id,
        worktreeMode,
      };

      this.worktrees.set(handoffId, handle);
      return handle;
    } catch (err) {
      await this.removePartialWorktree(wtPath, repoRoot);
      throw err;
    }
  }

  private async removePartialWorktree(wtPath: string, repoRoot: string): Promise<void> {
    if (!fs.existsSync(wtPath)) return;
    try {
      await this.git(["worktree", "remove", "--force", wtPath], {
        cwd: repoRoot,
      });
    } catch {
      // Directory may not be registered as a git worktree yet.
    }
    try {
      await fs.promises.rm(wtPath, { recursive: true, force: true });
    } catch (err) {
      // Best-effort: a deletion failure (EBUSY etc.) must never mask the
      // original install error the caller is about to rethrow; the unready
      // directory is reaped later by the grace-period GC.
      const errMessage = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: errMessage, wtPath }, "partial worktree cleanup failed");
    }
  }

  private async runIsolatedInstall(wtPath: string, signal?: AbortSignal): Promise<void> {
    const timeout = readPositiveIntEnv(
      "PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS",
      DEFAULT_ISOLATED_INSTALL_TIMEOUT_MS,
    );
    try {
      await this.runner("bun", ["install", "--ignore-scripts", "--frozen-lockfile"], {
        cwd: wtPath,
        timeout,
        maxBuffer: ISOLATED_INSTALL_MAX_BUFFER,
        encoding: "utf8",
        signal,
        stdio: "ignore",
      });
    } catch (err) {
      // A deliberate cancellation is not a timeout — re-throw it unwrapped so
      // callers can distinguish the two.
      if (isAbortError(err)) throw err;
      if (isTimeoutError(err)) {
        throw new Error(`isolated bun install timed out after ${String(timeout)}ms`, {
          cause: err instanceof Error ? err : new Error(String(err)),
        });
      }
      throw err;
    }
  }

  async stageMergedBase(
    handoffId: string,
    ancestorRefs: string[],
    opts?: { project_id?: string },
  ): Promise<string> {
    const firstRef = ancestorRefs[0];
    if (firstRef === undefined) {
      throw new Error("stageMergedBase: empty ancestorRefs");
    }
    if (ancestorRefs.length === 1) return firstRef;

    const repoRoot = this.repoRootFor(opts?.project_id);
    const base = this.baseFor(opts?.project_id);
    const scratchPath = path.join(base, `.stage-${handoffId}`);
    const stageBranch = `stage/${handoffId}`;

    await this.git(["-C", repoRoot, "branch", "-f", stageBranch, firstRef]);
    await this.git(["-C", repoRoot, "worktree", "add", "--detach", scratchPath, stageBranch]);

    try {
      for (const ref of ancestorRefs.slice(1)) {
        await this.git([
          "-C",
          scratchPath,
          "-c",
          "user.email=plan-runtime@penumbra.local",
          "-c",
          "user.name=Plan Runtime",
          "merge",
          "--no-ff",
          "--no-edit",
          "-m",
          `stage: merge ${ref}`,
          ref,
        ]);
      }
      const { stdout } = await this.git(["-C", scratchPath, "rev-parse", "HEAD"]);
      const headSha = stdout.trim();
      await this.git(["-C", repoRoot, "branch", "-f", stageBranch, headSha]);
      return stageBranch;
    } finally {
      try {
        await this.git(["-C", repoRoot, "worktree", "remove", "--force", scratchPath]);
      } catch {
        // ignore cleanup errors
      }
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
    if (!fs.existsSync(path.join(wtPath, ".git"))) return null;
    const worktreeMode = inferWorktreeMode(wtPath);
    if (!isWorktreeReadySync(wtPath, worktreeMode, handoffId)) return null;
    const branchName = `agent/${handoffId}`;
    const storageRoot = path.join(wtPath, ".test-storage");
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
      status: "created",
      projectId: project_id,
      worktreeMode,
    };
    this.worktrees.set(handoffId, handle);
    return handle;
  }

  listWorktrees(): WorktreeHandle[] {
    return Array.from(this.worktrees.values());
  }

  private async classifyOrphanEntry(
    base: string,
    entry: fs.Dirent,
  ): Promise<OrphanWorktreeHandle | null> {
    if (!entry.isDirectory()) return null;
    const handoffId = entry.name;
    if (!UUID_DIR_RE.test(handoffId)) return null;
    if (this.worktrees.has(handoffId)) return null;

    const wtPath = path.join(base, handoffId);
    try {
      await fs.promises.access(path.join(wtPath, ".git"));
    } catch {
      return null;
    }
    const worktreeMode = inferWorktreeMode(wtPath);
    if (await isWorktreeReady(wtPath, worktreeMode, handoffId)) {
      return { path: wtPath, handoffId };
    }
    if (await isUnreadyWorktreePastGrace(wtPath)) {
      return { path: wtPath, handoffId };
    }
    return null;
  }

  async discoverOrphanWorktrees(): Promise<OrphanWorktreeHandle[]> {
    const orphans: OrphanWorktreeHandle[] = [];
    for (const base of this.discoveryBases()) {
      try {
        const baseStat = await fs.promises.stat(base);
        if (!baseStat.isDirectory()) continue;
      } catch {
        continue;
      }
      const entries = await fs.promises.readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        const orphan = await this.classifyOrphanEntry(base, entry);
        if (orphan) orphans.push(orphan);
      }
    }

    return orphans.sort((a, b) => a.handoffId.localeCompare(b.handoffId));
  }

  private hydrateMissingHandle(
    handoffId: string,
    project_id: string | undefined,
  ): WorktreeHandle | null {
    const base = this.baseFor(project_id);
    const wtPath = path.join(base, handoffId);
    if (!fs.existsSync(wtPath)) return null;
    let createdAt = new Date().toISOString();
    try {
      createdAt = fs.statSync(wtPath).birthtime.toISOString();
    } catch {
      // ignore stat errors — synthesize a placeholder timestamp
    }
    return {
      handoffId,
      path: wtPath,
      branchName: `agent/${handoffId}`,
      storageRoot: path.join(wtPath, ".test-storage"),
      createdAt,
      status: "created",
      projectId: project_id,
      worktreeMode: inferWorktreeMode(wtPath),
    };
  }

  private async preCleanForTeardown(handle: WorktreeHandle, handoffId: string): Promise<void> {
    const wtBunLock = path.join(handle.path, "bun.lock");
    if (fs.existsSync(wtBunLock)) {
      fs.rmSync(wtBunLock, { force: true });
      try {
        await this.git(["-C", handle.path, "checkout", "bun.lock"]);
      } catch (err) {
        this.log.warn(
          { handoff_id: handoffId, path: handle.path, err: String(err) },
          "failed to restore bun.lock before worktree removal",
        );
      }
    }
    const storageRoot = path.join(handle.path, ".test-storage");
    if (fs.existsSync(storageRoot)) {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
    fs.rmSync(path.join(handle.path, ".penumbra-worktree-mode"), { force: true });
    fs.rmSync(path.join(handle.path, WORKTREE_MODE_FILE), { force: true });
    fs.rmSync(path.join(handle.path, WORKTREE_READY_FILE), { force: true });
  }

  private async runWorktreeRemove(
    handle: WorktreeHandle,
    handoffId: string,
    force: boolean,
    repoRoot: string,
  ): Promise<void> {
    try {
      await this.git(["worktree", "remove", ...(force ? ["--force"] : []), handle.path], {
        cwd: repoRoot,
      });
      return;
    } catch (err) {
      if (force) {
        throw new Error(`Failed to remove worktree ${handle.path}: ${String(err)}`);
      }
      this.log.warn(
        { handoff_id: handoffId, path: handle.path, err: String(err) },
        "worktree remove failed without force; retrying with --force",
      );
      try {
        await this.git(["worktree", "remove", "--force", handle.path], { cwd: repoRoot });
      } catch (forceErr) {
        throw new Error(`Failed to remove worktree ${handle.path}: ${String(forceErr)}`);
      }
    }
  }

  private async verifyBranchDeleted(handle: WorktreeHandle, repoRoot: string): Promise<boolean> {
    try {
      await this.git(["branch", "-D", handle.branchName], { cwd: repoRoot });
    } catch {
      // branch deletion is verified below
    }
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${handle.branchName}`], {
        cwd: repoRoot,
      });
      return false;
    } catch {
      return true;
    }
  }

  async teardownWorktree(
    handoffId: string,
    force?: boolean,
    project_id?: string,
    deleteBranch = true,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean }> {
    let handle = this.worktrees.get(handoffId);
    const effectiveProjectId = handle?.projectId ?? project_id;
    const repoRoot = this.repoRootFor(effectiveProjectId);

    if (!handle) {
      const hydrated = this.hydrateMissingHandle(handoffId, project_id);
      if (!hydrated) return { worktreeRemoved: false, branchDeleted: false };
      handle = hydrated;
    }

    if (!force) {
      await this.preCleanForTeardown(handle, handoffId);
    }
    removeNodeModuleSymlinks(repoRoot, handle.path, this.log);

    await this.runWorktreeRemove(handle, handoffId, force ?? false, repoRoot);

    if (fs.existsSync(handle.path)) {
      throw new Error(`worktree remove reported success but path still exists: ${handle.path}`);
    }

    const branchDeleted = deleteBranch ? await this.verifyBranchDeleted(handle, repoRoot) : false;

    this.worktrees.delete(handoffId);
    return { worktreeRemoved: true, branchDeleted };
  }
}

function writeWorktreeMode(wtRoot: string, mode: WorktreeMode): void {
  fs.mkdirSync(path.dirname(path.join(wtRoot, WORKTREE_MODE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(wtRoot, WORKTREE_MODE_FILE), `${mode}\n`);
}

function writeWorktreeReady(wtRoot: string, handoffId: string): void {
  fs.mkdirSync(path.dirname(path.join(wtRoot, WORKTREE_READY_FILE)), { recursive: true });
  fs.writeFileSync(path.join(wtRoot, WORKTREE_READY_FILE), `${handoffId}\n`);
}

function inferWorktreeMode(wtRoot: string): WorktreeMode {
  const marker = path.join(wtRoot, WORKTREE_MODE_FILE);
  try {
    const raw = fs.readFileSync(marker, "utf8").trim();
    if (raw === "isolated_install" || raw === "symlink_mirror") return raw;
  } catch (err) {
    if (!isMissingError(err)) throw err;
  }

  // Absent marker -> symlink_mirror unconditionally: mirroring is idempotent,
  // so a misclassified symlink worktree self-heals, whereas guessing
  // isolated_install from a real node_modules directory would preserve the
  // broken state of a worktree that died mid-install.
  return "symlink_mirror";
}

// Deliberately asymmetric: symlink_mirror needs no sentinel because
// re-mirroring on rediscovery is idempotent and self-heals a crash
// mid-setup, and demanding one would orphan every worktree created before
// the sentinel existed. Isolated installs cannot self-heal, hence the marker.
async function isWorktreeReady(
  wtRoot: string,
  mode: WorktreeMode,
  handoffId: string,
): Promise<boolean> {
  if (mode === "symlink_mirror") return true;
  try {
    const readyFor = (
      await fs.promises.readFile(path.join(wtRoot, WORKTREE_READY_FILE), "utf8")
    ).trim();
    return readyFor === handoffId;
  } catch (err) {
    if (isMissingError(err)) return false;
    throw err;
  }
}

function isWorktreeReadySync(wtRoot: string, mode: WorktreeMode, handoffId: string): boolean {
  if (mode === "symlink_mirror") return true;
  try {
    return fs.readFileSync(path.join(wtRoot, WORKTREE_READY_FILE), "utf8").trim() === handoffId;
  } catch (err) {
    if (isMissingError(err)) return false;
    throw err;
  }
}

// An unready worktree may still be mid-install: the reap grace must always
// exceed the configured install timeout, whatever it is tuned to.
function unreadyWorktreeGraceMs(): number {
  const installTimeoutMs = readPositiveIntEnv(
    "PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS",
    DEFAULT_ISOLATED_INSTALL_TIMEOUT_MS,
  );
  return Math.max(UNREADY_WORKTREE_ORPHAN_GRACE_MS, installTimeoutMs + 5 * 60_000);
}

async function isUnreadyWorktreePastGrace(wtRoot: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(wtRoot);
    return Date.now() - stat.birthtimeMs > unreadyWorktreeGraceMs();
  } catch {
    return false;
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Only the explicit ETIMEDOUT set by spawnSilent's self-timeout counts: an
// external AbortSignal also kills via signal, and matching on signals or
// message text would misreport a deliberate cancellation as a timeout.
function isTimeoutError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? String((err as { code?: unknown }).code) : "";
  return code === "ETIMEDOUT";
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? String((err as { code?: unknown }).code) : "";
  return code === "ABORT_ERR";
}

function mirrorNodeModuleSymlinks(mainRoot: string, wtRoot: string, log: Logger = NOOP_LOG): void {
  if (resolveExistingPath(mainRoot) === resolveExistingPath(wtRoot)) {
    return;
  }

  const topMain = path.join(mainRoot, "node_modules");
  const topWt = path.join(wtRoot, "node_modules");
  if (fs.existsSync(topMain)) {
    mirrorSingleNodeModules(topMain, topWt, log);
  }

  for (const relDir of getWorkspaceDirsWithNodeModules(mainRoot, log)) {
    mirrorSingleNodeModules(
      path.join(mainRoot, relDir, "node_modules"),
      path.join(wtRoot, relDir, "node_modules"),
      log,
    );
  }
}

function removeNodeModuleSymlinks(mainRoot: string, wtRoot: string, log: Logger = NOOP_LOG): void {
  tryRemoveNodeModules(path.join(wtRoot, "node_modules"), log);

  for (const relDir of getWorkspaceDirsWithNodeModules(mainRoot, log)) {
    tryRemoveNodeModules(path.join(wtRoot, relDir, "node_modules"), log);
  }
}

function mirrorSingleNodeModules(mainNm: string, wtNm: string, log: Logger): void {
  try {
    fs.rmSync(wtNm, { recursive: true, force: true });
  } catch (err) {
    logCaughtError(log, "failed to remove existing worktree node_modules", err, { path: wtNm });
    return;
  }

  try {
    fs.mkdirSync(path.dirname(wtNm), { recursive: true });
    fs.symlinkSync(mainNm, wtNm, "dir");
  } catch (err) {
    logCaughtError(log, "failed to mirror worktree node_modules symlink", err, {
      path: wtNm,
      target: mainNm,
    });
    return;
  }

  try {
    if (fs.readlinkSync(wtNm) !== mainNm) {
      log.warn(
        { path: wtNm, target: mainNm },
        "mirrored worktree node_modules symlink target mismatch",
      );
    }
  } catch (err) {
    logCaughtError(log, "failed to verify mirrored worktree node_modules symlink", err, {
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
    logCaughtError(log, "failed to remove mirrored worktree node_modules", err, {
      path: targetPath,
    });
  }
}

function getWorkspaceDirsWithNodeModules(mainRoot: string, log: Logger): string[] {
  const packageJsonPath = path.join(mainRoot, "package.json");
  let rawPackageJson: string;
  try {
    rawPackageJson = fs.readFileSync(packageJsonPath, "utf8");
  } catch (err) {
    logCaughtError(log, "failed to read main repo package.json for workspaces", err, {
      path: packageJsonPath,
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPackageJson);
  } catch (err) {
    logCaughtError(log, "failed to parse main repo package.json for workspaces", err, {
      path: packageJsonPath,
    });
    return [];
  }

  const matches = new Set<string>();
  for (const pattern of extractWorkspacePatterns(parsed)) {
    for (const relDir of expandWorkspacePattern(mainRoot, pattern, log)) {
      if (fs.existsSync(path.join(mainRoot, relDir, "node_modules"))) {
        matches.add(relDir);
      }
    }
  }
  return [...matches];
}

function extractWorkspacePatterns(parsedPackageJson: unknown): string[] {
  if (!parsedPackageJson || typeof parsedPackageJson !== "object") {
    return [];
  }

  const workspaces = (parsedPackageJson as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((pattern): pattern is string => typeof pattern === "string");
  }

  if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((pattern): pattern is string => typeof pattern === "string");
    }
  }

  return [];
}

function visitLiteralSegment(
  mainRoot: string,
  pattern: string,
  log: Logger,
  segments: string[],
  index: number,
  relDir: string,
  segment: string,
  recurse: (i: number, rel: string) => void,
): void {
  const nextRel = relDir ? path.join(relDir, segment) : segment;
  const nextAbs = path.join(mainRoot, nextRel);
  try {
    if (fs.statSync(nextAbs).isDirectory()) {
      recurse(index + 1, nextRel);
    }
  } catch (err) {
    if (isMissingError(err)) return;
    logCaughtError(log, "failed to inspect workspace path while expanding workspaces", err, {
      path: nextAbs,
      pattern,
    });
  }
}

function visitGlobSegment(
  mainRoot: string,
  pattern: string,
  log: Logger,
  index: number,
  relDir: string,
  segment: string,
  recurse: (i: number, rel: string) => void,
): void {
  const currentAbs = path.join(mainRoot, relDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentAbs, { withFileTypes: true });
  } catch (err) {
    if (isMissingError(err)) return;
    logCaughtError(log, "failed to read workspace parent while expanding workspaces", err, {
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
    recurse(index + 1, nextRel);
  }
}

function expandWorkspacePattern(mainRoot: string, pattern: string, log: Logger): string[] {
  const segments = pattern.replaceAll("\\", "/").split("/").filter(Boolean);
  const matches: string[] = [];

  const visit = (index: number, relDir: string): void => {
    if (index === segments.length) {
      matches.push(relDir);
      return;
    }
    const segment = segments[index];
    if (segment === undefined) return;
    if (segment.includes("*")) {
      visitGlobSegment(mainRoot, pattern, log, index, relDir, segment, visit);
    } else {
      visitLiteralSegment(mainRoot, pattern, log, segments, index, relDir, segment, visit);
    }
  };

  visit(0, "");
  return matches;
}

function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replaceAll(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`);
}

function isMissingError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
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
  context: Record<string, unknown>,
): void {
  log.warn({ ...context, err }, message);
}
