import type { Services } from '@penumbra/core';
import { resolveInsideWorktree, FsPathError } from '@penumbra/core';
import { executeGlob, executeGrep, GrepError } from '../fs-search.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function worktreesGlobRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const wt = services.worktreeManager.getWorktree(handoff_id);
  if (!wt) {
    return json({ error: { code: 'not_found', message: `worktree for handoff ${handoff_id} not found` } }, 404);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.pattern || typeof body.pattern !== 'string') {
    return json({ error: { code: 'invalid_args', message: 'pattern (string) required' } }, 400);
  }

  if (body.path) {
    try {
      body.path = await resolveInsideWorktree(body.path, wt.path);
    } catch (err) {
      if (err instanceof FsPathError) {
        return json({ error: { code: err.code, message: err.message } }, err.code === 'outside_worktree' ? 400 : 404);
      }
      throw err;
    }
  }

  try {
    return json(
      await executeGlob(
        {
          pattern: body.pattern,
          path: body.path ?? null,
          max_results: typeof body.max_results === 'number' ? body.max_results : null,
          include_ignored: body.include_ignored === true,
        },
        wt.path,
      ),
    );
  } catch (err: any) {
    return json({ error: { code: 'internal_error', message: err?.message ?? String(err) } }, 500);
  }
}

export async function worktreesGrepRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const wt = services.worktreeManager.getWorktree(handoff_id);
  if (!wt) {
    return json({ error: { code: 'not_found', message: `worktree for handoff ${handoff_id} not found` } }, 404);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if (!body?.pattern || typeof body.pattern !== 'string') {
    return json({ error: { code: 'invalid_args', message: 'pattern (string) required' } }, 400);
  }

  if (body.path) {
    try {
      body.path = await resolveInsideWorktree(body.path, wt.path);
    } catch (err) {
      if (err instanceof FsPathError) {
        return json({ error: { code: err.code, message: err.message } }, err.code === 'outside_worktree' ? 400 : 404);
      }
      throw err;
    }
  }

  try {
    return json(
      await executeGrep(
        {
          pattern: body.pattern,
          path: body.path ?? null,
          glob: body.glob ?? null,
          output_mode: body.output_mode ?? 'content',
          case_insensitive: body.case_insensitive === true,
          include_ignored: body.include_ignored === true,
          max_results: typeof body.max_results === 'number' ? body.max_results : null,
        },
        wt.path,
      ),
    );
  } catch (err) {
    if (err instanceof GrepError) {
      const status = err.code === 'bad_pattern' ? 400 : err.code === 'engine_unavailable' ? 500 : 500;
      return json({ error: { code: err.code, message: err.message } }, status);
    }
    return json({ error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } }, 500);
  }
}
