import type { Database } from "bun:sqlite";

import { isRetiredLongLivedAgent } from "@penumbra/core/long-lived/retired-agents";
import { z } from "zod";

export const LongLivedApproveActionArgsSchema = z
  .object({
    action_id: z.string().min(1),
    decided_by: z.string().min(1).optional(),
  })
  .strict();

interface WorkingMemory {
  pending_goals?: {
    kind: string;
    pending_action_id: string;
    original_payload: unknown;
    created_at: number;
  }[];
  updated_at?: number;
  [key: string]: unknown;
}

export function handleLongLivedApproveAction(
  db: Database,
  deps: {
    emit: (event: { type: string; agent_id: string; payload: unknown }) => void;
    now: () => number;
  },
  args: unknown,
): { ok: true } {
  const { action_id, decided_by } = LongLivedApproveActionArgsSchema.parse(args ?? {});
  const row = db
    .query<
      {
        agent_id: string;
        tick_id: string | null;
        action_kind: string;
        action_target: string;
        payload_json: string;
        status: string;
      },
      [string]
    >(
      "SELECT agent_id, tick_id, action_kind, action_target, payload_json, status FROM long_lived_pending_actions WHERE id=?",
    )
    .get(action_id);
  if (!row) {
    throw new Error("not_found");
  }
  if (isRetiredLongLivedAgent(row.agent_id)) throw new Error("agent_retired");

  const now = deps.now();
  db.transaction(() => {
    db.query(
      "UPDATE long_lived_pending_actions SET status='approved', decided_by=?, decided_at=? WHERE id=? AND status='pending'",
    ).run(decided_by ?? "user", now, action_id);
    const result = db.query<{ changes: number }, []>("SELECT changes() AS changes").get();
    if (!result) throw new Error("database did not report changes");
    const { changes } = result;
    if (changes === 0) {
      throw new Error("not_pending");
    }
    db.query(
      `INSERT INTO long_lived_action_audit
      (agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at)
      VALUES (?, ?, ?, ?, ?, 'approved', NULL, ?)`,
    ).run(row.agent_id, row.tick_id, action_id, row.action_kind, row.action_target, now);

    const agent = db
      .query<
        { working_memory_json: string },
        [string]
      >("SELECT working_memory_json FROM long_lived_agents WHERE id=?")
      .get(row.agent_id);
    if (agent) {
      const workingMemory = JSON.parse(agent.working_memory_json) as WorkingMemory;
      workingMemory.pending_goals = workingMemory.pending_goals ?? [];
      workingMemory.pending_goals.push({
        kind: "approved_action",
        pending_action_id: action_id,
        original_payload: JSON.parse(row.payload_json) as unknown,
        created_at: now,
      });
      workingMemory.updated_at = now;
      db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?").run(
        JSON.stringify(workingMemory),
        now,
        row.agent_id,
      );
    }
  })();

  deps.emit({
    type: "long_lived_action_decided",
    agent_id: row.agent_id,
    payload: { action_id, decision: "approved" },
  });
  return { ok: true };
}
