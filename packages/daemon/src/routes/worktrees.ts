import { Services, WorktreeHandle } from "@penumbra/core";
import { promisify } from "node:util";
import { exec as execCb } from "node:child_process";
import { json } from "./_helpers.js";
import { projectIdForHandoff, resolveWorktreeForHandoff } from "./worktree-resolve.js";
const exec = promisify(execCb);
const WORKTREE_STATUS_PATHS = [
  ".",
  ":(exclude)node_modules",
  ":(exclude)packages/*/node_modules",
  ":(exclude).test-storage",
] as const;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function statusCommand(path: string): string {
  const pathspec = WORKTREE_STATUS_PATHS.map(shellQuote).join(" ");
  return `git -C "${path}" status --short --untracked-files=all -- ${pathspec}`;
}

export async function worktreesListRoute(_req: Request, services: Services): Promise<Response> {
  const worktrees = services.worktreeManager.listWorktrees();
  return json({ worktrees });
}

export async function worktreesInspectRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const wt = resolveWorktreeForHandoff(services, handoff_id);
  if (!wt) {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoff_id} not found` } },
      404,
    );
  }

  try {
    const [diffRes, statusRes, logRes] = await Promise.all([
      exec(`git -C "${wt.path}" diff main..HEAD`).catch((err) => ({
        stdout: `[diff error: ${err.message}]`,
      })),
      exec(statusCommand(wt.path)).catch((err) => ({ stdout: `[status error: ${err.message}]` })),
      exec(`git -C "${wt.path}" log --oneline main..HEAD`).catch((err) => ({
        stdout: `[log error: ${err.message}]`,
      })),
    ]);

    const parts = [diffRes.stdout];
    if (statusRes.stdout.trim()) {
      parts.push(`\n# git status --short\n${statusRes.stdout}`);
    }
    let diff_against_main = parts.join("");
    if (diff_against_main.length > 10240) {
      diff_against_main = diff_against_main.slice(0, 10240) + "\n... [truncated]";
    }

    return json({
      worktree: wt,
      diff_against_main,
      branch_log: logRes.stdout,
    });
  } catch (err: any) {
    return json({ error: { code: "internal_error", message: err.message } }, 500);
  }
}

export async function worktreesCleanupRoute(
  req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const projectId = projectIdForHandoff(services, handoff_id);
  const wt = services.worktreeManager.getWorktree(handoff_id, projectId);
  if (!wt) {
    return json({ status: "not_found" });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  try {
    if (projectId !== undefined) {
      await services.worktreeManager.teardownWorktree(handoff_id, force, projectId);
    } else {
      await services.worktreeManager.teardownWorktree(handoff_id, force);
    }
    return json({ status: "torn_down" });
  } catch (err: any) {
    return json({ error: { code: "internal_error", message: err.message } }, 500);
  }
}
