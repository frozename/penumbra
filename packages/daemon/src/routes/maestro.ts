import { AgentTaskTypeSchema, MaestroSessionWriter } from '@penumbra/core';
import type { Services } from '@penumbra/core';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
