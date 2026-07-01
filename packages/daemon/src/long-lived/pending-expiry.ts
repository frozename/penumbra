import type { NotificationOutboxKind } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { safeParseJSON } from "@penumbra/core";

export interface PendingExpiryResult {
  expired: number;
}

export interface PendingExpiryOpts {
  now: number;
  dispatchEventLog?: {
    record(event: {
      handoff_id: string;
      worker_id?: string | null;
      source: "worker" | "daemon";
      kind: string;
      ts: string;
      meta?: Record<string, unknown>;
    }): void;
  };
  notificationOutbox?: {
    enqueue(input: {
      project_id: string | null;
      kind: NotificationOutboxKind;
      reference_id: string;
      summary?: string;
      payload?: Record<string, unknown>;
      created_at: number;
    }): void;
  };
}

export function runPendingExpiry(db: Database, opts: PendingExpiryOpts): PendingExpiryResult {
  const now = opts.now;
  const pendingActions = db
    .query<
      { id: string; agent_id: string; action_kind: string; action_target: string },
      [number]
    >("SELECT id, agent_id, action_kind, action_target FROM long_lived_pending_actions WHERE status='pending' AND expires_at < ?")
    .all(now);

  const expirePendingAction = db.transaction(
    (row: {
      id: string;
      agent_id: string;
      action_kind: string;
      action_target: string;
    }): boolean => {
      const updateResult = db
        .query(
          "UPDATE long_lived_pending_actions SET status='expired', decided_by='auto-expired', decided_at=? WHERE id=? AND status='pending'",
        )
        .run(now, row.id) as { changes: number };
      if (updateResult.changes === 0) {
        return false;
      }

      db.query(
        `INSERT INTO long_lived_action_audit (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
         VALUES (?, NULL, ?, ?, ?, 'expired', 'auto_expired_ttl', ?)`,
      ).run(row.agent_id, row.id, row.action_kind, row.action_target, now);

      // Re-SELECT inside the transaction so the read-modify-write of
      // working_memory_json is atomic against concurrent tick-path writers.
      const agent = db
        .query<
          { working_memory_json: string; project_id: string | null },
          [string]
        >("SELECT working_memory_json, project_id FROM long_lived_agents WHERE id=?")
        .get(row.agent_id);
      let projectId: string | null = null;
      if (agent) {
        projectId = agent.project_id;
        // Defensive parse: a corrupt working_memory_json on one agent must not
        // wedge TTL expiry for that row or any later row. Treat unparseable
        // memory as empty so the expire still commits.
        const parsedMemory = safeParseJSON<{
          recent_decisions?: {
            pending_action_id: string;
            decision: "approved" | "rejected" | "expired";
            reason?: string;
            decided_at: number;
          }[];
          updated_at?: number;
        }>(agent.working_memory_json);
        const workingMemory = parsedMemory ?? {};

        workingMemory.recent_decisions ??= [];
        workingMemory.recent_decisions.push({
          pending_action_id: row.id,
          decision: "expired",
          decided_at: now,
        });
        workingMemory.updated_at = now;

        db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?").run(
          JSON.stringify(workingMemory),
          now,
          row.agent_id,
        );
      }

      const dispatchEventLog = opts.dispatchEventLog;
      if (dispatchEventLog) {
        dispatchEventLog.record({
          handoff_id: `pending_action_${row.id}`,
          worker_id: null,
          source: "daemon",
          kind: "long_lived.action.expired",
          ts: new Date(now).toISOString(),
          meta: {
            action_id: row.id,
            agent_id: row.agent_id,
            action_kind: row.action_kind,
            action_target: row.action_target,
            reason: "auto_expired_ttl",
          },
        });
      }

      const notificationOutbox = opts.notificationOutbox;
      if (notificationOutbox) {
        notificationOutbox.enqueue({
          project_id: projectId,
          kind: "pending_action_expired",
          reference_id: row.id,
          summary: `Expired: ${row.action_kind} → ${row.action_target}`,
          payload: {
            action_id: row.id,
            agent_id: row.agent_id,
            action_kind: row.action_kind,
            action_target: row.action_target,
            reason: "auto_expired_ttl",
          },
          created_at: now,
        });
      }

      return true;
    },
  );

  let expired = 0;
  for (const row of pendingActions) {
    try {
      const didExpire = expirePendingAction(row);
      if (didExpire) {
        expired += 1;
      }
    } catch {
      // Per-row safety net: a row-level failure must not block the rest of
      // the sweep. The inner transaction rolls back any partial writes for
      // this row; we swallow the error and continue.
      continue;
    }
  }

  return { expired };
}

export const DEFAULT_PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getPendingActionTtlMs(): number {
  return Number(process.env.PENUMBRA_PENDING_ACTION_TTL_MS) || DEFAULT_PENDING_ACTION_TTL_MS;
}
