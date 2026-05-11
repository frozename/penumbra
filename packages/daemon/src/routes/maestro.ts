import { z } from 'zod';
import {
  AgentTaskTypeSchema,
  MaestroSessionExists,
  MaestroSessionWriter,
  type StartMaestroSessionParams,
} from '@penumbra/core';
import type { Services } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const StartMaestroSessionRequestSchema = z.object({
  task_id: z.string().min(1),
  chain_handoff_id: z.string().min(1),
  agent_id: z.string().min(1),
  wall_clock_budget_ms: z.number().int().positive(),
  cost_budget_cents: z.number().int().nonnegative(),
  sub_dispatch_budget: z.number().int().nonnegative(),
}).strict();

export async function maestroSessionGetRoute(req: Request, task_id: string, services: Services): Promise<Response> {
  const servicesWithMaestro = services as Services & { maestroSessions?: MaestroSessionWriter };
  const maestroSessions = servicesWithMaestro.maestroSessions ?? new MaestroSessionWriter({
    db: services.db,
  });
  const session = maestroSessions.get(task_id);
  if (!session) {
    return json({ error: { code: 'not_found', message: `maestro session ${task_id} not found` } }, 404);
  }
  return json(session);
}

export async function maestroSessionStartRoute(req: Request, services: Services): Promise<Response> {
  const body = await safeJson(req);
  if (body === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }
  const parsed = StartMaestroSessionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
    }, 400);
  }

  const servicesWithMaestro = services as Services & { maestroSessions?: MaestroSessionWriter };
  const maestroSessions = servicesWithMaestro.maestroSessions ?? new MaestroSessionWriter({
    db: services.db,
    now: () => services.clock().getTime(),
  });

  try {
    const created = maestroSessions.start(parsed.data as StartMaestroSessionParams);
    return json(created, 201);
  } catch (err) {
    if (err instanceof MaestroSessionExists) {
      return json(
        {
          error: {
            code: 'already_exists',
            message: err.message,
          },
          session: maestroSessions.get(err.task_id),
        },
        409,
      );
    }
    throw err;
  }
}

type CapabilitiesAgent = {
  name: string;
  task_types: string[];
  maestro_capable: boolean;
};

export async function maestroCapabilitiesRoute(_req: Request, services: Services): Promise<Response> {
  const taskTypes = [...AgentTaskTypeSchema.options];
  const workflows = (services.workflowRegistry?.list() ?? []).map((spec) => spec.name);
  const agents = collectDispatchableAgents(services, taskTypes);
  return json({
    agents,
    task_types: taskTypes,
    workflows,
  });
}

function collectDispatchableAgents(services: Services, taskTypes: string[]): CapabilitiesAgent[] {
  const servicesWithCfg = services as Services & {
    agentchatConfig?: {
      agents?: Array<{
        name: string;
        maestro_capable?: boolean;
      }>;
    };
  };
  const configAgents = servicesWithCfg.agentchatConfig?.agents ?? [];
  const dispatchable = services.agentRegistry
    ? new Set(services.agentRegistry)
    : new Set(configAgents.map((agent) => agent.name));

  return configAgents
    .filter((agent) => dispatchable.has(agent.name))
    .filter((agent) => !isHiddenOrInternalAgent(agent.name))
    .map((agent) => ({
      name: agent.name,
      task_types: taskTypes,
      maestro_capable: agent.maestro_capable === true,
    }));
}

function isHiddenOrInternalAgent(name: string): boolean {
  return name.startsWith('_') || name.startsWith('internal-');
}

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
