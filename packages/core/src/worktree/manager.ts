import { execFile as execFileCb, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { createLogger, type Logger } from "../logger.js";
import { classifyBranchLandStatus } from "./branch-land-probe.js";
import { resolveHandoffBranchName } from "./branch-name.js";

const execFile = promisify(execFileCb);
const NOOP_LOG = createLogger({ component: "worktree-manager", level: "silent" });
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKTREE_MODE_FILE = ".test-storage/worktree-mode";
const WORKTREE_READY_FILE = ".test-storage/worktree-ready";
const DEFAULT_ISOLATED_INSTALL_TIMEOUT_MS = 120_000;
const ISOLATED_INSTALL_MAX_BUFFER = 1024 * 1024 * 10;
const UNREADY_WORKTREE_ORPHAN_GRACE_MS = 15 * 60_000;
const ISOLATED_INSTALL_STDERR_TAIL_CHARS = 16 * 1024;
// Stderr kept for error context only; cap it so a chatty child cannot balloon memory.
const SPAWN_STDERR_CAP = 16 * 1024;

export type WorktreeMode = "symlink_mirror" | "isolated_install";
export const ISOLATED_INSTALL_ARGS = ["install", "--ignore-scripts", "--frozen-lockfile"] as const;
export const ISOLATED_INSTALL_CACHE_KEY = `bun ${ISOLATED_INSTALL_ARGS.join(" ")}`;

export interface WorktreeCommandRunnerOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  stdio?: "ignore";
}

export type WorktreeCommandRunner = (
  cmd: string,
  args: string[],
  opts?: WorktreeCommandRunnerOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface FileDependencyManifest {
  relDir: string;
  packageJson: unknown;
}

export interface EscapingFileDependencyLinkPlan {
  dependencyName: string;
  linkPath: string;
  targetPath: string;
}

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
export type ResolveHandoffBranchNameById = (handoff_id: string) => string | null | undefined;
export type BranchNameDriftHandler = (
  handoffId: string,
  actualBranchName: string,
  storedBranchName: string,
) => void;

interface WorktreeManagerOpts {
  rootDir?: string;
  mainRepoDir?: string;
  log?: Logger;
  resolveProjectRoot?: ResolveProjectRoot;
  // Consulted per createWorktree call: when it returns false an unresolvable
  // project_id falls through to the default root instead of throwing
  // unknown_project_id. Lets a live-reloaded registry treat "zero entries" as
  // "no project mapping configured" without uninstalling the resolver.
  requireKnownProjectId?: () => boolean;
  resolveBranchName?: ResolveHandoffBranchNameById;
  onBranchNameDrift?: BranchNameDriftHandler;
  runner?: WorktreeCommandRunner;
  mainBranch?: string;
  now?: () => number;
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
      env: opts.env,
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

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve isolated-install orchestration while grandfathering its pre-existing complexity.
export async function runIsolatedInstall(
  wtPath: string,
  opts: { runner?: WorktreeCommandRunner; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  const timeout =
    opts.timeoutMs ??
    readPositiveIntEnv("PENUMBRA_ISOLATED_INSTALL_TIMEOUT_MS", DEFAULT_ISOLATED_INSTALL_TIMEOUT_MS);
  const runner = opts.runner ?? defaultRunner;
  try {
    await runner("bun", [...ISOLATED_INSTALL_ARGS], {
      cwd: wtPath,
      timeout,
      maxBuffer: ISOLATED_INSTALL_MAX_BUFFER,
      encoding: "utf8",
      signal: opts.signal,
      env: process.env,
    });
  } catch (err) {
    // A deliberate cancellation is not a timeout — re-throw it unwrapped so
    // callers can distinguish the two.
    if (isAbortError(err)) throw err;
    if (isTimeoutError(err, timeout)) {
      throw new Error(`isolated bun install timed out after ${String(timeout)}ms`, {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
    const stderrTail = stderrTailFromError(err);
    if (stderrTail.length > 0) {
      throw new Error(`isolated bun install failed: ${stderrTail}`, {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
    throw err;
  }
}

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeHandle>();
  private rootDir: string;
  #mainRepoDir: string;
  private log: Logger;
  private resolveProjectRoot?: ResolveProjectRoot;
  private requireKnownProjectId?: () => boolean;
  private resolveBranchName?: ResolveHandoffBranchNameById;
  private onBranchNameDrift?: BranchNameDriftHandler;
  private runner: WorktreeCommandRunner;
  private mainBranch: string;
  private now: () => number;

  constructor(opts?: WorktreeManagerOpts) {
    this.#mainRepoDir = opts?.mainRepoDir ?? process.cwd();
    this.log = opts?.log ?? NOOP_LOG;
    this.resolveProjectRoot = opts?.resolveProjectRoot;
    this.requireKnownProjectId = opts?.requireKnownProjectId;
    this.resolveBranchName = opts?.resolveBranchName;
    this.onBranchNameDrift = opts?.onBranchNameDrift;
    this.runner = opts?.runner ?? defaultRunner;
    this.mainBranch = opts?.mainBranch ?? process.env["PENUMBRA_MAIN_BRANCH"] ?? "main";
    this.now = opts?.now ?? ((): number => Date.now());
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

  private branchNameFor(handoffId: string): string {
    return resolveHandoffBranchName({
      handoff_id: handoffId,
      branch_name: this.resolveBranchName?.(handoffId) ?? null,
    });
  }

  private async branchExists(repoRoot: string, branchName: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", `refs/heads/${branchName}`], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  }

  private branchNameWithSuffix(requestedName: string, suffix: number): string {
    return suffix === 1 ? requestedName : `${requestedName}-${String(suffix)}`;
  }

  private async availableBranchName(
    repoRoot: string,
    requestedName: string,
    minSuffix = 1,
  ): Promise<string> {
    for (let suffix = minSuffix; suffix <= 99; suffix += 1) {
      const candidate = this.branchNameWithSuffix(requestedName, suffix);
      if (!(await this.branchExists(repoRoot, candidate))) return candidate;
    }
    throw new Error(`branch_name_collision_exhausted: ${requestedName}`);
  }

  private suffixAfter(requestedName: string, candidate: string): number {
    if (candidate === requestedName) return 2;
    const prefix = `${requestedName}-`;
    if (!candidate.startsWith(prefix)) return 100;
    const suffix = Number(candidate.slice(prefix.length));
    return Number.isInteger(suffix) ? suffix + 1 : 100;
  }

  private isBranchAlreadyExistsCheckoutError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /fatal:.*branch named .* already exists/i.test(message);
  }

  private async checkoutNewBranchWithCollisionRetry(
    repoRoot: string,
    wtPath: string,
    requestedName: string,
  ): Promise<string> {
    let minSuffix = 1;
    while (minSuffix <= 99) {
      const branchName = await this.availableBranchName(repoRoot, requestedName, minSuffix);
      try {
        await this.git(["-C", wtPath, "checkout", "-b", branchName]);
        return branchName;
      } catch (err) {
        if (!this.isBranchAlreadyExistsCheckoutError(err)) throw err;
        minSuffix = this.suffixAfter(requestedName, branchName);
      }
    }
    throw new Error(`branch_name_collision_exhausted: ${requestedName}`);
  }

  private readActualBranchNameSync(wtPath: string): string | null {
    try {
      const dotGit = path.join(wtPath, ".git");
      const dotGitStat = fs.statSync(dotGit);
      let gitDir = dotGit;
      if (dotGitStat.isFile()) {
        const raw = fs.readFileSync(dotGit, "utf8").trim();
        const parsedGitDir = /^gitdir:\s*(\S.*)$/i.exec(raw)?.[1];
        if (parsedGitDir === undefined) return null;
        gitDir = path.isAbsolute(parsedGitDir) ? parsedGitDir : path.resolve(wtPath, parsedGitDir);
      }
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      const prefix = "ref: refs/heads/";
      return head.startsWith(prefix) ? head.slice(prefix.length) : null;
    } catch {
      return null;
    }
  }

  private branchNameForWorktree(handoffId: string, wtPath: string): string {
    const storedBranchName = this.branchNameFor(handoffId);
    const actualBranchName = this.readActualBranchNameSync(wtPath);
    if (actualBranchName && actualBranchName !== storedBranchName) {
      this.onBranchNameDrift?.(handoffId, actualBranchName, storedBranchName);
      return actualBranchName;
    }
    return actualBranchName ?? storedBranchName;
  }

  private discoveryBases(): string[] {
    return [...new Set([this.baseFor(undefined)])];
  }

  private rediscoverEntry(base: string, entry: fs.Dirent): void {
    if (!entry.isDirectory()) return;
    const handoffId = entry.name;
    const wtPath = path.join(base, handoffId);
    if (!fs.existsSync(path.join(wtPath, ".git"))) return;
    const branchName = this.branchNameForWorktree(handoffId, wtPath);
    const storageRoot = path.join(wtPath, ".test-storage");
    const worktreeMode = inferWorktreeMode(wtPath);
    if (!isWorktreeReadySync(wtPath, worktreeMode, handoffId)) return;

    let createdAt = new Date().toISOString();
    try {
      createdAt = new Date(effectiveCreationTime(fs.statSync(wtPath))).toISOString();
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
      prepareEscapingFileDependencyLinks(repoRoot, wtPath);
      provisionLocalCache(repoRoot, wtPath);
      await runIsolatedInstall(wtPath, { runner: this.runner, signal });
      materializeWorkspaceLinks(wtPath);
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
      (this.requireKnownProjectId?.() ?? true) &&
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
    const requestedBranchName = this.branchNameFor(handoffId);
    const baseRef = opts?.baseRef ?? "HEAD";
    const worktreeMode: WorktreeMode = opts?.isolated_install
      ? "isolated_install"
      : "symlink_mirror";

    // Pre-existence guard closes an in-process TOCTOU: two managers whose
    // in-memory maps both miss the same handoffId would otherwise race
    // and the loser's catch-all cleanup would delete the winner's live
    // worktree. Throw non-destructively — a pre-existing wtPath was not
    // created by THIS call and is not ours to remove.
    if (fs.existsSync(wtPath)) {
      throw new Error(`worktree_path_exists: ${wtPath}`);
    }

    // Kept outside the destructive-cleanup try so a `git worktree add`
    // failure does not fall into removePartialWorktree; whatever partial
    // state git left is reaped later by the grace-period GC.
    await this.git(["worktree", "add", "--detach", wtPath, baseRef], { cwd: repoRoot });

    let createdBranchName: string | null = null;
    try {
      await this.configureWorktreeIdentity(wtPath, repoRoot, baseRef);

      const branchName = await this.checkoutNewBranchWithCollisionRetry(
        repoRoot,
        wtPath,
        requestedBranchName,
      );
      createdBranchName = branchName;
      this.copyBunLockIfNeeded(wtPath, repoRoot, worktreeMode);
      if (worktreeMode === "isolated_install") {
        configureIsolatedWorktreeLocalExcludes(wtPath);
      }

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
      await this.removePartialWorktree(wtPath, repoRoot, createdBranchName);
      throw err;
    }
  }

  private async removePartialWorktree(
    wtPath: string,
    repoRoot: string,
    branchName: string | null,
  ): Promise<void> {
    if (fs.existsSync(wtPath)) {
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
    if (branchName === null) return;
    try {
      await this.git(["branch", "-D", branchName], { cwd: repoRoot });
    } catch {
      // Branch may not exist if creation failed before checkout completed.
    }
  }

  private async configureWorktreeIdentity(
    wtPath: string,
    repoRoot: string,
    baseRef: string,
  ): Promise<void> {
    const { name, email } = await this.resolveParentGitIdentity(repoRoot, baseRef);

    // Enable per-worktree config files. This is a persistent, repo-wide
    // format extension stored in the parent repository's .git/config; it is
    // required for `git config --worktree` to write values scoped to this
    // worktree. The extension is unavoidable: a hand-written
    // $GIT_DIR/worktrees/<id>/config.worktree is ignored unless it is set. We
    // check first and only write when it is not already enabled, so a dispatch
    // does not keep mutating the shared repo state on every worktree creation.
    let worktreeConfigEnabled = false;
    try {
      const { stdout } = await this.git([
        "-C",
        repoRoot,
        "config",
        "--get",
        "--local",
        "extensions.worktreeConfig",
      ]);
      worktreeConfigEnabled = stdout.trim() === "true";
    } catch {
      // Not yet set in the parent repository.
    }
    if (!worktreeConfigEnabled) {
      await this.git(["-C", repoRoot, "config", "extensions.worktreeConfig", "true"]);
    }

    await this.git(["-C", wtPath, "config", "--worktree", "user.name", name]);
    await this.git(["-C", wtPath, "config", "--worktree", "user.email", email]);
  }

  private async resolveParentGitIdentity(
    repoRoot: string,
    baseRef: string,
  ): Promise<{ name: string; email: string }> {
    const configured = await this.resolveConfiguredGitIdentity(repoRoot);
    if (configured) return configured;

    const { stdout } = await this.git([
      "-C",
      repoRoot,
      "log",
      "-1",
      "--format=%an%x00%ae",
      baseRef,
    ]);
    const parts = stdout.split("\0");
    const name = parts[0]?.trim() ?? "";
    const email = parts[1]?.trim() ?? "";

    if (!isValidGitIdentity(name, email)) {
      throw new Error(
        `worktree_parent_identity_missing: parent repository has no user.name/user.email or valid commit author to inherit`,
      );
    }

    return { name, email };
  }

  private async resolveConfiguredGitIdentity(
    repoRoot: string,
  ): Promise<{ name: string; email: string } | null> {
    try {
      // Read the parent repository's *effective* identity (local > global >
      // system), not just the local .git/config. Worktrees inherit this through
      // git's normal config resolution, and the explicit worktree-scoped value
      // we write below overrides whatever the ACP agent's environment fails to
      // provide.
      const { stdout: nameOut } = await this.git(["-C", repoRoot, "config", "user.name"]);
      const { stdout: emailOut } = await this.git(["-C", repoRoot, "config", "user.email"]);
      const name = nameOut.trim();
      const email = emailOut.trim();
      if (isValidGitIdentity(name, email)) {
        return { name, email };
      }
    } catch {
      // No effective user.name/user.email for this repository.
    }
    return null;
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

    // stageBranch is intentionally left behind: downstream consumers
    // (worker/worktree-integration.ts resolveBaseRef, merge-reconciler.ts)
    // resolve this name back to a SHA hours later. Deleting it here would
    // break those reads. The worktree-gc sweeper reaps stage/* refs only
    // once every handoff whose branch_base points at the ref is terminal
    // + past grace.
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
    const branchName = this.branchNameForWorktree(handoffId, wtPath);
    const storageRoot = path.join(wtPath, ".test-storage");
    let createdAt = new Date().toISOString();
    try {
      createdAt = new Date(effectiveCreationTime(fs.statSync(wtPath))).toISOString();
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
    if (await isUnreadyWorktreePastGrace(wtPath, this.now)) {
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
      createdAt = new Date(effectiveCreationTime(fs.statSync(wtPath))).toISOString();
    } catch {
      // ignore stat errors — synthesize a placeholder timestamp
    }
    return {
      handoffId,
      path: wtPath,
      branchName: this.branchNameForWorktree(handoffId, wtPath),
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

  private async readBranchSha(branchName: string, repoRoot: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.git(
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
        { cwd: repoRoot },
      );
      const sha = stdout.trim();
      return sha.length > 0 ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  // Fail-closed branch delete guard: only delete an agent branch when the
  // commit has actually landed on main (ancestor) or its work is already
  // present there. Any probe error skips the delete so a still-needed branch
  // survives instead of being lost to a transient git failure or a worktree
  // pruned out from under us.
  private async verifyBranchDeleted(
    handle: WorktreeHandle,
    repoRoot: string,
  ): Promise<{ deleted: boolean; sha?: string }> {
    const sha = await this.readBranchSha(handle.branchName, repoRoot);
    if (sha === undefined) {
      // Ref already gone: nothing to delete, nothing to preserve.
      return { deleted: true };
    }

    try {
      const landStatus = await classifyBranchLandStatus(
        this.runner,
        repoRoot,
        sha,
        this.mainBranch,
      );
      if (landStatus === "error") throw new Error("branch content land-status probe failed");
      if (landStatus === "unlanded") {
        this.log.warn(
          { branch: handle.branchName, sha },
          "branch carries commits not in main; preserving for inspection",
        );
        return { deleted: false, sha };
      }
    } catch (err) {
      this.log.warn(
        { branch: handle.branchName, sha, err: String(err) },
        "branch-land probe failed; preserving branch (fail-closed)",
      );
      return { deleted: false, sha };
    }

    try {
      await this.git(["branch", "-D", handle.branchName], { cwd: repoRoot });
    } catch {
      // verified below
    }
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${handle.branchName}`], {
        cwd: repoRoot,
      });
      return { deleted: false, sha };
    } catch {
      return { deleted: true, sha };
    }
  }

  async teardownWorktree(
    handoffId: string,
    force?: boolean,
    project_id?: string,
    deleteBranch = true,
  ): Promise<{ worktreeRemoved: boolean; branchDeleted: boolean; branchSha?: string }> {
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

    let branchDeleted = false;
    let branchSha: string | undefined;
    if (deleteBranch) {
      const result = await this.verifyBranchDeleted(handle, repoRoot);
      branchDeleted = result.deleted;
      branchSha = result.sha;
    } else {
      // Preserve the SHA for observability even when delete is suppressed.
      branchSha = await this.readBranchSha(handle.branchName, repoRoot);
    }

    this.worktrees.delete(handoffId);
    return { worktreeRemoved: true, branchDeleted, branchSha };
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

export function prepareEscapingFileDependencyLinks(
  mainRepoRoot: string,
  worktreeRoot: string,
): void {
  const manifests = readWorkspacePackageJsonManifests(worktreeRoot);
  for (const link of planEscapingFileDependencyLinks(mainRepoRoot, worktreeRoot, manifests)) {
    ensureEscapingFileDependencyLink(link);
  }
}

export function provisionLocalCache(mainRepoRoot: string, worktreeRoot: string): void {
  const mainCachePath = path.join(mainRepoRoot, "local_cache");
  const worktreeCachePath = path.join(worktreeRoot, "local_cache");
  if (resolveExistingPath(mainRepoRoot) === resolveExistingPath(worktreeRoot))
    throw new Error("local cache source and destination resolve to the same path");

  fs.rmSync(worktreeCachePath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(worktreeCachePath), { recursive: true });
  if (!fs.existsSync(mainCachePath)) {
    fs.mkdirSync(worktreeCachePath, { recursive: true });
    return;
  }

  try {
    execFileSync("cp", ["-cR", mainCachePath, worktreeCachePath], { stdio: "ignore" });
  } catch {
    copyLocalCacheFallback(mainCachePath, worktreeCachePath);
  }
}

const DEFAULT_LOCAL_CACHE_COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function recursiveLstatSize(rootPath: string): number {
  const stat = fs.lstatSync(rootPath);
  if (!stat.isDirectory()) return stat.size;
  return fs
    .readdirSync(rootPath)
    .reduce((total, name) => total + recursiveLstatSize(path.join(rootPath, name)), 0);
}

export function copyLocalCacheFallback(
  mainCachePath: string,
  worktreeCachePath: string,
  maxBytes = DEFAULT_LOCAL_CACHE_COPY_MAX_BYTES,
): void {
  const measuredBytes = recursiveLstatSize(mainCachePath);
  if (measuredBytes > maxBytes) {
    throw new Error(
      `refusing local cache fallback copy from ${mainCachePath}: measured ${String(measuredBytes)} bytes exceeds ${String(maxBytes)} byte bound`,
    );
  }
  fs.cpSync(mainCachePath, worktreeCachePath, { recursive: true, force: true });
}

function configureIsolatedWorktreeLocalExcludes(wtPath: string): void {
  const gitDir = resolveWorktreeGitDir(wtPath);
  for (const excludeGitDir of new Set([gitDir, resolveCommonGitDir(gitDir)])) {
    appendGitExcludeEntries(excludeGitDir, [".test-storage/", "node_modules/"]);
  }
}

function appendGitExcludeEntries(gitDir: string, desiredEntries: string[]): void {
  const excludePath = path.join(gitDir, "info", "exclude");
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  let existing = "";
  try {
    existing = fs.readFileSync(excludePath, "utf8");
  } catch (err) {
    if (!isMissingError(err)) throw err;
  }

  const entries = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
  const additions = desiredEntries.filter((entry) => !entries.has(entry));
  if (additions.length === 0) return;

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(excludePath, `${prefix}${additions.join("\n")}\n`);
}

function resolveCommonGitDir(gitDir: string): string {
  const commonDirPath = path.join(gitDir, "commondir");
  try {
    const raw = fs.readFileSync(commonDirPath, "utf8").trim();
    return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  } catch (err) {
    if (isMissingError(err)) return gitDir;
    throw err;
  }
}

function resolveWorktreeGitDir(wtPath: string): string {
  const dotGitPath = path.join(wtPath, ".git");
  const stat = fs.lstatSync(dotGitPath);
  if (stat.isDirectory()) return dotGitPath;

  const raw = fs.readFileSync(dotGitPath, "utf8").trim();
  const prefix = "gitdir:";
  if (!raw.startsWith(prefix)) {
    throw new Error(`unexpected .git file format in worktree: ${dotGitPath}`);
  }
  const gitDir = raw.slice(prefix.length).trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(wtPath, gitDir);
}

function readWorkspacePackageJsonManifests(repoRoot: string): FileDependencyManifest[] {
  const rootPackageJson = readPackageJsonManifest(repoRoot, "");
  const manifests: FileDependencyManifest[] = [rootPackageJson];

  for (const pattern of extractWorkspacePatterns(rootPackageJson.packageJson)) {
    for (const relDir of expandWorkspacePattern(repoRoot, pattern, NOOP_LOG)) {
      const packageJsonPath = path.join(repoRoot, relDir, "package.json");
      if (!fs.existsSync(packageJsonPath)) continue;
      manifests.push(readPackageJsonManifest(repoRoot, relDir));
    }
  }

  return manifests;
}

function readPackageJsonManifest(repoRoot: string, relDir: string): FileDependencyManifest {
  const packageJsonPath = path.join(repoRoot, relDir, "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(packageJsonPath, "utf8");
  } catch (err) {
    throw new Error(`failed to read package.json for isolated install: ${packageJsonPath}`, {
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  }

  try {
    return { relDir, packageJson: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`failed to parse package.json for isolated install: ${packageJsonPath}`, {
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

export function materializeWorkspaceLinks(worktreeRoot: string): void {
  const rootPackageJson = readPackageJsonManifest(worktreeRoot, "");
  const packageLinks: { packageDir: string; packageName: string }[] = [];

  for (const pattern of extractWorkspacePatterns(rootPackageJson.packageJson)) {
    for (const relDir of expandWorkspacePattern(worktreeRoot, pattern, NOOP_LOG)) {
      const packageJsonPath = path.join(worktreeRoot, relDir, "package.json");
      if (!fs.existsSync(packageJsonPath)) continue;

      const manifest = readPackageJsonManifest(worktreeRoot, relDir);
      const packageName = packageNameForWorktreeLink(manifest.packageJson);
      if (packageName === null) continue;
      packageLinks.push({ packageDir: path.join(worktreeRoot, relDir), packageName });
    }
  }

  if (packageLinks.length === 0) return;
  const nodeModulesRoot = path.join(worktreeRoot, "node_modules");
  ensureRealDirectory(nodeModulesRoot);
  const scopeDir = path.join(nodeModulesRoot, "@penumbra");
  ensureRealDirectory(scopeDir);

  for (const { packageDir, packageName } of packageLinks) {
    const linkPath = path.join(scopeDir, packageName);
    ensureWorktreeLocalWorkspaceLink(worktreeRoot, packageDir, linkPath);
  }
}

function packageNameForWorktreeLink(packageJson: unknown): string | null {
  if (!packageJson || typeof packageJson !== "object") return null;
  const name = (packageJson as { name?: unknown }).name;
  if (typeof name !== "string" || !name.startsWith("@penumbra/")) return null;

  const unscopedName = name.slice("@penumbra/".length);
  if (unscopedName.length === 0 || unscopedName.includes("/")) return null;
  return unscopedName;
}

function ensureRealDirectory(dirPath: string): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(dirPath);
  } catch (err) {
    if (!isMissingError(err)) throw err;
  }

  if (stat === undefined) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`expected real directory for isolated install workspace links: ${dirPath}`);
  }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve worktree workspace-link handling while grandfathering its pre-existing complexity.
function ensureWorktreeLocalWorkspaceLink(
  worktreeRoot: string,
  packageDir: string,
  linkPath: string,
): void {
  // Resolve the root once so both sides of the containment check compare
  // canonical paths; an un-resolved root fails closed when the worktree is
  // reached through a symlink (e.g. /tmp -> /private/tmp on macOS).
  const containmentRoot = fs.realpathSync.native(worktreeRoot);
  const expectedTarget = fs.realpathSync.native(packageDir);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(linkPath);
  } catch (err) {
    if (!isMissingError(err)) throw err;
  }

  if (stat !== undefined) {
    if (stat.isSymbolicLink()) {
      try {
        const actualTarget = fs.realpathSync.native(linkPath);
        const rawTarget = fs.readlinkSync(linkPath);
        if (
          actualTarget === expectedTarget &&
          !path.isAbsolute(rawTarget) &&
          isPathInsideOrEqual(containmentRoot, actualTarget)
        ) {
          return;
        }
      } catch (err) {
        if (!isMissingError(err)) throw err;
      }
      fs.rmSync(linkPath, { recursive: true, force: true });
    } else {
      throw new Error(
        `refusing to replace non-symlink isolated install workspace link: ${linkPath}`,
      );
    }
  }

  if (!isPathInsideOrEqual(containmentRoot, expectedTarget)) {
    throw new Error(
      `refusing to create isolated install workspace link ${linkPath}: target escapes worktree: ${expectedTarget}`,
    );
  }

  const relativeTarget = path.relative(path.dirname(linkPath), packageDir);
  fs.symlinkSync(relativeTarget, linkPath, "dir");
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserve dependency-link planning while grandfathering its pre-existing complexity.
export function planEscapingFileDependencyLinks(
  mainRepoRoot: string,
  worktreeRoot: string,
  manifests: FileDependencyManifest[],
): EscapingFileDependencyLinkPlan[] {
  const normalizedMainRoot = path.resolve(mainRepoRoot);
  const normalizedWorktreeRoot = path.resolve(worktreeRoot);
  const byLinkPath = new Map<string, EscapingFileDependencyLinkPlan>();

  for (const manifest of manifests) {
    const mainPackageDir = path.resolve(normalizedMainRoot, manifest.relDir);
    const worktreePackageDir = path.resolve(normalizedWorktreeRoot, manifest.relDir);

    for (const dep of extractFileDependencies(manifest.packageJson)) {
      const specifierPath = dep.specifier.slice("file:".length);
      const targetPath = path.resolve(mainPackageDir, specifierPath);
      if (isPathInsideOrEqual(normalizedMainRoot, targetPath)) continue;

      const linkPath = path.resolve(worktreePackageDir, specifierPath);
      if (!fs.existsSync(targetPath)) {
        throw new Error(
          `file dependency ${dep.name} escapes the repo but target is missing; main target: ${targetPath}; worktree path: ${linkPath}`,
        );
      }

      const existing = byLinkPath.get(linkPath);
      if (existing !== undefined) {
        if (existing.targetPath !== targetPath || existing.dependencyName !== dep.name) {
          throw new Error(
            `conflicting file dependency link plan for ${dep.name}; main target: ${targetPath}; worktree path: ${linkPath}`,
          );
        }
        continue;
      }

      byLinkPath.set(linkPath, { dependencyName: dep.name, linkPath, targetPath });
    }
  }

  return [...byLinkPath.values()];
}

function extractFileDependencies(packageJson: unknown): { name: string; specifier: string }[] {
  if (!packageJson || typeof packageJson !== "object") return [];
  const parsed = packageJson as Record<string, unknown>;
  const deps: { name: string; specifier: string }[] = [];

  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const rawDeps = parsed[field];
    if (!rawDeps || typeof rawDeps !== "object" || Array.isArray(rawDeps)) continue;
    for (const [name, specifier] of Object.entries(rawDeps as Record<string, unknown>)) {
      if (typeof specifier === "string" && specifier.startsWith("file:")) {
        deps.push({ name, specifier });
      }
    }
  }

  return deps;
}

function ensureEscapingFileDependencyLink(link: EscapingFileDependencyLinkPlan): void {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(link.linkPath);
  } catch (err) {
    if (!isMissingError(err)) throw err;
  }

  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      throw new Error(
        `file dependency ${link.dependencyName} cannot be linked because worktree path already exists; main target: ${link.targetPath}; worktree path: ${link.linkPath}`,
      );
    }

    const actualTarget = fs.realpathSync.native(link.linkPath);
    const expectedTarget = fs.realpathSync.native(link.targetPath);
    if (actualTarget !== expectedTarget) {
      throw new Error(
        `file dependency ${link.dependencyName} has an existing symlink to the wrong target; expected main target: ${link.targetPath}; actual target: ${actualTarget}; worktree path: ${link.linkPath}`,
      );
    }
    return;
  }

  fs.mkdirSync(path.dirname(link.linkPath), { recursive: true });
  const targetStat = fs.lstatSync(link.targetPath);
  fs.symlinkSync(link.targetPath, link.linkPath, targetStat.isDirectory() ? "dir" : "file");
}

function normalizePathForContainment(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

export function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(
    normalizePathForContainment(parentPath),
    normalizePathForContainment(childPath),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

function effectiveCreationTime(stat: fs.Stats): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
}

async function isUnreadyWorktreePastGrace(wtRoot: string, now: () => number): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(wtRoot);
    return now() - effectiveCreationTime(stat) > unreadyWorktreeGraceMs();
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

// An external AbortSignal is screened above so its ABORT_ERR remains distinct.
function isTimeoutError(err: unknown, timeoutMs?: number): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? String((err as { code?: unknown }).code) : "";
  if (code === "ETIMEDOUT") return true;
  if (timeoutMs === undefined) return false;
  const killed = "killed" in err && (err as { killed?: unknown }).killed === true;
  const signal = "signal" in err ? String((err as { signal?: unknown }).signal) : "";
  return killed || signal === "SIGTERM" || signal === "SIGKILL";
}

function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? String((err as { code?: unknown }).code) : "";
  return code === "ABORT_ERR";
}

function stderrTailFromError(err: unknown): string {
  if (typeof err !== "object" || err === null || !("stderr" in err)) return "";
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr !== "string") return "";
  return stderr.trim().slice(-ISOLATED_INSTALL_STDERR_TAIL_CHARS);
}

export function mirrorNodeModuleSymlinks(
  mainRoot: string,
  wtRoot: string,
  log: Logger = NOOP_LOG,
): void {
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

function isValidGitIdentity(name: string, email: string): boolean {
  return name.length > 0 && email.length > 0 && email.includes("@") && !email.endsWith(".local");
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
