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
  cost_budget_cents: z.number().int().positive(),
  sub_dispatch_budget: z.number().int().positive(),
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

  const taskRow = services.db
    .query<{ id: string; chain_id: string | null }, [string]>(
      'SELECT id, chain_id FROM tasks WHERE id = ? LIMIT 1',
    )
    .get(parsed.data.task_id);
  if (!taskRow) {
    return json({
      error: {
        code: 'not_found.task',
        message: `task ${parsed.data.task_id} not found`,
      },
    }, 404);
  }

  const handoffRow = services.db
    .query<{ handoff_id: string; conversation_id: string }, [string]>(
      'SELECT handoff_id, conversation_id FROM handoffs WHERE handoff_id = ? LIMIT 1',
    )
    .get(parsed.data.chain_handoff_id);
  if (!handoffRow) {
    return json({
      error: {
        code: 'not_found.handoff',
        message: `handoff ${parsed.data.chain_handoff_id} not found`,
      },
    }, 404);
  }

  if (taskRow.chain_id !== handoffRow.conversation_id) {
    return json({
      error: {
        code: 'handoff_task_mismatch',
        message: `handoff ${parsed.data.chain_handoff_id} does not belong to task ${parsed.data.task_id}`,
      },
    }, 422);
  }

  const servicesWithCfg = services as Services & {
    agentchatConfig?: {
      agents?: Array<{
        name: string;
        maestro_capable?: boolean;
      }>;
    };
  };
  const configAgents = servicesWithCfg.agentchatConfig?.agents ?? [];
  const knownAgents = services.agentRegistry
    ? new Set(services.agentRegistry)
    : new Set(configAgents.map((agent) => agent.name));
  if (!knownAgents.has(parsed.data.agent_id)) {
    return json({
      error: {
        code: 'not_found.agent',
        message: `agent ${parsed.data.agent_id} not found`,
      },
    }, 404);
  }
  const configuredAgent = configAgents.find((agent) => agent.name === parsed.data.agent_id);
  if (configuredAgent?.maestro_capable !== true) {
    return json({
      error: {
        code: 'agent_not_maestro_capable',
        message: `agent ${parsed.data.agent_id} must set maestro_capable: true`,
      },
    }, 422);
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
  maestro_capable: boolean;
  task_types?: string[];
};

export async function maestroCapabilitiesRoute(_req: Request, services: Services): Promise<Response> {
  const taskTypes = [...AgentTaskTypeSchema.options];
  const workflows = (services.workflowRegistry?.list() ?? [])
    .map((spec) => (spec && typeof spec === 'object' && 'name' in spec ? (spec as { name?: unknown }).name : null))
    .filter((name): name is string => typeof name === 'string');
  const agents = collectDispatchableAgents(services, taskTypes);
  return json({
    agents,
    task_types: taskTypes,
    workflows,
  });
}

function collectDispatchableAgents(services: Services, taskTypes: string[]): CapabilitiesAgent[] {
  const validTaskTypes = new Set(taskTypes);
  const servicesWithCfg = services as Services & {
    agentchatConfig?: {
      agents?: Array<{
        name: string;
        maestro_capable?: boolean;
        task_types?: string[];
        task_types_supported?: string[];
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
    .map((agent) => {
      const taskTypeSource = agent.task_types ?? agent.task_types_supported;
      const task_types = taskTypeSource
        ? taskTypeSource.filter((type) => validTaskTypes.has(type))
        : undefined;
      return {
        name: agent.name,
        maestro_capable: agent.maestro_capable === true,
        ...(task_types && task_types.length > 0 ? { task_types } : {}),
      };
    });
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
