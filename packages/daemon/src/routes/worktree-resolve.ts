import type { WorktreeHandle } from "@penumbra/core";

/**
 * Minimal structural slice of the daemon `Services` needed to resolve a
 * handoff's worktree. The full `Services` object satisfies this.
 */
interface WorktreeResolveDeps {
  worktreeManager: {
    getWorktree(handoffId: string, projectId?: string): WorktreeHandle | null;
  };
  handoffReader: {
    get(handoffId: string): { project_id?: string | null } | null;
  };
}

/**
 * The handoff's project_id (null normalized to undefined).
 *
 * The daemon and each fleet worker hold SEPARATE WorktreeManager instances
 * (separate processes, separate in-memory maps). A fleet worker creates its
 * worktree under the PROJECT base (`<root_path>-worktrees/<handoff>`), so the
 * daemon's WorktreeManager needs the project_id to recompute that base in its
 * on-disk hydration fallback.
 */
export function projectIdForHandoff(
  services: WorktreeResolveDeps,
  handoff_id: string,
): string | undefined {
  return services.handoffReader.get(handoff_id)?.project_id ?? undefined;
}

/**
 * Resolve a handoff's worktree, threading its project_id so the daemon finds a
 * project-scoped fleet worktree.
 *
 * Without the project_id, `getWorktree` falls back to the daemon's DEFAULT
 * rootDir and returns null for any dispatch whose worktree lives under a project
 * base (e.g. llamactl) — which is why the worktree-scoped MCP tools
 * (fs_grep/fs_glob/shell_run/worktree_inspect + fs read/write routes) failed
 * "worktree for handoff X not found" for every fleet dispatch.
 */
export function resolveWorktreeForHandoff(
  services: WorktreeResolveDeps,
  handoff_id: string,
): WorktreeHandle | null {
  return services.worktreeManager.getWorktree(
    handoff_id,
    projectIdForHandoff(services, handoff_id),
  );
}
