import type { Database } from "bun:sqlite";

import { z } from "zod";

export const LongLivedResumeArgsSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

export function handleLongLivedResume(
  db: Database,
  args: unknown,
): { id: string; status: "active" } {
  const parsed = LongLivedResumeArgsSchema.parse(args ?? {});
  const row = db
    .query<{ status: string }, [string]>("SELECT status FROM long_lived_agents WHERE id = ?")
    .get(parsed.id);
  if (!row) {
    throw new Error("agent_not_found");
  }
  if (row.status !== "paused" && row.status !== "degraded" && row.status !== "retired") {
    throw new Error("invalid_long_lived_status_transition");
  }

  const now = Date.now();
  // V1: status flag only; cron stop happens at next reactor.reload(). Tick gate enforces.
  db.query(
    "UPDATE long_lived_agents SET status=?, consecutive_failures=0, degraded_reason=NULL, retired_at=NULL, updated_at=? WHERE id=?",
  ).run("active", now, parsed.id);
  return { id: parsed.id, status: "active" };
}
