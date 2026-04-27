import { Services, WorktreeHandle } from '@penumbra/core';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';

const exec = promisify(execCb);

export async function worktreesListRoute(_req: Request, services: Services): Promise<Response> {
  const worktrees = services.worktreeManager.listWorktrees();
  return json({ worktrees });
}

export async function worktreesInspectRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const wt = services.worktreeManager.getWorktree(handoff_id);
  if (!wt) {
    return json({ error: { code: 'not_found', message: `worktree for handoff ${handoff_id} not found` } }, 404);
  }

  try {
    const [diffRes, logRes] = await Promise.all([
      exec(`git -C "${wt.path}" diff main..HEAD`).catch(err => ({ stdout: `[diff error: ${err.message}]` })),
      exec(`git -C "${wt.path}" log --oneline main..HEAD`).catch(err => ({ stdout: `[log error: ${err.message}]` })),
    ]);

    let diff_against_main = diffRes.stdout;
    if (diff_against_main.length > 10240) {
      diff_against_main = diff_against_main.slice(0, 10240) + '\n... [truncated]';
    }

    return json({
      worktree: wt,
      diff_against_main,
      branch_log: logRes.stdout,
    });
  } catch (err: any) {
    return json({ error: { code: 'internal_error', message: err.message } }, 500);
  }
}

export async function worktreesCleanupRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const wt = services.worktreeManager.getWorktree(handoff_id);
  if (!wt) {
    return json({ status: 'not_found' });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get('force') === 'true';

  try {
    await services.worktreeManager.teardownWorktree(handoff_id, force);
    return json({ status: 'torn_down' });
  } catch (err: any) {
    return json({ error: { code: 'internal_error', message: err.message } }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
