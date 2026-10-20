import {
  type PermissionProfile,
  resolveCommonGitDir,
  resolveSandboxDenyRoots,
  resolveWorktreeGitDir,
  validateScratchCwd,
  type WorktreeManager,
} from "@penumbra/core";
import * as fs from "node:fs";
import * as path from "node:path";

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Narrow handoff shape so tests can stub rows without the full row schema.
 * Mirrors WorktreeOverrideHandoff in worktree-integration.ts.
 */
export interface ScratchDispatchHandoff {
  cwd_override?: string | null;
  workflow_run_id?: string | null;
  permission_profile?: PermissionProfile | null;
  caller_cwd?: string | null;
  project_id?: string | null;
}

export type ScratchDispatchResolution =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "scratch";
      /** Realpath'd scratch dir — the adapter's spawn cwd. */
      cwd: string;
      /** Shared repo root the scratch was cut from (ACP pool scope). */
      repoRoot: string;
      /** WriteToolsExecutor jail root — same as cwd for scratch runs. */
      executorRoot: string;
      /** Layer B deny set — present only on profiled dispatches. */
      sandboxDenyRoots?: string[];
    };

/**
 * Pure resolution for a scratch-routed dispatch (P6). Validates the override
 * is the daemon-owned scratch bound to this workflow_run_id, then returns
 * the effective cwd / repoRoot / executor root and — for profiled
 * dispatches — the deny set that keeps the operator checkout off-limits.
 * 'none' means no override was set (normal dispatch path); 'invalid' means
 * one was set but failed validation — the caller must markFailed, never run.
 */
export function resolveScratchDispatch(
  handoff: ScratchDispatchHandoff,
  deps: { worktreeManager: WorktreeManager; workerCwd: string },
): ScratchDispatchResolution {
  const override = handoff.cwd_override;
  if (override === undefined || override === null || override === "") {
    return { kind: "none" };
  }
  const runId = handoff.workflow_run_id;
  if (typeof runId !== "string" || runId.length === 0) {
    return { kind: "invalid", reason: "scratch_requires_workflow_run_id" };
  }
  // Re-validate as strictly as the daemon did: the scratch must sit under the
  // fleet base of the handoff's project and share that repo's common git dir.
  // The project root resolves through the shared common dir — a project
  // registered at a linked worktree still maps to the main repo's base.
  const projectRoot = deps.worktreeManager.repoRootForProject(handoff.project_id ?? undefined);
  const projectGitDir = resolveWorktreeGitDir(projectRoot);
  const commonDir =
    projectGitDir === null ? path.join(projectRoot, ".git") : resolveCommonGitDir(projectGitDir);
  const realCommon = realpathOrNull(commonDir) ?? commonDir;
  const validation = validateScratchCwd({
    cwd_override: override,
    owner_run_id: runId,
    expected_base: `${path.dirname(realCommon)}-worktrees`,
    expected_common_dir: realCommon,
  });
  if (!validation.ok) {
    return { kind: "invalid", reason: validation.reason };
  }
  const cwd = validation.path;
  const repoRoot = validation.repo_root;
  const profiled = handoff.permission_profile !== null && handoff.permission_profile !== undefined;
  return {
    kind: "scratch",
    cwd,
    repoRoot,
    executorRoot: cwd,
    sandboxDenyRoots: profiled
      ? resolveSandboxDenyRoots(cwd, [
          deps.worktreeManager.projectRootFor(handoff.project_id ?? undefined),
          deps.worktreeManager.worktreeBaseFor(handoff.project_id ?? undefined),
          deps.worktreeManager.mainRepoDir,
          handoff.caller_cwd ?? undefined,
          deps.workerCwd,
        ])
      : undefined,
  };
}
