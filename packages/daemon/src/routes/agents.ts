import type { Services } from '@penumbra/core';
import {
  AgentPerformanceCaptureFromDispatchSchema,
  AgentPerformanceCaptureFromReconcilerSchema,
  AgentRankInputSchema,
  captureAgentPerformanceFromDispatch,
  captureAgentPerformanceFromReconciler,
  rankAgents,
} from '@penumbra/core';

export async function agentsPerformanceReconcilerRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromReconcilerSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const performance = captureAgentPerformanceFromReconciler({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('handoff not found:')) {
      return json({ error: { code: 'not_found', message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsPerformanceDispatchRoute(req: Request, services: Services): Promise<Response> {
  const raw = await req.json().catch(() => null);
  const parsed = AgentPerformanceCaptureFromDispatchSchema.safeParse(raw);
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  try {
    const performance = captureAgentPerformanceFromDispatch({
      db: services.db,
      uuid: services.uuid,
      clock: services.clock,
      input: parsed.data,
    });
    return json({ performance });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('handoff not found:')) {
      return json({ error: { code: 'not_found', message: err.message } }, 404);
    }
    throw err;
  }
}

export async function agentsRankRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const parsed = AgentRankInputSchema.safeParse({
    task_type: url.searchParams.get('task_type') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    min_samples: url.searchParams.get('min_samples') ?? undefined,
    include_neutral: url.searchParams.get('include_neutral') ?? undefined,
    include_cost: url.searchParams.get('include_cost') ?? undefined,
  });
  if (!parsed.success) return json({ error: { code: 'invalid_params', issues: parsed.error.issues } }, 400);
  return json(rankAgents(services.db, parsed.data, services.clock));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
