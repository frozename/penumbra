import { z } from 'zod';
import {
  AgentTaskTypeSchema,
  MaestroSessionExists,
  MaestroSessionWriter,
  TaskWriter,
  type ProjectScope,
  type AgentDescriptor,
  type StartMaestroSessionParams,
  resolveProjectScope,
} from '@penumbra/core';
import type { Services } from '@penumbra/core';
import { orchestrateOneTask } from '../maestro/orchestrate-one-task.js';
import { chainStartInternal } from './chains.js';

import { json } from './_helpers.js';

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function resolveMaestroProjectId(opts: {
  providedProjectId: string | null | undefined;
  scope: ProjectScope;
}): { ok: boolean; project_id: string | undefined; error?: { code: string; message: string; hint: string } } {
  if (opts.providedProjectId !== null && opts.providedProjectId !== undefined) {
    return { ok: true, project_id: opts.providedProjectId };
  }

  if (opts.scope.kind === 'registered' || opts.scope.kind === 'global') {
    return { ok: true, project_id: opts.scope.project_id ?? undefined };
  }

  const requireExplicitProjectId = isEnvTruthy(process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID);
  if (requireExplicitProjectId && (opts.scope.kind === 'no_match' || opts.scope.kind === 'registry_unavailable')) {
    return {
      ok: false,
      project_id: undefined,
      error: {
        code: 'project_id_required',
        message: `project_id_required: resolved from daemon cwd as ${opts.scope.project_id}`,
        hint: 'pass project_id explicitly, or unset PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID to keep the legacy default',
      },
    };
  }

  return { ok: true, project_id: undefined };
}

function getMaestroCwd(services: Services): string {
  return (services as { mainRepoDir?: string }).mainRepoDir ?? process.cwd();
}
const StartMaestroSessionRequestSchema = z.object({
  task_id: z.string().min(1),
  chain_handoff_id: z.string().min(1).optional(),
  agent_id: z.string().min(1),
  wall_clock_budget_ms: z.number().int().positive(),
  cost_budget_cents: z.number().int().positive(),
  sub_dispatch_budget: z.number().int().positive(),
}).strict();

const StartAdhocMaestroSessionRequestSchema = z.object({
  message: z.string().min(1),
  agent_id: z.string().min(1),
  wall_clock_budget_ms: z.number().int().positive(),
  cost_budget_cents: z.number().int().positive(),
  sub_dispatch_budget: z.number().int().positive(),
  project_id: z.string().min(1).nullable().optional(),
}).strict();

export async function maestroSessionGetRoute(req: Request, task_id: string, services: Services): Promise<Response> {
  const maestroSessions = services.maestroSessions ?? new MaestroSessionWriter({
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

  if (parsed.data.chain_handoff_id) {
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
  }

  const configAgents = getConfigAgents(services);
  const knownAgents = getKnownAgents(services, configAgents);
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

  const maestroSessions = services.maestroSessions ?? new MaestroSessionWriter({
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

export async function maestroSessionStartAdhocRoute(req: Request, services: Services): Promise<Response> {
  const body = await safeJson(req);
  if (body === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }
  const parsed = StartAdhocMaestroSessionRequestSchema.safeParse(body);
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

  const configAgents = getConfigAgents(services);
  const knownAgents = getKnownAgents(services, configAgents);
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

  const maestroSessions = services.maestroSessions ?? new MaestroSessionWriter({
    db: services.db,
    now: () => services.clock().getTime(),
  });

  const resolveAgent = buildResolveAgent(configAgents);
  const taskWriter = services.taskWriter ?? new TaskWriter(services.db, {
    now: () => services.clock().getTime(),
    resolveAgent,
    maestroSessions,
  });

  const maestroCwd = getMaestroCwd(services);
  const projectScope = resolveProjectScope({
    cwd: maestroCwd,
    registry: services.projectRegistry,
  });
  const resolvedProject = resolveMaestroProjectId({
    providedProjectId: parsed.data.project_id,
    scope: projectScope,
  });
  if (!resolvedProject.ok && resolvedProject.error) {
    return json({ error: { ...resolvedProject.error } }, 400);
  }

  if (parsed.data.project_id == null && projectScope.kind === 'no_match') {
    console.error('maestro /sessions/adhoc could not resolve project scope as registered project; using fallback dispatch scope', {
      cwd: maestroCwd,
      project_id: projectScope.project_id,
    });
  }
  if (parsed.data.project_id == null && projectScope.kind === 'registry_unavailable') {
    console.error('maestro /sessions/adhoc project registry unavailable; using fallback dispatch scope', {
      cwd: maestroCwd,
      project_id: projectScope.project_id,
    });
  }

  const created = taskWriter.file({
    prompt: parsed.data.message,
    project_id: resolvedProject.project_id,
    kind: 'orchestrate',
    eligibility: { allow_agents: [parsed.data.agent_id] },
    bounds: {
      wall_clock_ms: parsed.data.wall_clock_budget_ms,
      cost_cents: parsed.data.cost_budget_cents,
      max_sub_dispatches: parsed.data.sub_dispatch_budget,
    },
    created_by_kind: 'human',
    created_by_id: 'maestro.session.start_adhoc',
  });

  const dispatched = await orchestrateOneTask(created.task_id, {
    db: services.db,
    sessions: maestroSessions,
    taskWriter,
    chainStart: async (input) => {
      const response = await chainStartInternal(input, services, { applyMaestroBudgetGate: false });
      if (!response.ok) {
        const bodyText = await response.text();
        let errorBody: Record<string, unknown> | null = null;
        try {
          const decoded = JSON.parse(bodyText);
          if (typeof decoded === 'object' && decoded !== null) {
            errorBody = decoded as Record<string, unknown>;
          }
        } catch {
          errorBody = null;
        }
        const error = new Error(`chain_start failed (${response.status}): ${bodyText}`) as Error & {
          status?: number;
          bodyText?: string;
          body?: Record<string, unknown> | null;
        };
        error.status = response.status;
        error.bodyText = bodyText;
        error.body = errorBody;
        throw error;
      }
      const data = await response.json() as { handoff_id?: unknown; conversation_id?: unknown };
      if (typeof data.handoff_id !== 'string' || typeof data.conversation_id !== 'string') {
        throw new Error('chain_start returned malformed response');
      }
      return { handoff_id: data.handoff_id, conversation_id: data.conversation_id };
    },
    resolveAgent,
    defaults: {
      wall_clock_ms: 1_800_000,
      cost_cents: 200,
      sub_dispatches: 10,
    },
    now: () => services.clock().getTime(),
  });

  if (dispatched.status === 'dispatched') {
    return json(dispatched, 201);
  }
  if (dispatched.status === 'short_circuited') {
    return json({
      error: {
        code: 'orchestrate_short_circuited',
        reason: dispatched.reason,
      },
      task_id: created.task_id,
    }, 503);
  }
  return json({
    error: {
      code: 'orchestrate_failed',
      reason: dispatched.error,
      agent_name: dispatched.agent_name ?? null,
    },
    task_id: created.task_id,
  }, 502);
}

type CapabilitiesAgent = {
  name: string;
  maestro_capable: boolean;
  task_types?: string[];
};

type MaestroConfigAgent = {
  name: string;
  maestro_capable?: boolean;
  task_types?: string[];
  task_types_supported?: string[];
  tags?: string[];
  tier?: string;
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
  const configAgents = getConfigAgents(services);
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

function getConfigAgents(services: Services): MaestroConfigAgent[] {
  return services.agentchatConfig?.agents ?? [];
}

function getKnownAgents(services: Services, configAgents: MaestroConfigAgent[]): Set<string> {
  return services.agentRegistry
    ? new Set(services.agentRegistry)
    : new Set(configAgents.map((agent) => agent.name));
}

function buildResolveAgent(configAgents: MaestroConfigAgent[]): (name: string) => AgentDescriptor | undefined {
  return (name: string) => {
    const agent = configAgents.find((candidate) => candidate.name === name);
    if (!agent) return undefined;
    const tier = agent.tier === 'economy' || agent.tier === 'standard' || agent.tier === 'premium'
      ? agent.tier
      : 'standard';
    return {
      name: agent.name,
      maestro_capable: agent.maestro_capable,
      tags: agent.tags ?? [],
      tier,
    };
  };
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
