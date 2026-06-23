import { Services } from "@penumbra/core";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { json } from "./_helpers.js";
import { projectIdForHandoff, resolveWorktreeForHandoff } from "./worktree-resolve.js";
const execFile = promisify(execFileCb);
const WORKTREE_STATUS_PATHS = [
  ".",
  ":(exclude)node_modules",
  ":(exclude)packages/*/node_modules",
  ":(exclude).test-storage",
] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function worktreesListRoute(_req: Request, services: Services): Response {
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
      execFile("git", ["-C", wt.path, "diff", "main..HEAD"]).catch((err: unknown) => ({
        stdout: `[diff error: ${errorMessage(err)}]`,
      })),
      execFile("git", [
        "-C",
        wt.path,
        "status",
        "--short",
        "--untracked-files=all",
        "--",
        ...WORKTREE_STATUS_PATHS,
      ]).catch((err: unknown) => ({ stdout: `[status error: ${errorMessage(err)}]` })),
      execFile("git", ["-C", wt.path, "log", "--oneline", "main..HEAD"]).catch((err: unknown) => ({
        stdout: `[log error: ${errorMessage(err)}]`,
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
  } catch (err) {
    return json({ error: { code: "internal_error", message: errorMessage(err) } }, 500);
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
  } catch (err) {
    return json({ error: { code: "internal_error", message: errorMessage(err) } }, 500);
  }
}
