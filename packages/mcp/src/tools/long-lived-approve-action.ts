import type { Database } from "bun:sqlite";
import { z } from "zod";

export const LongLivedApproveActionArgsSchema = z
  .object({
    action_id: z.string().min(1),
    decided_by: z.string().min(1).optional(),
  })
  .strict();

export async function handleLongLivedApproveAction(
  db: Database,
  deps: {
    emit: (event: { type: string; agent_id: string; payload: unknown }) => void;
    now: () => number;
  },
  args: unknown,
) {
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
  if (!row) throw new Error("not_found");
  if (row.status !== "pending") throw new Error("not_pending");

  const now = deps.now();
  db.transaction(() => {
    db.query(
      "UPDATE long_lived_pending_actions SET status='approved', decided_by=?, decided_at=? WHERE id=?",
    ).run(decided_by ?? "user", now, action_id);
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
      const workingMemory = JSON.parse(agent.working_memory_json);
      workingMemory.pending_goals = workingMemory.pending_goals ?? [];
      workingMemory.pending_goals.push({
        kind: "approved_action",
        pending_action_id: action_id,
        original_payload: JSON.parse(row.payload_json),
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
