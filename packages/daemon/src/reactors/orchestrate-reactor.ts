import type {
  AgentDescriptor,
  ChainStartRequest,
  Logger,
  MaestroTerminationReason,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import type { Database } from "bun:sqlite";

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

type ReactorEvent = {
  task_id: string;
  at: number;
  kind: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
};

interface ReactorState {
  iterator: AsyncIterableIterator<ReactorEvent> | null;
  running: boolean;
  chainCompletionPoll: ReturnType<typeof setInterval> | null;
}

function insertTaskEvent(
  db: Database,
  taskId: string,
  ts: number,
  kind: "orchestrate_terminated" | "orchestrate_spawned" | "orchestrate_deferred",
  payload: Record<string, unknown>,
): void {
  db.query<unknown, [string, number, string, string]>(
    `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
     VALUES (?, ?, '${kind}', NULL, ?, ?)`,
  ).run(taskId, ts, JSON.stringify(payload), taskId);
}

function failOpenLeaseAfterTerminated(
  db: Database,
  taskWriter: TaskWriter,
  taskId: string,
  terminationReason: MaestroTerminationReason,
): void {
  // Completion backstop: if the dispatched agent never resolved the task
  // itself (still `leased`) when its chain reached a terminal state, resolve
  // it here. We FAIL rather than infer success: a terminated chain is not
  // proof the acceptance criteria were met -- the agent's own task.complete
  // call is the only success signal.
  const taskStatusRow = db
    .query<TaskStatusRow | null, [string]>("SELECT status FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId);
  if (taskStatusRow?.status !== "leased") return;
  const openLease = db
    .query<OpenLeaseRow | null, [string]>(
      `SELECT id
         FROM task_leases
        WHERE task_id = ? AND released_at IS NULL
        ORDER BY claimed_at DESC
        LIMIT 1`,
    )
    .get(taskId);
  if (!openLease) return;
  const failReason =
    terminationReason === "completed"
      ? "chain_completed_without_self_completion"
      : `chain_${terminationReason}`;
  try {
    taskWriter.fail({ task_id: taskId, lease_id: openLease.id, reason: failReason });
  } catch {
    // best-effort: the session is already terminated and the
    // orchestrate_terminated event recorded, so a lost fail race
    // (e.g. a concurrent self-complete) is benign.
  }
}

function recordTerminated(
  opts: CreateOrchestrateReactorOpts,
  taskId: string,
  payload: Record<string, unknown>,
  terminationReason: MaestroTerminationReason,
  nowMs: number,
): void {
  // Mark the maestro_session row terminated so bounds-tracker stops counting
  // its budget. Without this, listLive() keeps returning the session and the
  // wall_clock budget eventually fires bounds_exceeded:wall_clock long after
  // the underlying chain reached its own terminal state.
  opts.sessions.terminate(taskId, terminationReason);
  insertTaskEvent(opts.db, taskId, nowMs, "orchestrate_terminated", payload);
  failOpenLeaseAfterTerminated(opts.db, opts.taskWriter, taskId, terminationReason);
}

function decodeSpawnedChainHandoff(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as { chain_handoff_id?: string };
    return payload.chain_handoff_id ?? null;
  } catch {
    return null;
  }
}

function deriveTerminationReason(
  status: "completed" | "failed" | "cancelled",
): MaestroTerminationReason {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function reconcileChainCompletionsOnce(
  opts: CreateOrchestrateReactorOpts,
  log: Pick<Logger, "warn">,
  nowMs: number,
): void {
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
    const chainHandoffId = decodeSpawnedChainHandoff(row.payload_json);
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
    const terminationReason = deriveTerminationReason(handoff.status);
    try {
      recordTerminated(
        opts,
        row.task_id,
        {
          reason: handoff.status === "completed" ? "completed" : `chain_${handoff.status}`,
          chain_handoff_id: chainHandoffId,
          chain_status: handoff.status,
        },
        terminationReason,
        nowMs,
      );
    } catch (err) {
      log.warn({ err, task_id: row.task_id }, "reconcile recordTerminated backstop failed");
    }
  }
}

async function handleFiled(
  opts: CreateOrchestrateReactorOpts,
  taskId: string,
  nowFn: () => number,
): Promise<void> {
  const taskKind = opts.db
    .query<TaskKindRow | null, [string]>("SELECT kind FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId);
  if (taskKind?.kind !== "orchestrate") return;

  const result = await orchestrateOneTask(taskId, {
    db: opts.db,
    sessions: opts.sessions,
    taskWriter: opts.taskWriter,
    chainStart: opts.chainStart,
    chainCancel: opts.chainCancel,
    resolveAgent: opts.resolveAgent,
    defaults: opts.defaults,
    routeAgent: opts.routeAgent ?? routeAgent,
    now: nowFn,
  });
  if (result.status === "short_circuited") {
    if (result.reason === "subscription_pressure_capped") {
      insertTaskEvent(opts.db, taskId, nowFn(), "orchestrate_deferred", {
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
    recordTerminated(
      opts,
      taskId,
      { reason: "failed", error: result.error, agent_name: result.agent_name ?? null },
      "failed",
      nowFn(),
    );
    return;
  }

  insertTaskEvent(opts.db, taskId, nowFn(), "orchestrate_spawned", {
    session_task_id: taskId,
    chain_handoff_id: result.chain_handoff_id,
    bounds: {
      wall_clock_budget_ms: result.session.wall_clock_budget_ms,
      cost_budget_cents: result.session.cost_budget_cents,
      sub_dispatch_budget: result.session.sub_dispatch_budget,
    },
  });
}

export function createOrchestrateReactor(opts: CreateOrchestrateReactorOpts): {
  start(): void;
  stop(): void;
  /** Run the chain-completion backstop once (exposed for tests/maintenance). */
  reconcileChainCompletions(): void;
} {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const state: ReactorState = { iterator: null, running: false, chainCompletionPoll: null };

  function runReconcile(): void {
    reconcileChainCompletionsOnce(opts, log, now());
  }

  return {
    start(): void {
      if (state.running) return;
      state.running = true;
      state.iterator = opts.bus.subscribe((event) => event.kind === "filed");
      void (async (): Promise<void> => {
        const activeIterator = state.iterator;
        if (!activeIterator) return;
        for await (const event of activeIterator) {
          try {
            await handleFiled(opts, event.task_id, now);
          } catch (err) {
            // keep reactor alive after per-event failures
            opts.log?.warn(
              { task_id: event.task_id, err: String(err) },
              "orchestrate-reactor: filed-event handling failed",
            );
          }
        }
      })().catch((err: unknown) => {
        opts.log?.warn({ err: String(err) }, "orchestrate-reactor: event loop terminated");
      });
      state.chainCompletionPoll = setInterval((): void => {
        try {
          runReconcile();
        } catch (err) {
          // keep poller alive across per-tick failures
          opts.log?.warn(
            { err: String(err) },
            "orchestrate-reactor: chain-completion reconcile tick failed",
          );
        }
      }, ORCHESTRATE_BACKSTOP_INTERVAL_MS);
    },

    stop(): void {
      if (!state.running) return;
      state.running = false;
      const activeIterator = state.iterator;
      state.iterator = null;
      void activeIterator?.return?.();
      if (state.chainCompletionPoll !== null) {
        clearInterval(state.chainCompletionPoll);
        state.chainCompletionPoll = null;
      }
    },

    reconcileChainCompletions: runReconcile,
  };
}
