import type { Database } from "bun:sqlite";
import { z } from "zod";

export const LongLivedPauseArgsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export async function handleLongLivedPause(db: Database, args: unknown) {
  const parsed = LongLivedPauseArgsSchema.parse(args ?? {});
  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM long_lived_agents WHERE id = ?")
    .get(parsed.id);
  if (!row) throw new Error("agent_not_found");
  if (row.status !== "active" && row.status !== "degraded")
    throw new Error("invalid_long_lived_status_transition");

  const now = Date.now();
  // V1: status flag only; cron stop happens at next reactor.reload(). Tick gate enforces.
  db.query("UPDATE long_lived_agents SET status=?, updated_at=? WHERE id=?").run(
    "paused",
    now,
    parsed.id,
  );
  return { id: parsed.id, status: "paused" };
}
