import type { Services } from '@penumbra/core';
import type { Registry } from '@penumbra/workflows';

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
