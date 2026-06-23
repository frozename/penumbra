import type {
  MaestroSessionRecord,
  MaestroSessionWriter,
  TaskEventBus,
  TaskWriter,
} from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { enqueueGhStatusSyncOnDb } from "@penumbra/core";

interface OpenLeaseRow {
  id: string;
}

export interface RunRestartResumeOpts {
  db: Database;
  sessions: MaestroSessionWriter;
  taskWriter: TaskWriter;
  isChainAlive: (chain_handoff_id: string) => boolean | Promise<boolean>;
  attachToTracker: (session: MaestroSessionRecord) => void;
  bus: TaskEventBus;
  now?: () => number;
}

function appendTerminatedEvent(
  db: Database,
  bus: TaskEventBus,
  input: {
    task_id: string;
    at: number;
    payload: Record<string, unknown>;
  },
): void {
  db.query<unknown, [string, number, string, string]>(
    `INSERT INTO task_events (task_id, at, kind, actor, payload_json, maestro_session_task_id)
     VALUES (?, ?, 'orchestrate_terminated', NULL, ?, ?)`,
  ).run(input.task_id, input.at, JSON.stringify(input.payload), input.task_id);

  bus.publish({
    task_id: input.task_id,
    at: input.at,
    kind: "orchestrate_terminated",
    actor: null,
    payload: input.payload,
  });
}

function failTaskWithoutLease(db: Database, task_id: string, reason: string, nowMs: number): void {
  const res = db
    .query<unknown, [string, number, string]>(
      `UPDATE tasks
     SET status = 'failed', failure_reason = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('done', 'done_pending_review', 'failed', 'cancelled')`,
    )
    .run(reason, nowMs, task_id);
  // Raw-SQL fail bypasses TaskWriter; keep the gh status-sync invariant (only
  // when the row actually transitioned, and only if the task is gh-linked).
  if (res.changes > 0) {
    enqueueGhStatusSyncOnDb(db, nowMs, task_id, null, "failed");
  }
}

export async function runRestartResume(
  opts: RunRestartResumeOpts,
): Promise<{ resumed: number; cleaned: number }> {
  const now = opts.now ?? Date.now;
  const live = opts.sessions.listLive();
  let resumed = 0;
  let cleaned = 0;

  for (const session of live) {
    if (!session.chain_handoff_id) {
      continue;
    }
    const alive = await Promise.resolve(opts.isChainAlive(session.chain_handoff_id));
    if (alive) {
      opts.attachToTracker(session);
      resumed += 1;
      continue;
    }

    const nowMs = now();
    const reason = "daemon_restart";
    opts.sessions.terminate(session.task_id, reason);

    const leaseRow = opts.db
      .query<OpenLeaseRow | null, [string]>(
        `SELECT id
         FROM task_leases
         WHERE task_id = ? AND released_at IS NULL
         ORDER BY claimed_at DESC
         LIMIT 1`,
      )
      .get(session.task_id);

    if (leaseRow) {
      try {
        opts.taskWriter.fail({
          task_id: session.task_id,
          lease_id: leaseRow.id,
          reason,
        });
      } catch {
        failTaskWithoutLease(opts.db, session.task_id, reason, nowMs);
      }
    } else {
      failTaskWithoutLease(opts.db, session.task_id, reason, nowMs);
    }

    appendTerminatedEvent(opts.db, opts.bus, {
      task_id: session.task_id,
      at: nowMs,
      payload: { reason },
    });

    cleaned += 1;
  }

  return { resumed, cleaned };
}
