import { WorktreeManager } from "@penumbra/core";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectIdForHandoff, resolveWorktreeForHandoff } from "@src/routes/worktree-resolve.js";

type WorktreeResolveDeps = Parameters<typeof projectIdForHandoff>[0];

/**
 * Regression: the worktree-scoped MCP tools (fs_grep/fs_glob/shell_run/
 * worktree_inspect + fs read/write routes) resolve via the DAEMON's
 * WorktreeManager.getWorktree(handoff_id). A fleet worker creates its worktree
 * in a SEPARATE process under the PROJECT base (<root_path>-worktrees/<handoff>),
 * so the daemon — calling getWorktree WITHOUT the handoff's project_id — fell
 * back to its default rootDir and returned "worktree for handoff X not found"
 * for every fleet dispatch (especially cross-project ones like llamactl). These
 * helpers thread the handoff's project_id so getWorktree's on-disk hydration
 * fallback recomputes the right base and finds the worker-created worktree.
 */
describe("resolveWorktreeForHandoff", () => {
  test("threads project_id so a project-scoped fleet worktree resolves (regression: llamactl not_found)", () => {
    // Worker created the worktree under the PROJECT base, not the daemon default.
    const projectRoot = mkdtempSync(join(tmpdir(), "wtres-proj-"));
    const projectBase = `${projectRoot}-worktrees`;
    const handoffId = "h-llamactl-1";
    const wtPath = join(projectBase, handoffId);
    mkdirSync(join(wtPath, ".git"), { recursive: true });
    const defaultRoot = mkdtempSync(join(tmpdir(), "wtres-default-"));

    const worktreeManager = new WorktreeManager({
      rootDir: defaultRoot,
      mainRepoDir: projectRoot,
      resolveProjectRoot: (id): string | undefined => (id === "llamactl" ? projectRoot : undefined),
    });
    const services: WorktreeResolveDeps = {
      worktreeManager,
      handoffReader: {
        get: (id: string) => (id === handoffId ? { project_id: "llamactl" } : null),
      },
    };

    // The bug: project_id-blind lookup misses the project-scoped worktree.
    expect(worktreeManager.getWorktree(handoffId)).toBeNull();
    // The fix: threading project_id resolves it at the project base.
    expect(projectIdForHandoff(services, handoffId)).toBe("llamactl");
    expect(resolveWorktreeForHandoff(services, handoffId)?.path).toBe(wtPath);
  });

  test("project_id null (non-project dispatch) falls back to the default rootDir", () => {
    const defaultRoot = mkdtempSync(join(tmpdir(), "wtres-default-"));
    const handoffId = "h-default-1";
    mkdirSync(join(defaultRoot, handoffId, ".git"), { recursive: true });
    const worktreeManager = new WorktreeManager({ rootDir: defaultRoot, mainRepoDir: defaultRoot });
    const services: WorktreeResolveDeps = {
      worktreeManager,
      handoffReader: { get: () => ({ project_id: null }) },
    };
    expect(projectIdForHandoff(services, handoffId)).toBeUndefined();
    expect(resolveWorktreeForHandoff(services, handoffId)?.path).toBe(join(defaultRoot, handoffId));
  });

  test("unknown handoff (no DB record) → undefined project_id, null worktree", () => {
    const defaultRoot = mkdtempSync(join(tmpdir(), "wtres-default-"));
    const worktreeManager = new WorktreeManager({ rootDir: defaultRoot, mainRepoDir: defaultRoot });
    const services: WorktreeResolveDeps = { worktreeManager, handoffReader: { get: () => null } };
    expect(projectIdForHandoff(services, "nope")).toBeUndefined();
    expect(resolveWorktreeForHandoff(services, "nope")).toBeNull();
  });
});
