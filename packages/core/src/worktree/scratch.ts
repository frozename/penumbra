import * as fs from "node:fs";
import * as path from "node:path";

export const SCRATCH_DIR_PREFIX = ".scratch-";
export const SCRATCH_OWNER_FILE = "penumbra-scratch.json";
export const DEFAULT_SCRATCH_KEEP_TTL_MS = 24 * 60 * 60_000;
// Last-resort reap window for foreign/legacy owner markers: a scratch this
// daemon did not create is deferred until its marker is plainly stale.
export const DEFAULT_SCRATCH_FOREIGN_GRACE_MS = 6 * 60 * 60_000;

export interface ScratchDaemonIdentity {
  /** Daemon identity — the storage-root realpath the owning daemon runs under. */
  daemon_id: string;
  /** Pid of the owning daemon process. */
  pid: number;
  /** Per-boot incarnation id — distinguishes a restart on the same pid. */
  boot_id: string;
}

export interface ScratchOwnerRecord {
  owner_run_id: string;
  sha: string;
  created_at: string;
  daemon?: ScratchDaemonIdentity;
  keep_reason?: string;
  keep_reason_at?: string;
}

export interface ScratchDirEntry {
  /** Absolute path of the `.scratch-*` worktree directory. */
  path: string;
  /** `owner_run_id` recovered from the directory basename. */
  owner_run_id: string;
}

export function isScratchDirName(name: string): boolean {
  return name.startsWith(SCRATCH_DIR_PREFIX);
}

export function scratchDirName(ownerRunId: string): string {
  return `${SCRATCH_DIR_PREFIX}${ownerRunId}`;
}

/**
 * Resolves a worktree's private git dir: the `.git` directory itself for a
 * main checkout, or the `gitdir:` target for a linked worktree. Returns null
 * when the path is not a git worktree at all.
 */
export function resolveWorktreeGitDir(wtPath: string): string | null {
  const dotGitPath = path.join(wtPath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGitPath;
  const raw = fs.readFileSync(dotGitPath, "utf8").trim();
  const prefix = "gitdir:";
  if (!raw.startsWith(prefix)) return null;
  const gitDir = raw.slice(prefix.length).trim();
  return path.isAbsolute(gitDir) ? gitDir : path.resolve(wtPath, gitDir);
}

/**
 * A linked worktree's `commondir` file points at the shared repository git
 * dir; a main checkout has no such file and IS its own git dir.
 */
export function resolveCommonGitDir(gitDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function parseDaemonIdentity(raw: unknown): ScratchOwnerRecord["daemon"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const d = raw as Record<string, unknown>;
  if (
    typeof d.daemon_id !== "string" ||
    d.daemon_id.length === 0 ||
    typeof d.pid !== "number" ||
    typeof d.boot_id !== "string" ||
    d.boot_id.length === 0
  ) {
    return undefined;
  }
  return { daemon_id: d.daemon_id, pid: d.pid, boot_id: d.boot_id };
}

export function readScratchOwner(wtPath: string): ScratchOwnerRecord | null {
  const gitDir = resolveWorktreeGitDir(wtPath);
  if (gitDir === null) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(gitDir, SCRATCH_OWNER_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.owner_run_id !== "string" || rec.owner_run_id.length === 0) return null;
    if (typeof rec.sha !== "string" || rec.sha.length === 0) return null;
    if (typeof rec.created_at !== "string" || rec.created_at.length === 0) return null;
    const owner: ScratchOwnerRecord = {
      owner_run_id: rec.owner_run_id,
      sha: rec.sha,
      created_at: rec.created_at,
    };
    const daemon = parseDaemonIdentity(rec.daemon);
    if (daemon !== undefined) owner.daemon = daemon;
    if (
      typeof rec.keep_reason === "string" &&
      rec.keep_reason.length > 0 &&
      typeof rec.keep_reason_at === "string" &&
      rec.keep_reason_at.length > 0
    ) {
      owner.keep_reason = rec.keep_reason;
      owner.keep_reason_at = rec.keep_reason_at;
    }
    return owner;
  } catch {
    return null;
  }
}

export function writeScratchOwner(wtPath: string, owner: ScratchOwnerRecord): void {
  const gitDir = resolveWorktreeGitDir(wtPath);
  if (gitDir === null) throw new Error(`scratch worktree missing .git pointer: ${wtPath}`);
  fs.writeFileSync(path.join(gitDir, SCRATCH_OWNER_FILE), `${JSON.stringify(owner)}\n`);
}

export function listScratchDirs(base: string): ScratchDirEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ScratchDirEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isScratchDirName(entry.name)) continue;
    const wtPath = path.join(base, entry.name);
    if (!fs.existsSync(path.join(wtPath, ".git"))) continue;
    out.push({ path: wtPath, owner_run_id: entry.name.slice(SCRATCH_DIR_PREFIX.length) });
  }
  return out;
}

export type ScratchCwdValidation =
  | { ok: true; path: string; repo_root: string }
  | { ok: false; reason: string };

function checkExpectedBase(real: string, expectedBase: string): ScratchCwdValidation | null {
  const realBase = realpathOrNull(expectedBase);
  if (realBase === null) return { ok: false, reason: "scratch_base_missing" };
  if (!real.startsWith(`${realBase}${path.sep}`)) {
    return { ok: false, reason: "scratch_outside_fleet_base" };
  }
  return null;
}

function resolveRealCommonDir(real: string): ScratchCwdValidation {
  const gitDir = resolveWorktreeGitDir(real);
  if (gitDir === null) return { ok: false, reason: "not_a_git_worktree" };
  const realCommon = realpathOrNull(resolveCommonGitDir(gitDir));
  if (realCommon === null) return { ok: false, reason: "common_dir_missing" };
  return { ok: true, path: real, repo_root: path.dirname(realCommon) };
}

/**
 * Validates that `cwd_override` names the daemon-owned scratch worktree of
 * `owner_run_id`: directory name, fleet-base containment, shared common git
 * dir, and the owner marker the manager writes at creation. All comparisons
 * run on realpaths so symlinked fleet roots cannot launder a foreign path.
 */
export function validateScratchCwd(input: {
  cwd_override: string;
  owner_run_id: string;
  expected_base?: string;
  expected_common_dir?: string;
}): ScratchCwdValidation {
  if (!path.isAbsolute(input.cwd_override)) {
    return { ok: false, reason: "cwd_override_not_absolute" };
  }
  const real = realpathOrNull(input.cwd_override);
  if (real === null) return { ok: false, reason: "cwd_override_missing" };
  if (path.basename(real) !== scratchDirName(input.owner_run_id)) {
    return { ok: false, reason: "scratch_dir_name_mismatch" };
  }
  if (input.expected_base !== undefined) {
    const badBase = checkExpectedBase(real, input.expected_base);
    if (badBase !== null) return badBase;
  }
  const resolved = resolveRealCommonDir(real);
  if (!resolved.ok) return resolved;
  if (input.expected_common_dir !== undefined) {
    const realExpectedCommon = realpathOrNull(input.expected_common_dir);
    const realCommon = path.join(resolved.repo_root, ".git");
    if (realExpectedCommon === null || realCommon !== realExpectedCommon) {
      return { ok: false, reason: "common_dir_mismatch" };
    }
  }
  const owner = readScratchOwner(real);
  if (owner?.owner_run_id !== input.owner_run_id) {
    return { ok: false, reason: "scratch_owner_mismatch" };
  }
  return resolved;
}
