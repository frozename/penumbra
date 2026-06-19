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
  const row = db
    .query<
      { status: string; schedule_cron: string | null; working_memory_json: string },
      [string]
    >("SELECT status, schedule_cron, working_memory_json FROM long_lived_agents WHERE id=?")
    .get(id);
  if (!row) throw new Error("not_found");
  if (row.status !== "active") throw new Error("not_active");

  const now = deps.now();
  const workingMemory = JSON.parse(row.working_memory_json);
  workingMemory.pending_goals = workingMemory.pending_goals ?? [];
  workingMemory.pending_goals.push({ kind: "user_goal", text: goal, created_at: now });
  workingMemory.updated_at = now;
  db.query("UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?").run(
    JSON.stringify(workingMemory),
    now,
    id,
  );

  if (!row.schedule_cron) {
    deps.fireTick({ agent_id: id, trigger_kind: "injected_goal" });
  }
  return { ok: true };
}
