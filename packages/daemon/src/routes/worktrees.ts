import { Services } from "@penumbra/core";

import { json } from "./_helpers.js";
import { inspectWorktreeForHandoff } from "./worktree-inspection.js";
import { projectIdForHandoff } from "./worktree-resolve.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function worktreesListRoute(_req: Request, services: Services): Response {
  const worktrees = services.worktreeManager.listWorktrees();
  return json({ worktrees });
}

export async function worktreesInspectRoute(
  _req: Request,
  handoff_id: string,
  services: Services,
): Promise<Response> {
  const result = await inspectWorktreeForHandoff(services, handoff_id);
  if (!result.ok && result.code === "not_found") {
    return json(
      { error: { code: "not_found", message: `worktree for handoff ${handoff_id} not found` } },
      404,
    );
  }
  if (!result.ok) {
    return json({ error: { code: "inspection_failed", message: result.message } }, 500);
  }
  return json(result.inspection);
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
