import type { Database } from "bun:sqlite";
import type { NotificationOutboxKind } from "@penumbra/core";

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

  for (const row of pendingActions) {
    db.query(
      "UPDATE long_lived_pending_actions SET status='expired', decided_by='auto-expired', decided_at=? WHERE id=?",
    ).run(now, row.id);

    db.query(
      `INSERT INTO long_lived_action_audit (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
       VALUES (?, NULL, ?, ?, ?, 'expired', 'auto_expired_ttl', ?)`,
    ).run(row.agent_id, row.id, row.action_kind, row.action_target, now);

    const agent = db
      .query<
        { working_memory_json: string },
        [string]
      >("SELECT working_memory_json FROM long_lived_agents WHERE id=?")
      .get(row.agent_id);
    if (agent) {
      const workingMemory = JSON.parse(agent.working_memory_json) as {
        recent_decisions?: Array<{
          pending_action_id: string;
          decision: "approved" | "rejected" | "expired";
          reason?: string;
          decided_at: number;
        }>;
        updated_at?: number;
      };

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

    if ("dispatchEventLog" in opts && opts.dispatchEventLog) {
      opts.dispatchEventLog.record({
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

    if ("notificationOutbox" in opts && opts.notificationOutbox) {
      let projectId: string | null = null;
      const agentRow = db
        .query<
          { project_id: string | null },
          [string]
        >("SELECT project_id FROM long_lived_agents WHERE id=?")
        .get(row.agent_id);
      if (agentRow) {
        projectId = agentRow.project_id;
      }

      opts.notificationOutbox.enqueue({
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
  }

  return { expired: pendingActions.length };
}

export const DEFAULT_PENDING_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getPendingActionTtlMs(): number {
  return Number(process.env.PENUMBRA_PENDING_ACTION_TTL_MS) || DEFAULT_PENDING_ACTION_TTL_MS;
}
