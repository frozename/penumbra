import type { ChainStartRequest, Services, CapCheckRefuse } from '@penumbra/core';
import { ChainStartRequestSchema, checkPressureCap, inferAgentTaskTypeForRole, MaestroSessionWriter, resolveAgentForRole, type AgentTaskType } from '@penumbra/core';
import { supportsMidSessionInject, type AcpWorkerManagerLike } from '../maestro/acp-injector.js';
import { enforceMaestroBudget } from '../maestro/chain-budget-gate.js';
import { buildProviderCaps } from '../maestro/build-provider-caps.js';

interface InitialRoute {
  agent: string;
  role: string | null;
  taskType: AgentTaskType | null;
}

type AgentChatConfigLike = {
  agents: Array<{
    name: string;
    pricing_mode?: 'api' | 'subscription';
    subscription_provider?: string;
    subscription_model?: string;
  }>;
};

export async function chainsStartRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);

  // P0.4: Check for active worker heartbeats (default 15s timeout)
  const timeoutMsStr = process.env.PENUMBRA_WORKER_HEARTBEAT_TIMEOUT_MS;
  const timeoutMs = timeoutMsStr ? parseInt(timeoutMsStr, 10) : 15000;
  if (!services.watchdog.hasActiveWorker(timeoutMs)) {
    return json(
      {
        error: {
          code: 'no_worker_registered',
          message: "no agentchat-worker registered; start one via 'bun packages/agentchat/bin/agentchat-worker.ts --storage-root <root>'",
        },
      },
      503,
    );
  }

  const parsed = ChainStartRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json({
      error: {
        code: 'validation_error',
        message: 'body failed schema validation',
        field_errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      },
    }, 400);
  }

  return chainStartInternal(parsed.data, services, { applyMaestroBudgetGate: true });
}

export function chainStartInternal(
  input: ChainStartRequest,
  services: Services,
  opts?: { applyMaestroBudgetGate?: boolean },
): Response {
  const applyMaestroBudgetGate = opts?.applyMaestroBudgetGate ?? false;

  // P0.3b: Auto-strip leading @
  let initialAgent = input.initial_agent;
  if (initialAgent.startsWith('@')) {
    initialAgent = initialAgent.slice(1);
    input.initial_agent = initialAgent;
  }
  const forceExactAgent = initialAgent.startsWith('agent:');
  if (forceExactAgent) {
    initialAgent = initialAgent.slice('agent:'.length);
    input.initial_agent = initialAgent;
  }

  if (initialAgent.length < 1) {
    return json({
      error: {
        code: 'invalid_agent',
        agent: initialAgent,
        hint: 'initial_agent must be non-empty after @-prefix/agent:-prefix stripping',
      },
    }, 400);
  }

  const route = resolveInitialRoute({
    initialAgent,
    message: input.message,
    taskType: input.task_type,
    forceExactAgent,
    services,
  });

  // P0.3a: Validate initial_agent against registry
  if (!route && services.agentRegistry && !services.agentRegistry.includes(initialAgent)) {
    return json({
      error: {
        code: 'unknown_agent',
        agent: initialAgent,
        hint: 'use chain.list_agents to enumerate valid agents',
      },
    }, 400);
  }
  const routedAgent = route?.agent ?? initialAgent;
  const routedRole = route?.role ?? null;

  if (applyMaestroBudgetGate) {
    const servicesWithMaestro = services as Services & { maestroSessions?: MaestroSessionWriter };
    const maestroSessions = servicesWithMaestro.maestroSessions
      ?? new MaestroSessionWriter({
        db: services.db,
        now: () => services.clock().getTime(),
      });
    const budgetGate = enforceMaestroBudget({
      db: services.db,
      sessions: maestroSessions,
      parent_handoff_id: input.parent_handoff_id ?? undefined,
    });
    if (!budgetGate.ok) {
      return json(budgetGate.body, budgetGate.status);
    }
  }

  if (input.parent_handoff_id) {
    const parentToAgent = services.handoffReader.get(input.parent_handoff_id)?.to_agent;
    if (parentToAgent) {
      const cfg = (services as Services & { agentchatConfig?: AgentChatConfigLike }).agentchatConfig;
      const maestroAgent = cfg?.agents.find((agent) => agent.name === parentToAgent);
      const subAgent = cfg?.agents.find((agent) => agent.name === input.initial_agent);
      if (maestroAgent && subAgent) {
        const providerCaps = buildProviderCaps(services.providerQuotas);
        const gateChecks = [
          { subject: 'maestro' as const, agent: maestroAgent, agent_name: parentToAgent },
          { subject: 'sub_agent' as const, agent: subAgent, agent_name: input.initial_agent },
        ];

        for (const gate of gateChecks) {
          const outcome = checkPressureCap({
            cache: services.subscriptionPressureCache,
            agent: gate.agent,
            providerCaps: providerCaps as unknown as Parameters<typeof checkPressureCap>[0]['providerCaps'],
            now: () => services.clock(),
          });
          if (outcome.state === 'warn') {
            console.warn('subscription pressure warning', {
              provider: outcome.provider,
              window_label: outcome.window_label,
              used_pct: outcome.used_pct,
              warn_pct: outcome.warn_pct,
              refuse_pct: outcome.refuse_pct,
            });
            // Phase 2 will route warn outcomes into the bounds-tracker soft-warn path.
            continue;
          }
          if (outcome.state !== 'refuse') continue;

          recordPressureCapTrip({
            services,
            input,
            subject: gate.subject,
            agent_name: gate.agent_name,
            maestro_agent_name: parentToAgent,
            sub_agent_name: input.initial_agent,
            outcome,
          });

          return json({
            error: {
              code: 'subscription_pressure_capped',
              subject: gate.subject,
              agent_name: gate.agent_name,
              provider: outcome.provider,
              window_label: outcome.window_label,
              used_pct: outcome.used_pct,
              cap_pct: outcome.cap_pct,
              snapshot_state: outcome.snapshot_state,
              snapshot_age_seconds: outcome.snapshot_age_seconds,
            },
          }, 400);
        }
      }
    }
  }

  // Recursion depth guard: if parent_handoff_id is provided, walk the spawn
  // chain and reject if the new dispatch would exceed the cap. Reads env var
  // per-request (per observation 8351 — constructor-time latch is wrong).
  if (input.parent_handoff_id) {
    const cap = Number(process.env.PENUMBRA_RECURSION_DEPTH_CAP) || 8;
    const parentDepth = services.handoffReader.getSpawnDepth(input.parent_handoff_id);
    const newDepth = parentDepth + 1;
    if (newDepth >= cap) {
      return json({
        error: {
          code: 'recursion_depth_exceeded',
          message: `chain.start spawn depth ${newDepth} would meet/exceed cap ${cap}`,
          depth: newDepth,
          cap,
        },
      }, 409);
    }
  }

  const conversation_id = input.conversation_id ?? `conv-${services.uuid()}`;
  const user_prompt_event_id = services.uuid();
  const handoff_id = services.uuid();
  const ts = services.clock().toISOString();

  services.db.transaction(() => {
    services.t0Writer.write({
      event_id: user_prompt_event_id,
      ts, ingest_ts: ts,
      source: 'agentchat',
      source_detail: 'chain-start',
      project_id: input.project_id ?? null,
      user_id: 'local-user',
      machine_id: services.machineId.get(),
      session_id: conversation_id,
      event_type: 'user-prompt',
      lane: 'cli-subscription',
      provider: null, model: null,
      tokens_in: null, tokens_out: null, cost_usd: null, latency_ms: null,
      request_id: null,
      payload_json: { prompt: input.message },
      payload_summary: input.message.slice(0, 240),
      origin: null,
    });

    services.handoffWriter.createApproved({
      handoff_id, ts,
      project_id: input.project_id ?? null,
      conversation_id,
      from: 'user',
      to: routedAgent,
      to_role: routedRole,
      message: input.message,
      triggered_by_event_id: user_prompt_event_id,
      resolved_by: 'chain-start',
      resolved_at: null,
      chain_max_hops: input.max_hops ?? null,
      chain_trust_mode: input.trust_mode ?? null,
      chain_task_type: route?.taskType ?? input.task_type ?? null,
      use_worktree: input.use_worktree ?? null,
      parent_handoff_id: input.parent_handoff_id ?? null,
      branch_base: input.branch_base ?? null,
    });
  })();

  return json({
    conversation_id,
    handoff_id,
    ...(routedRole ? {
      routed_agent: routedAgent,
      routed_role: routedRole,
      routing_task_type: route?.taskType,
    } : {}),
  });
}

function recordPressureCapTrip(opts: {
  services: Services;
  input: ChainStartRequest;
  subject: 'maestro' | 'sub_agent';
  agent_name: string;
  maestro_agent_name: string;
  sub_agent_name: string;
  outcome: CapCheckRefuse;
}): void {
  const ts = opts.services.clock().toISOString();
  const payload = {
    ...opts.outcome,
    subject: opts.subject,
    trigger: 'pre_dispatch',
    maestro_agent_name: opts.maestro_agent_name,
    sub_agent_name: opts.sub_agent_name,
  };

  opts.services.t0Writer.write({
    event_id: opts.services.uuid(),
    ts,
    ingest_ts: ts,
    source: 'agentchat',
    source_detail: 'chain-start',
    project_id: opts.input.project_id ?? null,
    user_id: 'local-user',
    machine_id: opts.services.machineId.get(),
    session_id: opts.input.conversation_id ?? null,
    event_type: 'subscription-pressure-cap-trip',
    lane: 'cli-subscription',
    provider: opts.outcome.provider,
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: payload,
    payload_summary: `${opts.subject}:${opts.outcome.provider}:${opts.outcome.window_label}`,
    origin: 'maestro',
  });
}

export async function chainsHistoryRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const history = services.chainReader.listHistory(conversation_id, limit);
  return json({ history });
}

export async function chainsResponsesRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const whichParam = url.searchParams.get('which');
  const which = whichParam === 'all' ? 'all' : 'final';
  const responses = services.chainReader.getResponses(conversation_id, which);
  if (responses.length === 0 && !services.chainReader.conversationExists(conversation_id)) {
    return json({ error: { code: 'not_found', message: 'no chain events found for conversation' } }, 404);
  }
  return json({ responses });
}

export async function chainsMessagesRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const conversation_id = url.searchParams.get('conversation_id');
  if (!conversation_id) {
    return json({ error: { code: 'missing_param', message: 'conversation_id query parameter is required' } }, 400);
  }
  const typesParam = url.searchParams.get('types');
  const types = typesParam ? typesParam.split(',').map((t) => t.trim()).filter((t) => t.length > 0) : undefined;
  
  const events = services.chainReader.getMessages(conversation_id, types);
  return json({ events });
}

export async function chainSendMessageRoute(req: Request, handoff_id: string, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) {
    return json({ error: { code: 'invalid_json', message: 'request body was not valid JSON' } }, 400);
  }
  if (typeof raw !== 'object' || raw === null || typeof (raw as Record<string, unknown>).content !== 'string') {
    return json({ error: { code: 'validation_error', message: 'body must include content:string' } }, 400);
  }
  const { content } = raw as { content: string };
  const normalizedContent = content.trim();
  if (normalizedContent.length === 0) {
    return json({ error: { code: 'validation_error', message: 'content must be non-empty' } }, 400);
  }

  const handoff = services.handoffReader.get(handoff_id);
  if (!handoff) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }
  if (isTerminalHandoffStatus(String(handoff.status))) {
    return json({ error: { code: 'gone', message: `handoff ${handoff_id} is no longer running` } }, 410);
  }

  const workerManager = (services as Services & { workerManager?: AcpWorkerManagerLike }).workerManager;
  if (!workerManager || typeof workerManager.lookupSession !== 'function') {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }

  const session = await workerManager.lookupSession(handoff_id);
  if (!session) {
    return json({ error: { code: 'not_found', message: `handoff ${handoff_id} not found` } }, 404);
  }
  const adapterId = resolveAdapterId(session);
  if (!supportsMidSessionInject(adapterId)) {
    return json(
      {
        error: {
          code: 'unsupported_adapter',
          message: `adapter does not support mid-session inject: ${adapterId || 'unknown'}`,
        },
      },
      409,
    );
  }
  if (typeof session.inject !== 'function') {
    return json(
      {
        error: {
          code: 'unsupported_adapter',
          message: `adapter does not support mid-session inject: ${adapterId || 'unknown'}`,
        },
      },
      409,
    );
  }

  await session.inject({ role: 'user', text: normalizedContent });
  return json({ ok: true });
}

export async function chainsListAgentsRoute(_req: Request, services: Services): Promise<Response> {
  const agents = (services.agentRegistry ?? []).map((name) => ({ name }));
  return json({ agents });
}

async function safeJson(req: Request): Promise<unknown | null> {
  try { return await req.json(); } catch { return null; }
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function resolveAdapterId(session: { adapter?: string | null; adapter_kind?: string | null; metadata?: { adapter?: string | null; adapter_kind?: string | null } | null; worker?: { adapter?: string | null; adapter_kind?: string | null } | null; }): string {
  return session.adapter ?? session.adapter_kind ?? session.metadata?.adapter ?? session.metadata?.adapter_kind ?? session.worker?.adapter ?? session.worker?.adapter_kind ?? '';
}

function isTerminalHandoffStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected';
}

function resolveInitialRoute(opts: {
  initialAgent: string;
  message: string;
  taskType?: AgentTaskType;
  forceExactAgent: boolean;
  services: Services;
}): InitialRoute | null {
  const { agentRegistry, agentRouting } = opts.services;
  const roleAgents = (agentRouting?.agents ?? [])
    .filter((agent) => agent.roles.includes(opts.initialAgent))
    .map((agent) => agent.name)
    .filter((name) => !agentRegistry || agentRegistry.includes(name));
  if (!opts.forceExactAgent && agentRouting && roleAgents.length > 0) {
    return resolveRoleRoute(opts, roleAgents);
  }

  if (agentRegistry?.includes(opts.initialAgent)) {
    return { agent: opts.initialAgent, role: null, taskType: null };
  }
  return null;
}

function resolveRoleRoute(opts: {
  initialAgent: string;
  message: string;
  taskType?: AgentTaskType;
  services: Services;
}, roleAgents: string[]): InitialRoute {
  const taskType = opts.taskType ?? inferTaskTypeForRole(opts.message, opts.initialAgent);
  return resolveAgentForRole({
    services: opts.services,
    role: opts.initialAgent,
    message: opts.message,
    taskType,
  }) ?? { agent: roleAgents[0]!, role: opts.initialAgent, taskType };
}

function inferTaskTypeForRole(message: string, role: string): AgentTaskType {
  return inferAgentTaskTypeForRole(message, role);
}
