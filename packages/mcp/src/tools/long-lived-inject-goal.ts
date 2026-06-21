import type { Database } from "bun:sqlite";
import { z } from "zod";

export const LongLivedInjectGoalArgsSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string().min(1),
  })
  .strict();

export async function handleLongLivedInjectGoal(
  db: Database,
  deps: {
    fireTick: (req: { agent_id: string; trigger_kind: "injected_goal" }) => void;
    now: () => number;
  },
  args: unknown,
) {
  const { id, goal } = LongLivedInjectGoalArgsSchema.parse(args ?? {});
  const now = deps.now();

  const injectTx = db.transaction(() => {
    const row = db
      .query<
        { status: string; schedule_cron: string | null; working_memory_json: string },
        [string]
      >("SELECT status, schedule_cron, working_memory_json FROM long_lived_agents WHERE id=?")
      .get(id);
    if (!row) throw new Error("not_found");
    if (row.status !== "active") throw new Error("not_active");

    const workingMemory = JSON.parse(row.working_memory_json);
    workingMemory.pending_goals = workingMemory.pending_goals ?? [];
    workingMemory.pending_goals.push({ kind: "user_goal", text: goal, created_at: now });
    workingMemory.updated_at = now;
    db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?").run(
      JSON.stringify(workingMemory),
      now,
      id,
    );

    return { schedule_cron: row.schedule_cron };
  });
  // BEGIN IMMEDIATE so the read takes the write lock; otherwise a concurrent
  // self-state-set or another inject can land between our SELECT and UPDATE
  // and clobber our merged working_memory.
  const result = injectTx.immediate();

  if (!result.schedule_cron) {
    deps.fireTick({ agent_id: id, trigger_kind: "injected_goal" });
  }
  return { ok: true };
}
