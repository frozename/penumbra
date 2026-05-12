import type { Database } from 'bun:sqlite';
import type { AgentDescriptor, ChainStartRequest, MaestroSessionRecord, TaskWriter } from '@penumbra/core';
import {
  MaestroSessionAlreadyDispatched,
  MaestroSessionExists,
  MaestroSessionWriter,
  synthesizeMaestroPrompt,
  routeAgent,
} from '@penumbra/core';

interface OrchestrateDefaults {
  wall_clock_ms: number;
  cost_cents: number;
  sub_dispatches: number;
}

export type OrchestrateOneTaskOpts = {
  db: Database;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  chainStart: (req: ChainStartRequest) => Promise<{ handoff_id: string; conversation_id: string }>;
  resolveAgent: (name: string) => AgentDescriptor | undefined;
  defaults: OrchestrateDefaults;
  routeAgent?: typeof routeAgent;
  now?: () => number;
};

export type OrchestrateOneTaskResult =
  | {
    status: 'dispatched';
    agent_name: string;
    chain_handoff_id: string;
    conversation_id: string;
    session: MaestroSessionRecord;
  }
  | {
    status: 'short_circuited';
    reason: 'task_not_found' | 'not_orchestrate' | 'already_dispatched' | 'subscription_pressure_capped';
    resume_at_ms?: number;
    provider?: string | null;
    window_label?: string | null;
    original_error?: Record<string, unknown> | null;
  }
  | {
    status: 'failed';
    error: string;
    agent_name?: string | null;
  };

const DEFER_RESUME_FLOOR_MS = 5 * 60_000;

export async function orchestrateOneTask(taskId: string, opts: OrchestrateOneTaskOpts): Promise<OrchestrateOneTaskResult> {
  const now = opts.now ?? Date.now;
  const existingSession = opts.sessions.get(taskId);
  if (existingSession?.chain_handoff_id) {
    return { status: 'short_circuited', reason: 'already_dispatched' };
  }

  let task;
  try {
    task = opts.taskWriter.get(taskId);
  } catch {
    return { status: 'short_circuited', reason: 'task_not_found' };
  }
  if (task.kind !== 'orchestrate') {
    return { status: 'short_circuited', reason: 'not_orchestrate' };
  }

  const preboundSession = existingSession ?? opts.sessions.get(taskId);
  if (preboundSession?.chain_handoff_id) {
    return { status: 'short_circuited', reason: 'already_dispatched' };
  }

  let agentName = preboundSession?.agent_id ?? '';
  if (!preboundSession) {
    const allowAgents = task.eligibility.allow_agents ?? [];
    if (allowAgents.length === 0) {
      return {
        status: 'failed',
        error: 'unknown_agent',
        agent_name: null,
      };
    }

    agentName = allowAgents[0]!;
    if (allowAgents.length > 1) {
      const routeAgentFn = opts.routeAgent ?? routeAgent;
      try {
        const ranked = routeAgentFn({
          db: opts.db,
          detail: 'rank',
          taskType: 'implement_substantial',
          minSamples: 1,
          includeNeutral: false,
          includeCost: false,
          now: new Date(now()),
        });
        if (ranked.detail !== 'rank') throw new Error('unexpected routeAgent detail');
        const allowAgentSet = new Set(allowAgents);
        const rankedAgent = ranked.candidates.candidates.find((candidate) => allowAgentSet.has(candidate.agent_name));
        if (rankedAgent) {
          agentName = rankedAgent.agent_name;
        } else {
          console.warn('[orchestrate-reactor] agent_rank lookup returned no overlapping eligible agents; falling back to first allowed agent', {
            task_id: taskId,
            allow_agents: allowAgents,
          });
        }
      } catch (error) {
        console.warn('[orchestrate-reactor] agent_rank lookup failed; falling back to first allowed agent', {
          task_id: taskId,
          allow_agents: allowAgents,
          error: String(error),
        });
      }
    }
  }

  const descriptor = opts.resolveAgent(agentName);
  if (!descriptor) {
    console.warn('[orchestrate-reactor] unknown agent for task', { task_id: taskId, agent_name: agentName });
    return {
      status: 'failed',
      error: 'unknown_agent',
      agent_name: agentName,
    };
  }

  const wall_clock_budget_ms = preboundSession?.wall_clock_budget_ms ?? task.bounds_wall_clock_ms ?? opts.defaults.wall_clock_ms;
  const cost_budget_cents = preboundSession?.cost_budget_cents ?? task.bounds_cost_cents ?? opts.defaults.cost_cents;
  const sub_dispatch_budget = preboundSession?.sub_dispatch_budget ?? task.bounds_max_sub_dispatches ?? opts.defaults.sub_dispatches;
  const prompt = synthesizeMaestroPrompt(task, {
    wall_clock_budget_ms,
    cost_budget_cents,
    sub_dispatch_budget,
  });

  let chain;
  try {
    chain = await opts.chainStart({
      initial_agent: agentName,
      message: prompt,
      project_id: task.project_id,
      task_type: 'implement_substantial',
      use_worktree: true,
      trust_mode: 'all',
      branch_base: task.branch_base ?? undefined,
    });
  } catch (error) {
    const parsed = parseSubscriptionPressureError(error);
    if (parsed && parsed.earliest_resets_at !== null) {
      let resumeAtMs = parsed.earliest_resets_at;
      if (resumeAtMs <= now()) {
        resumeAtMs = now() + DEFER_RESUME_FLOOR_MS;
      }
      return {
        status: 'short_circuited',
        reason: 'subscription_pressure_capped',
        resume_at_ms: resumeAtMs,
        provider: parsed.provider,
        window_label: parsed.window_label,
        original_error: parsed.body,
      };
    }
    return {
      status: 'failed',
      error: String(error),
      agent_name: agentName,
    };
  }

  if (preboundSession) {
    try {
      opts.sessions.markDispatched(taskId, chain.handoff_id);
    } catch (error) {
      if (error instanceof MaestroSessionAlreadyDispatched) {
        return { status: 'short_circuited', reason: 'already_dispatched' };
      }
      return { status: 'failed', error: String(error), agent_name: agentName };
    }
  } else {
    try {
      opts.sessions.start({
        task_id: taskId,
        chain_handoff_id: chain.handoff_id,
        agent_id: agentName,
        wall_clock_budget_ms,
        cost_budget_cents,
        sub_dispatch_budget,
      });
    } catch (error) {
      if (error instanceof MaestroSessionExists) {
        return { status: 'short_circuited', reason: 'already_dispatched' };
      }
      return { status: 'failed', error: String(error), agent_name: agentName };
    }
  }

  try {
    opts.taskWriter.lease({ task_id: taskId, agent_id: agentName });
  } catch (error) {
    return { status: 'failed', error: String(error), agent_name: agentName };
  }

  const session = opts.sessions.get(taskId);
  if (!session) {
    return { status: 'failed', error: 'session_missing_after_dispatch', agent_name: agentName };
  }
  return {
    status: 'dispatched',
    agent_name: agentName,
    chain_handoff_id: chain.handoff_id,
    conversation_id: chain.conversation_id,
    session,
  };
}

function parseSubscriptionPressureError(
  error: unknown,
): {
  earliest_resets_at: number | null;
  provider: string | null;
  window_label: string | null;
  body: Record<string, unknown> | null;
} | null {
  const body = extractErrorBody(error);
  if (!body || typeof body.error !== 'object' || body.error === null) {
    return null;
  }
  const errorBody = body.error as Record<string, unknown>;
  if (errorBody.code !== 'subscription_pressure_capped') {
    return null;
  }

  const earliest = typeof errorBody.earliest_resets_at === 'number'
    ? errorBody.earliest_resets_at
    : null;
  const provider = typeof errorBody.provider === 'string' ? errorBody.provider : null;
  const window_label = typeof errorBody.window_label === 'string' ? errorBody.window_label : null;
  return {
    earliest_resets_at: earliest,
    provider,
    window_label,
    body,
  };
}

function extractErrorBody(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null;
  const withBody = error as { body?: unknown; bodyText?: unknown };
  if (withBody.body && typeof withBody.body === 'object') {
    return withBody.body as Record<string, unknown>;
  }
  if (typeof withBody.bodyText === 'string') {
    try {
      const parsed = JSON.parse(withBody.bodyText);
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return null;
}
