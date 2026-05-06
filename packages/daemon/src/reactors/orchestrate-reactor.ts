import type { Database } from 'bun:sqlite';
import type { AgentDescriptor, ChainStartRequest, TaskEventBus, TaskWriter } from '@penumbra/core';
import {
  MaestroSessionExists,
  rankAgents,
  MaestroSessionWriter,
  synthesizeMaestroPrompt,
} from '@penumbra/core';

interface TaskKindRow {
  kind: string;
}

interface TaskProjectRow {
  project_id: string | null;
}

interface ReactorBounds {
  wall_clock_ms: number;
  cost_cents: number;
  sub_dispatches: number;
}

export interface CreateOrchestrateReactorOpts {
  db: Database;
  bus: TaskEventBus;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  chainStart: (req: ChainStartRequest) => Promise<{ handoff_id: string; conversation_id: string }>;
  resolveAgent: (name: string) => AgentDescriptor | undefined;
  defaults: ReactorBounds;
  rankAgents?: typeof rankAgents;
  now?: () => number;
}

export function createOrchestrateReactor(opts: CreateOrchestrateReactorOpts): { start(): void; stop(): void } {
  const now = opts.now ?? Date.now;
  let iterator: AsyncIterableIterator<{ task_id: string; at: number; kind: string; actor: string | null; payload: Record<string, unknown> | null }> | null = null;
  let running = false;

  async function recordTerminated(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const ts = now();
    opts.db.query<unknown, [string, number, string, string]>(
      `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_terminated', NULL, ?, ?)`,
    ).run(taskId, ts, JSON.stringify(payload), taskId);
  }

  async function recordSpawned(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const ts = now();
    opts.db.query<unknown, [string, number, string, string]>(
      `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_spawned', NULL, ?, ?)`,
    ).run(taskId, ts, JSON.stringify(payload), taskId);
  }

  async function handleFiled(taskId: string): Promise<void> {
    const taskKind = opts.db
      .query<TaskKindRow | null, [string]>(
        'SELECT kind FROM tasks WHERE id = ? LIMIT 1',
      )
      .get(taskId);
    if (!taskKind || taskKind.kind !== 'orchestrate') return;

    if (opts.sessions.get(taskId)) return;

    let task;
    try {
      task = opts.taskWriter.get(taskId);
    } catch {
      return;
    }

    if (task.kind !== 'orchestrate') return;
    if (opts.sessions.get(taskId)) return;

    const allowAgents = task.eligibility.allow_agents ?? [];
    if (allowAgents.length === 0) {
      await recordTerminated(taskId, {
        reason: 'failed',
        error: 'unknown_agent',
        agent_name: null,
      });
      return;
    }

    let agentName = allowAgents[0]!;
    if (allowAgents.length > 1) {
      const rankAgentsFn = opts.rankAgents ?? rankAgents;
      try {
        const ranked = rankAgentsFn(opts.db, {
          task_type: 'implement_substantial',
          min_samples: 1,
          include_neutral: false,
          include_cost: false,
        }, () => new Date(now()));
        const allowAgentSet = new Set(allowAgents);
        const rankedAgent = ranked.candidates.find((candidate) => allowAgentSet.has(candidate.agent_name));
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

    const descriptor = opts.resolveAgent(agentName);
    if (!descriptor) {
      console.warn('[orchestrate-reactor] unknown agent for task', { task_id: taskId, agent_name: agentName });
      await recordTerminated(taskId, {
        reason: 'failed',
        error: 'unknown_agent',
        agent_name: agentName,
      });
      return;
    }

    const wall_clock_budget_ms = task.bounds_wall_clock_ms ?? opts.defaults.wall_clock_ms;
    const cost_budget_cents = task.bounds_cost_cents ?? opts.defaults.cost_cents;
    const sub_dispatch_budget = task.bounds_max_sub_dispatches ?? opts.defaults.sub_dispatches;

    const prompt = synthesizeMaestroPrompt(task, {
      wall_clock_budget_ms,
      cost_budget_cents,
      sub_dispatch_budget,
    });
    let project_id: string | null = null;
    try {
      project_id = opts.db
        .query<TaskProjectRow, [string]>('SELECT project_id FROM tasks WHERE id = ? LIMIT 1')
        .get(taskId)?.project_id ?? null;
    } catch {
      project_id = null;
    }

    let chain;
    try {
      chain = await opts.chainStart({
        initial_agent: agentName,
        message: prompt,
        project_id,
        task_type: 'implement_substantial',
        use_worktree: true,
        trust_mode: 'all',
        branch_base: task.branch_base ?? undefined,
      });
    } catch (error) {
      await recordTerminated(taskId, {
        reason: 'failed',
        error: String(error),
      });
      return;
    }

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
        return;
      }
      throw error;
    }

    opts.taskWriter.lease({ task_id: taskId, agent_id: agentName });

    await recordSpawned(taskId, {
      session_task_id: taskId,
      chain_handoff_id: chain.handoff_id,
      bounds: {
        wall_clock_budget_ms,
        cost_budget_cents,
        sub_dispatch_budget,
      },
    });
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      iterator = opts.bus.subscribe((event) => event.kind === 'filed');
      void (async () => {
        const activeIterator = iterator;
        if (!activeIterator) return;
        for await (const event of activeIterator) {
          try {
            await handleFiled(event.task_id);
          } catch {
            // keep reactor alive after per-event failures
          }
        }
      })();
    },

    stop(): void {
      if (!running) return;
      running = false;
      const activeIterator = iterator;
      iterator = null;
      void activeIterator?.return?.();
    },
  };
}
