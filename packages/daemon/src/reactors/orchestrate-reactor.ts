import type { Database } from "bun:sqlite";
import type {
  AgentDescriptor,
  ChainStartRequest,
  Logger,
  MaestroTerminationReason,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import { createLogger, MaestroSessionWriter, routeAgent } from "@penumbra/core";
import { orchestrateOneTask } from "../maestro/orchestrate-one-task.js";

const ORCHESTRATE_BACKSTOP_INTERVAL_MS = 30_000;
const ORCHESTRATE_BACKSTOP_BATCH_LIMIT = 500;
const defaultLog = createLogger({ component: "daemon:orchestrate-reactor" });

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
  chainCancel?: (chain_handoff_id: string) => Promise<void>;
  resolveAgent: (name: string) => AgentDescriptor | undefined;
  defaults: ReactorBounds;
  routeAgent?: typeof routeAgent;
  now?: () => number;
  log?: Pick<Logger, "warn">;
}

interface SpawnedRow {
  task_id: string;
  payload_json: string;
}

interface HandoffStatusRow {
  status: string;
}

interface TaskStatusRow {
  status: string;
}

interface OpenLeaseRow {
  id: string;
}

export function createOrchestrateReactor(opts: CreateOrchestrateReactorOpts): {
  start(): void;
  stop(): void;
  /** Run the chain-completion backstop once (exposed for tests/maintenance). */
  reconcileChainCompletions(): void;
} {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  let iterator: AsyncIterableIterator<{
    task_id: string;
    at: number;
    kind: string;
    actor: string | null;
    payload: Record<string, unknown> | null;
  }> | null = null;
  let running = false;
  let chainCompletionPoll: ReturnType<typeof setInterval> | null = null;

  // Reconcile orchestrate tasks whose spawned chain has reached a terminal
  // handoff state but whose parent task is still missing an
  // orchestrate_terminated event. Without this, plan-runtime keeps the task
  // "running" until bounds-callbacks fires bounds_exceeded:wall_clock — even
  // when the underlying chain completed cleanly in seconds. Bounds-callbacks
  // only writes the terminated event on bounds exceed, not on chain success.
  function reconcileChainCompletions(): void {
    const rows = opts.db
      .query<SpawnedRow, [number]>(
        `SELECT te.task_id AS task_id, te.payload_json AS payload_json
         FROM task_events te
        WHERE te.kind = 'orchestrate_spawned'
          AND NOT EXISTS (
            SELECT 1 FROM task_events te2
             WHERE te2.task_id = te.task_id
               AND te2.kind = 'orchestrate_terminated'
          )
        ORDER BY te.id ASC
        LIMIT ?`,
      )
      .all(ORCHESTRATE_BACKSTOP_BATCH_LIMIT);
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
        .query<
          HandoffStatusRow | null,
          [string]
        >("SELECT status FROM handoffs WHERE handoff_id = ? LIMIT 1")
        .get(chainHandoffId);
      if (!handoff) continue;
      if (
        handoff.status !== "completed" &&
        handoff.status !== "failed" &&
        handoff.status !== "cancelled"
      ) {
        continue;
      }
      const terminationReason: MaestroTerminationReason =
        handoff.status === "completed"
          ? "completed"
          : handoff.status === "cancelled"
            ? "cancelled"
            : "failed";
      void recordTerminated(
        row.task_id,
        {
          reason: handoff.status === "completed" ? "completed" : `chain_${handoff.status}`,
          chain_handoff_id: chainHandoffId,
          chain_status: handoff.status,
        },
        terminationReason,
      ).catch((err) => {
        log.warn({ err, task_id: row.task_id }, "reconcile recordTerminated backstop failed");
      });
    }
  }

  async function recordTerminated(
    taskId: string,
    payload: Record<string, unknown>,
    terminationReason: MaestroTerminationReason,
  ): Promise<void> {
    const ts = now();
    // Mark the maestro_session row terminated so bounds-tracker stops counting
    // its budget. Without this, listLive() keeps returning the session and the
    // wall_clock budget eventually fires bounds_exceeded:wall_clock long after
    // the underlying chain reached its own terminal state.
    opts.sessions.terminate(taskId, terminationReason);
    opts.db
      .query<unknown, [string, number, string, string]>(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_terminated', NULL, ?, ?)`,
      )
      .run(taskId, ts, JSON.stringify(payload), taskId);

    // Completion backstop: if the dispatched agent never resolved the task
    // itself (still `leased`) when its chain reached a terminal state, resolve
    // it here. Otherwise it hangs `leased` until the lease expires, then the
    // lease-sweeper reclaims it -> re-dispatch loop. We FAIL rather than infer
    // success: a terminated chain is not proof the acceptance criteria were met
    // -- the agent's own task.complete call is the only success signal. Tasks
    // the agent self-resolved are already terminal here and left untouched, and
    // the chainStart-failure path leaves the task `pending` (no open lease), so
    // it is skipped too and stays retryable.
    const taskStatusRow = opts.db
      .query<TaskStatusRow | null, [string]>("SELECT status FROM tasks WHERE id = ? LIMIT 1")
      .get(taskId);
    if (taskStatusRow?.status === "leased") {
      const openLease = opts.db
        .query<OpenLeaseRow | null, [string]>(
          `SELECT id
             FROM task_leases
            WHERE task_id = ? AND released_at IS NULL
            ORDER BY claimed_at DESC
            LIMIT 1`,
        )
        .get(taskId);
      if (openLease) {
        const failReason =
          terminationReason === "completed"
            ? "chain_completed_without_self_completion"
            : `chain_${terminationReason}`;
        try {
          opts.taskWriter.fail({ task_id: taskId, lease_id: openLease.id, reason: failReason });
        } catch {
          // Best-effort: the session is already terminated and the
          // orchestrate_terminated event recorded, so a lost fail race
          // (e.g. a concurrent self-complete) is benign.
        }
      }
    }
  }

  async function recordSpawned(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const ts = now();
    opts.db
      .query<unknown, [string, number, string, string]>(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_spawned', NULL, ?, ?)`,
      )
      .run(taskId, ts, JSON.stringify(payload), taskId);
  }

  async function recordDeferred(taskId: string, payload: Record<string, unknown>): Promise<void> {
    const ts = now();
    opts.db
      .query<unknown, [string, number, string, string]>(
        `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
       VALUES (?, ?, 'orchestrate_deferred', NULL, ?, ?)`,
      )
      .run(taskId, ts, JSON.stringify(payload), taskId);
  }

  async function handleFiled(taskId: string): Promise<void> {
    const taskKind = opts.db
      .query<TaskKindRow | null, [string]>("SELECT kind FROM tasks WHERE id = ? LIMIT 1")
      .get(taskId);
    if (!taskKind || taskKind.kind !== "orchestrate") return;

    const result = await orchestrateOneTask(taskId, {
      db: opts.db,
      sessions: opts.sessions,
      taskWriter: opts.taskWriter,
      chainStart: opts.chainStart,
      chainCancel: opts.chainCancel,
      resolveAgent: opts.resolveAgent,
      defaults: opts.defaults,
      routeAgent: opts.routeAgent ?? routeAgent,
      now,
    });
    if (result.status === "short_circuited") {
      if (result.reason === "subscription_pressure_capped") {
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
    if (result.status === "failed") {
      await recordTerminated(
        taskId,
        {
          reason: "failed",
          error: result.error,
          agent_name: result.agent_name ?? null,
        },
        "failed",
      );
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
      iterator = opts.bus.subscribe((event) => event.kind === "filed");
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
      }, ORCHESTRATE_BACKSTOP_INTERVAL_MS);
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

    reconcileChainCompletions(): void {
      reconcileChainCompletions();
    },
  };
}
