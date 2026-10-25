import type {
  CommitIntegrityEvidence,
  WorktreeCommandRunner,
  WorktreeHandle,
} from "@penumbra/core";

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { probeCommitIntegrity } from "./commit-integrity.js";

const execFile = promisify(execFileCb);

// Dependency installs and test storage are not agent work.
const STATUS_PATHSPEC = [
  ".",
  ":(exclude)node_modules",
  ":(exclude)packages/*/node_modules",
  ":(exclude).test-storage",
];

export interface WorktreeSnapshot {
  worktreeChanged: boolean | null;
  dirty: boolean | null;
  committed: boolean | null;
  commitIntegrity?: CommitIntegrityEvidence | null;
}

export interface WorktreeSnapshotDeps {
  getWorktree: (handoffId: string) => Pick<WorktreeHandle, "branchName" | "path"> | null;
  runner?: WorktreeCommandRunner;
  env?: NodeJS.ProcessEnv;
}

const defaultRunner: WorktreeCommandRunner = (cmd, args, opts) =>
  execFile(cmd, args, { ...opts, encoding: "utf8" });

async function stdoutOrEmpty(
  runner: WorktreeCommandRunner,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    return (await runner("git", args, { cwd, env })).stdout;
  } catch {
    return "";
  }
}

async function attachedBranchName(
  runner: WorktreeCommandRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const out = (await stdoutOrEmpty(runner, ["symbolic-ref", "--quiet", "HEAD"], cwd, env)).trim();
  return out.startsWith("refs/heads/") ? out.slice("refs/heads/".length) : null;
}

function countLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Captured at dispatch.end so the reliability classifier has a stable signal
 * even after a maestro FF-merges and main moves past HEAD: git status
 * (skipping node_modules/.test-storage) for dirty, and the branch reflog for
 * committed — a freshly created branch has exactly one reflog entry.
 */
export async function getWorktreeSnapshot(
  handoffId: string,
  deps: WorktreeSnapshotDeps,
): Promise<WorktreeSnapshot> {
  const wt = deps.getWorktree(handoffId);
  if (!wt) return { worktreeChanged: null, dirty: null, committed: null };
  const runner = deps.runner ?? defaultRunner;
  const env = deps.env ?? process.env;
  // Mirrors WorktreeManager.branchNameForWorktree's drift rule: the branch HEAD
  // is attached to wins, detached HEAD keeps the stored name. The daemon's
  // onBranchNameDrift rewrites handoffs.branch_name to the attached branch, and
  // that is the branch dispatch_land lands, so the evidence must describe it.
  const branchName = (await attachedBranchName(runner, wt.path, env)) ?? wt.branchName;
  const [status, reflog] = await Promise.all([
    stdoutOrEmpty(
      runner,
      ["status", "--short", "--untracked-files=all", "--", ...STATUS_PATHSPEC],
      wt.path,
      env,
    ),
    stdoutOrEmpty(
      runner,
      ["reflog", "show", "--no-decorate", "--max-count=2", `refs/heads/${branchName}`],
      wt.path,
      env,
    ),
  ]);
  const dirty = status.trim().length > 0;
  const committed = countLines(reflog) > 1;
  const commitIntegrity = await probeCommitIntegrity(wt.path, branchName, { runner, env });
  return { worktreeChanged: dirty || committed, dirty, committed, commitIntegrity };
}
