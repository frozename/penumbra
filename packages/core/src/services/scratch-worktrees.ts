import type { Database } from "bun:sqlite";

import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import type { Logger } from "../logger.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { WorktreeManager } from "../worktree/manager.js";
import type { DispatchEventLog } from "./dispatch-event-log.js";

import {
  DEFAULT_SCRATCH_FOREIGN_GRACE_MS,
  DEFAULT_SCRATCH_KEEP_TTL_MS,
  listScratchDirs,
  readScratchOwner,
  resolveCommonGitDir,
  resolveWorktreeGitDir,
  type ScratchCwdValidation,
  type ScratchDaemonIdentity,
  type ScratchDirEntry,
  type ScratchOwnerRecord,
  validateScratchCwd,
  writeScratchOwner,
} from "../worktree/scratch.js";

const execFile = promisify(execFileCb);

const TERMINAL_STATUSES = ["completed", "failed", "rejected", "expired"];
const DEFAULT_RELEASE_WAIT_MS = 60_000;
const DEFAULT_PARTIAL_CREATE_GRACE_MS = 2 * 60_000;
const RELEASE_POLL_MS = 250;

export interface ScratchWorktreeHandle {
  owner_run_id: string;
  path: string;
  sha: string;
  repo_root: string;
  project_id: string | null;
  release(opts?: { keep_reason?: string }): Promise<ScratchReleaseResult>;
}

export interface ScratchReleaseResult {
  kept: boolean;
  keep_reason?: string;
}

export interface ScratchSweepResult {
  reaped: string[];
  kept: string[];
  deferred: string[];
}

interface LiveScratch {
  owner_run_id: string;
  path: string;
  repo_root: string;
  sha: string;
  project_id: string | null;
}

export interface ScratchWorktreesOpts {
  db: Database;
  worktreeManager: WorktreeManager;
  /**
   * Read on every registry lookup: daemon_reload_config swaps the registry on
   * the services object, so a captured instance would hide projects added or
   * changed after boot.
   */
  projectRegistry?: () => ProjectRegistry | undefined;
  dispatchEventLog?: DispatchEventLog;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  releaseWaitMs?: number;
  keepTtlMs?: number;
  partialCreateGraceMs?: number;
  /**
   * The daemon's configured main repo root. Sweeps and `git worktree prune`
   * scan only this root plus registered project roots — never a root the
   * WorktreeManager defaulted from process.cwd() — so a service built
   * without configured roots sweeps nothing.
   */
  mainRepoDir?: string;
  /** Daemon storage root; supplies the owner identity written into markers. */
  storageRoot?: string;
  /** Full identity override — tests pin daemon_id/pid/boot_id directly. */
  daemonIdentity?: ScratchDaemonIdentity;
  pidAlive?: (pid: number) => boolean;
  foreignGraceMs?: number;
}

async function gitRevParse(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, "rev-parse", ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isInsidePath(base: string, target: string): boolean {
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Daemon-owned scratch-worktree lifecycle for review/plan workflow runs (P6).
 * One detached worktree per run, keyed by workflow_run_id and bound to it via
 * an owner marker in the per-worktree git dir. The live set is consulted by
 * the GC sweeper so a scratch owned by a still-running workflow is never
 * reaped; crashed daemons rely on sweepOrphans at boot + every GC tick.
 */
export class ScratchWorktreesService {
  private readonly live = new Map<string, LiveScratch>();
  private readonly releaseWaitMs: number;
  private readonly keepTtlMs: number;
  private readonly partialCreateGraceMs: number;
  private readonly foreignGraceMs: number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly identity: ScratchDaemonIdentity | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ScratchWorktreesOpts) {
    this.now = opts.now ?? ((): number => Date.now());
    this.sleep = opts.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.releaseWaitMs = opts.releaseWaitMs ?? DEFAULT_RELEASE_WAIT_MS;
    this.keepTtlMs = opts.keepTtlMs ?? DEFAULT_SCRATCH_KEEP_TTL_MS;
    this.partialCreateGraceMs = opts.partialCreateGraceMs ?? DEFAULT_PARTIAL_CREATE_GRACE_MS;
    this.foreignGraceMs = opts.foreignGraceMs ?? DEFAULT_SCRATCH_FOREIGN_GRACE_MS;
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.identity =
      opts.daemonIdentity ??
      (opts.storageRoot !== undefined
        ? {
            daemon_id: realpathOrNull(opts.storageRoot) ?? path.resolve(opts.storageRoot),
            pid: process.pid,
            boot_id: randomUUID(),
          }
        : null);
  }

  isLive(owner_run_id: string): boolean {
    return this.live.has(owner_run_id);
  }

  async acquire(input: {
    owner_run_id: string;
    cwd: string;
    project_id?: string | null;
    ref?: string;
  }): Promise<ScratchWorktreeHandle> {
    if (input.owner_run_id.length === 0 || input.owner_run_id.includes(path.sep)) {
      throw new Error(`scratch_invalid_owner_run_id: ${input.owner_run_id}`);
    }
    const existing = this.live.get(input.owner_run_id);
    if (existing !== undefined) return this.handleFor(existing);

    const ref = input.ref ?? "HEAD";
    if (ref.startsWith("-")) {
      throw new Error(`scratch_ref_looks_like_flag: ${ref}`);
    }
    const commonDir = await gitRevParse(input.cwd, [
      "--path-format=absolute",
      "--git-common-dir",
    ]).catch(() => {
      throw new Error(`scratch_cwd_not_git: ${input.cwd}`);
    });
    const realCommon = realpathOrNull(commonDir);
    if (realCommon === null) {
      throw new Error(`scratch_cwd_not_git: ${input.cwd}`);
    }
    const repoRoot = path.dirname(realCommon);
    const sha = await gitRevParse(input.cwd, ["--verify", "--end-of-options", `${ref}^{commit}`])
      .then((out) => {
        if (!/^[0-9a-f]{40,64}$/i.test(out)) throw new Error("bad sha");
        return out;
      })
      .catch(() => {
        throw new Error(`scratch_ref_unresolvable: ${ref}`);
      });

    const created = await this.opts.worktreeManager.createScratchWorktree({
      owner_run_id: input.owner_run_id,
      repoRoot,
      sha,
      daemon: this.identity ?? undefined,
    });
    const entry: LiveScratch = {
      owner_run_id: input.owner_run_id,
      path: fs.realpathSync(created.path),
      repo_root: repoRoot,
      sha,
      project_id: input.project_id ?? this.projectIdForRoot(repoRoot),
    };
    this.live.set(entry.owner_run_id, entry);
    return this.handleFor(entry);
  }

  private commonDirForRepoRoot(repoRoot: string): string {
    const gitDir = resolveWorktreeGitDir(repoRoot);
    if (gitDir === null) return path.join(repoRoot, ".git");
    return resolveCommonGitDir(gitDir);
  }

  /** Post-project-normalization gate for chain_start cwd_override (D8). The
   *  base + common dir are derived the same way acquire() derives them —
   *  from the project's shared common dir, not the checkout path — so a
   *  project registered at a linked worktree still validates. */
  validateCwdOverride(input: {
    cwd_override: string;
    owner_run_id: string;
    project_id?: string | null;
  }): ScratchCwdValidation {
    const repoRoot = this.opts.worktreeManager.repoRootForProject(input.project_id ?? undefined);
    const commonDir = this.commonDirForRepoRoot(repoRoot);
    const realCommon = realpathOrNull(commonDir) ?? commonDir;
    return validateScratchCwd({
      cwd_override: input.cwd_override,
      owner_run_id: input.owner_run_id,
      expected_base: `${path.dirname(realCommon)}-worktrees`,
      expected_common_dir: realCommon,
    });
  }

  /**
   * Project owning the repo lineage `cwd` belongs to, resolved by comparing
   * git common dirs — a project registered at a linked worktree shares its
   * main root's common dir. "matched" with a null project_id means the
   * daemon's own main repo; "unmatched" is a foreign repo; "not_git" is a
   * path without resolvable git lineage (validation reports it precisely).
   */
  scratchCwdProject(cwd: string): {
    status: "not_git" | "matched" | "unmatched";
    project_id?: string | null;
  } {
    const gitDir = resolveWorktreeGitDir(cwd);
    const common = gitDir === null ? null : realpathOrNull(resolveCommonGitDir(gitDir));
    if (common === null) return { status: "not_git" };
    for (const entry of this.opts.projectRegistry?.()?.list() ?? []) {
      if (realpathOrNull(this.commonDirForRepoRoot(entry.root_path)) === common) {
        return { status: "matched", project_id: entry.project_id };
      }
    }
    if (
      this.opts.mainRepoDir !== undefined &&
      realpathOrNull(this.commonDirForRepoRoot(this.opts.mainRepoDir)) === common
    ) {
      return { status: "matched", project_id: null };
    }
    return { status: "unmatched" };
  }

  private handleFor(entry: LiveScratch): ScratchWorktreeHandle {
    return {
      owner_run_id: entry.owner_run_id,
      path: entry.path,
      sha: entry.sha,
      repo_root: entry.repo_root,
      project_id: entry.project_id,
      release: (relOpts) => this.release(entry.owner_run_id, relOpts),
    };
  }

  private projectIdForRoot(repoRoot: string): string | null {
    const realRoot = realpathOrNull(repoRoot);
    for (const entry of this.opts.projectRegistry?.()?.list() ?? []) {
      if (realpathOrNull(entry.root_path) === realRoot) return entry.project_id;
    }
    return null;
  }

  private liveDispatchCount(owner_run_id: string): number {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(",");
    const row = this.opts.db
      .query<
        { n: number },
        [string, ...string[]]
      >(`SELECT COUNT(*) AS n FROM handoffs WHERE workflow_run_id = ? AND status NOT IN (${placeholders})`)
      .get(owner_run_id, ...TERMINAL_STATUSES);
    return row?.n ?? 0;
  }

  async release(
    owner_run_id: string,
    relOpts?: { keep_reason?: string },
  ): Promise<ScratchReleaseResult> {
    const entry = this.live.get(owner_run_id);
    if (entry === undefined) return { kept: false };

    let keepReason = relOpts?.keep_reason;
    if (keepReason === undefined) {
      // The run's handoffs may still be 'dispatched' when the workflow
      // resolves — wait briefly so a post-run claim doesn't lose its cwd.
      const deadline = this.now() + this.releaseWaitMs;
      while (this.liveDispatchCount(owner_run_id) > 0 && this.now() < deadline) {
        await this.sleep(RELEASE_POLL_MS);
      }
      if (this.liveDispatchCount(owner_run_id) > 0) {
        keepReason = "live_dispatches_at_release";
      }
    }
    // The live entry is what protects the dir from sweepOrphans while the
    // wait above is in flight — drop it only once the decision is made.
    this.live.delete(owner_run_id);
    if (keepReason !== undefined) {
      this.stampKeepReason(entry, keepReason);
      return { kept: true, keep_reason: keepReason };
    }
    try {
      await this.opts.worktreeManager.removeScratchWorktree({
        path: entry.path,
        repoRoot: entry.repo_root,
      });
      return { kept: false };
    } catch (err) {
      this.opts.log?.warn(
        { owner_run_id, path: entry.path, err: String(err) },
        "scratch release failed; keeping for GC",
      );
      this.stampKeepReason(entry, "release_remove_failed");
      return { kept: true, keep_reason: "release_remove_failed" };
    }
  }

  private stampKeepReason(entry: LiveScratch, reason: string): void {
    try {
      const owner = readScratchOwner(entry.path) ?? {
        owner_run_id: entry.owner_run_id,
        sha: entry.sha,
        created_at: new Date(this.now()).toISOString(),
      };
      writeScratchOwner(entry.path, {
        ...owner,
        keep_reason: reason,
        keep_reason_at: new Date(this.now()).toISOString(),
      });
    } catch {
      // Directory may already be gone; the next sweep will pass over it.
    }
  }

  /**
   * Repo roots a sweep may scan: the explicitly configured main repo plus
   * every registered project root. The WorktreeManager's own mainRepoDir
   * (which defaults to process.cwd()) is deliberately not consulted — a
   * service without configured roots sweeps nothing.
   */
  private configuredRepoRoots(): string[] {
    const roots = new Set<string>();
    if (this.opts.mainRepoDir !== undefined) roots.add(this.opts.mainRepoDir);
    for (const entry of this.opts.projectRegistry?.()?.list() ?? []) {
      roots.add(entry.root_path);
    }
    return [...roots];
  }

  private scratchBases(): string[] {
    const bases = new Set<string>();
    for (const root of this.configuredRepoRoots()) {
      const commonDir = this.commonDirForRepoRoot(root);
      const mainRoot = path.dirname(realpathOrNull(commonDir) ?? commonDir);
      bases.add(`${mainRoot}-worktrees`);
      bases.add(`${root}-worktrees`);
    }
    return [...bases];
  }

  /**
   * Reap scratch worktrees nobody still owns: missing/torn owner markers
   * (past partial-create grace), stale keeps, and dirs whose run finished
   * without releasing (daemon crash). Safe to run at boot and on each GC tick.
   */
  async sweepOrphans(): Promise<ScratchSweepResult> {
    const reaped: string[] = [];
    const kept: string[] = [];
    const deferred: string[] = [];
    const nowMs = this.now();
    // Bases computed per repo root and per common dir overlap when the fleet
    // root sits under a symlink (/tmp on macOS) — dedupe on realpath.
    const seen = new Set<string>();

    for (const base of this.scratchBases()) {
      for (const dir of listScratchDirs(base)) {
        const realDir = realpathOrNull(dir.path) ?? dir.path;
        if (seen.has(realDir)) continue;
        seen.add(realDir);
        const verdict = this.sweepVerdict(dir, nowMs);
        if (verdict.action === "reap") {
          await this.reapScratchDir(dir.path, reaped, deferred, verdict.reason);
        } else if (verdict.action === "kept") {
          kept.push(dir.path);
        } else {
          deferred.push(dir.path);
        }
      }
    }
    await this.pruneAdminEntries();
    return { reaped, kept, deferred };
  }

  // `git worktree prune` is deliberately confined to the sweep: on the
  // per-run release path it could reap the half-created admin entry of a
  // racing acquire. One prune per shared common dir covers every linked
  // worktree of that repo.
  private async pruneAdminEntries(): Promise<void> {
    const pruned = new Set<string>();
    for (const root of this.configuredRepoRoots()) {
      const commonDir = this.commonDirForRepoRoot(root);
      const key = realpathOrNull(commonDir) ?? commonDir;
      if (pruned.has(key)) continue;
      pruned.add(key);
      await this.opts.worktreeManager.pruneWorktrees(path.dirname(key));
    }
  }

  private sweepVerdict(
    dir: ScratchDirEntry,
    nowMs: number,
  ): { action: "kept" | "deferred" } | { action: "reap"; reason: string } {
    if (this.live.has(dir.owner_run_id)) return { action: "deferred" };
    const owner = readScratchOwner(dir.path);
    if (owner === null) return this.missingOwnerVerdict(dir, nowMs);
    // Ownership: a fresh marker written by another daemon identity — or a
    // legacy marker with none — is deferred unconditionally; only when the
    // marker is plainly stale does the last-resort reap apply.
    const daemon = owner.daemon;
    const identity = this.identity;
    const mine =
      daemon !== undefined && identity !== null && daemon.daemon_id === identity.daemon_id;
    if (!mine) return this.foreignVerdict(owner, dir, nowMs);
    if (owner.keep_reason !== undefined && owner.keep_reason_at !== undefined) {
      return this.keepVerdict(owner.keep_reason_at, nowMs);
    }
    // This daemon's own marker: reap only when the writer is gone — its pid
    // is dead, or it carries a previous incarnation's boot id.
    return this.abandonedOrLive(daemon);
  }

  private missingOwnerVerdict(
    dir: ScratchDirEntry,
    nowMs: number,
  ): { action: "deferred" } | { action: "reap"; reason: string } {
    const ageMs = nowMs - this.dirAgeMs(dir.path);
    return ageMs < this.partialCreateGraceMs
      ? { action: "deferred" }
      : { action: "reap", reason: "missing_owner_marker" };
  }

  private foreignVerdict(
    owner: ScratchOwnerRecord,
    dir: ScratchDirEntry,
    nowMs: number,
  ): { action: "deferred" } | { action: "reap"; reason: string } {
    const parsed = Date.parse(owner.created_at);
    const markerAgeMs = nowMs - (Number.isFinite(parsed) ? parsed : this.dirAgeMs(dir.path));
    return markerAgeMs < this.foreignGraceMs
      ? { action: "deferred" }
      : { action: "reap", reason: "foreign_owner_marker" };
  }

  private keepVerdict(
    keptAt: string,
    nowMs: number,
  ): { action: "kept" } | { action: "reap"; reason: string } {
    const keptAgeMs = nowMs - new Date(keptAt).getTime();
    return keptAgeMs < this.keepTtlMs
      ? { action: "kept" }
      : { action: "reap", reason: "keep_ttl_expired" };
  }

  private abandonedOrLive(
    daemon: ScratchDaemonIdentity,
  ): { action: "deferred" } | { action: "reap"; reason: string } {
    const identity = this.identity;
    const pidDead = !this.pidAlive(daemon.pid);
    const previousIncarnation =
      identity !== null && daemon.pid === identity.pid && daemon.boot_id !== identity.boot_id;
    return pidDead || previousIncarnation
      ? { action: "reap", reason: "abandoned" }
      : { action: "deferred" };
  }

  private dirAgeMs(dirPath: string): number {
    try {
      return fs.statSync(dirPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async reapScratchDir(
    dirPath: string,
    reaped: string[],
    deferred: string[],
    reason: string,
  ): Promise<void> {
    const gitDir = resolveWorktreeGitDir(dirPath);
    let repoRoot: string | null =
      gitDir === null ? null : path.dirname(resolveCommonGitDir(gitDir));
    if (repoRoot === null) {
      // A torn dir (no .git pointer): recover the repo root from the
      // `<root>-worktrees` convention before falling back to the configured
      // main repo — never the manager's process.cwd() default.
      const baseDir = path.dirname(dirPath);
      const baseName = path.basename(baseDir);
      repoRoot = baseName.endsWith("-worktrees")
        ? path.join(path.dirname(baseDir), baseName.slice(0, -"-worktrees".length))
        : (this.opts.mainRepoDir ?? null);
    }
    try {
      if (repoRoot === null) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
        if (fs.existsSync(dirPath)) throw new Error(`scratch_reap_still_present: ${dirPath}`);
      } else {
        await this.opts.worktreeManager.removeScratchWorktree({ path: dirPath, repoRoot });
      }
      this.opts.dispatchEventLog?.record({
        handoff_id: path.basename(dirPath),
        source: "daemon",
        kind: "worktree.gc",
        ts: new Date(this.now()).toISOString(),
        meta: { scratch: true, path: dirPath, reason },
      });
      reaped.push(dirPath);
    } catch (err) {
      this.opts.log?.warn(
        { path: dirPath, err: String(err) },
        "scratch orphan reap failed; deferring",
      );
      deferred.push(dirPath);
    }
  }

  /** Convenience for chain validation: realpath + owner check without the
   *  project-scoped base binding (used when the override arrived already
   *  bound to a known project in-process). */
  validateForOwner(cwdOverride: string, ownerRunId: string): ScratchCwdValidation {
    return validateScratchCwd({ cwd_override: cwdOverride, owner_run_id: ownerRunId });
  }
}
