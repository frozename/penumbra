import type { Database } from 'bun:sqlite';
import type { AgentDescriptor, ChainStartRequest, TaskEventBus, TaskWriter } from '@penumbra/core';
import {
  MaestroSessionWriter,
  routeAgent,
} from '@penumbra/core';
import { orchestrateOneTask } from '../maestro/orchestrate-one-task.js';

interface TaskKindRow {
  kind: string;
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
  routeAgent?: typeof routeAgent;
  now?: () => number;
}

interface SpawnedRow {
  task_id: string;
  payload_json: string;
}

interface HandoffStatusRow {
  status: string;
}

export function createOrchestrateReactor(opts: CreateOrchestrateReactorOpts): { start(): void; stop(): void } {
  const now = opts.now ?? Date.now;
  let iterator: AsyncIterableIterator<{ task_id: string; at: number; kind: string; actor: string | null; payload: Record<string, unknown> | null }> | null = null;
  let running = false;
  let chainCompletionPoll: ReturnType<typeof setInterval> | null = null;

  // Reconcile orchestrate tasks whose spawned chain has reached a terminal
  // handoff state but whose parent task is still missing an
  // orchestrate_terminated event. Without this, plan-runtime keeps the task
  // "running" until bounds-callbacks fires bounds_exceeded:wall_clock — even
  // when the underlying chain completed cleanly in seconds. Bounds-callbacks
  // only writes the terminated event on bounds exceed, not on chain success.
  function reconcileChainCompletions(): void {
    const rows = opts.db.query<SpawnedRow, []>(
      `SELECT te.task_id AS task_id, te.payload_json AS payload_json
         FROM task_events te
        WHERE te.kind = 'orchestrate_spawned'
          AND NOT EXISTS (
            SELECT 1 FROM task_events te2
             WHERE te2.task_id = te.task_id
               AND te2.kind = 'orchestrate_terminated'
          )`,
    ).all();
    for (const row of rows) {
      let chainHandoffId: string | null = null;
      try {
        const payload = JSON.parse(row.payload_json) as { chain_handoff_id?: string };
        chainHandoffId = payload.chain_handoff_id ?? null;
      } catch {
        continue;
      }
      if (!chainHandoffId) continue;
      const handoff = opts.db
        .query<HandoffStatusRow | null, [string]>(
          'SELECT status FROM handoffs WHERE handoff_id = ? LIMIT 1',
        )
        .get(chainHandoffId);
      if (!handoff) continue;
      if (handoff.status !== 'completed' && handoff.status !== 'failed' && handoff.status !== 'cancelled') {
        continue;
      }
      void recordTerminated(row.task_id, {
        reason: handoff.status === 'completed' ? 'completed' : `chain_${handoff.status}`,
        chain_handoff_id: chainHandoffId,
        chain_status: handoff.status,
      });
    }
  }

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

  async function recordDeferred(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const ts = now();
    opts.db.query<unknown, [string, number, string, string]>(
      `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_deferred', NULL, ?, ?)`,
    ).run(taskId, ts, JSON.stringify(payload), taskId);
  }

  async function handleFiled(taskId: string): Promise<void> {
    const taskKind = opts.db
      .query<TaskKindRow | null, [string]>(
        'SELECT kind FROM tasks WHERE id = ? LIMIT 1',
      )
      .get(taskId);
    if (!taskKind || taskKind.kind !== 'orchestrate') return;

    const result = await orchestrateOneTask(taskId, {
      db: opts.db,
      sessions: opts.sessions,
      taskWriter: opts.taskWriter,
      chainStart: opts.chainStart,
      resolveAgent: opts.resolveAgent,
      defaults: opts.defaults,
      routeAgent: opts.routeAgent ?? routeAgent,
      now,
    });
    if (result.status === 'short_circuited') {
      if (result.reason === 'subscription_pressure_capped') {
        await recordDeferred(taskId, {
          reason: result.reason,
          resume_at_ms: result.resume_at_ms ?? null,
          provider: result.provider ?? null,
          window_label: result.window_label ?? null,
          original_error: result.original_error ?? null,
        });
      }
      return;
    }
    if (result.status === 'failed') {
      await recordTerminated(taskId, {
        reason: 'failed',
        error: result.error,
        agent_name: result.agent_name ?? null,
      });
      return;
    }

    await recordSpawned(taskId, {
      session_task_id: taskId,
      chain_handoff_id: result.chain_handoff_id,
      bounds: {
        wall_clock_budget_ms: result.session.wall_clock_budget_ms,
        cost_budget_cents: result.session.cost_budget_cents,
        sub_dispatch_budget: result.session.sub_dispatch_budget,
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
      chainCompletionPoll = setInterval(() => {
        try {
          reconcileChainCompletions();
        } catch {
          // keep poller alive across per-tick failures
        }
      }, 5000);
    },

    stop(): void {
      if (!running) return;
      running = false;
      const activeIterator = iterator;
      iterator = null;
      void activeIterator?.return?.();
      if (chainCompletionPoll !== null) {
        clearInterval(chainCompletionPoll);
        chainCompletionPoll = null;
      }
    },
  };
}
