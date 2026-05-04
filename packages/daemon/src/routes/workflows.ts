import type { Services } from '@penumbra/core';
import { resolveProjectId } from '@penumbra/core';
import type { Registry } from '@penumbra/workflows';
import { composeRecall, executeWorkflow } from '@penumbra/workflows';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type WorkflowServices = Services & { workflowRegistry?: Registry };

export async function workflowsListRoute(_req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ workflows: [] });
  return json({
    workflows: reg.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      triggers: spec.triggers,
    })),
    errors: reg.errors,
  });
}

export async function workflowsRunRoute(req: Request, services: WorkflowServices): Promise<Response> {
  const reg = services.workflowRegistry;
  if (!reg) return json({ error: { code: 'no_registry', message: 'workflow registry not configured' } }, 500);

  const body = (await req.json().catch(() => null)) as { name?: string; cwd?: string } | null;
  const name = body?.name;
  if (!name) return json({ error: { code: 'bad_request', message: 'name required' } }, 400);

  const entry = reg.getEntry(name);
  if (!entry) return json({ error: { code: 'not_found', message: `workflow ${name} not found` } }, 404);

  const cwd = body?.cwd ?? process.cwd();
  let project = 'unknown';
  try {
    const resolved = resolveProjectId({ cwd });
    if (resolved.project_id) project = resolved.project_id;
  } catch {}

  const bundle = await composeRecall({
    db: (services as any).db,
    embedder: (services as any).embedder,
    cwd,
    project,
    sources: entry.spec.recall,
    budgetTokens: entry.spec.recall_budget_tokens,
  });

  const result = await executeWorkflow({
    spec: entry.spec,
    bundle,
    fn: entry.fn,
    storageRoot: (services as any).settings?.storageRoot ?? '/tmp',
    captureCtx: {
      db: (services as any).db,
      project,
      sessionId: 'daemon-direct',
      userId: 'penumbra',
      machineId: process.env.HOSTNAME ?? 'unknown',
    },
  });
  return json(result);
}
