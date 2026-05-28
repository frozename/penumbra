import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { WorkingMemorySchema } from "@penumbra/core/long-lived/types";
import { trimWorkingMemoryThreadNotes } from "@penumbra/core/long-lived/thread-notes-trim";

export const LongLivedStateSetArgsSchema = z
  .object({
    id: z.string().min(1),
    partial: z
      .object({
        intent_summary: z.string().optional(),
        working_memory: WorkingMemorySchema.optional(),
      })
      .refine((a) => a.intent_summary !== undefined || a.working_memory !== undefined, {
        message: "at least one of intent_summary or working_memory required",
      }),
  })
  .strict();

export async function handleLongLivedStateSet(db: Database, args: unknown) {
  const parsed = LongLivedStateSetArgsSchema.parse(args ?? {});
  const row = db
    .query<{ id: string }, [string]>("SELECT id FROM long_lived_agents WHERE id = ?")
    .get(parsed.id);
  if (!row) throw new Error("agent_not_found");

  const now = Date.now();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (parsed.partial.intent_summary !== undefined) {
    sets.push("last_intent_summary=?");
    params.push(parsed.partial.intent_summary);
  }
  if (parsed.partial.working_memory) {
    const trimmed = trimWorkingMemoryThreadNotes(parsed.partial.working_memory);
    sets.push("working_memory_json=?");
    params.push(JSON.stringify({ ...trimmed, updated_at: now }));
  }
  sets.push("updated_at=?");
  params.push(now);
  params.push(parsed.id);

  db.query(`UPDATE long_lived_agents SET ${sets.join(", ")} WHERE id=?`).run(
    ...(params as SQLQueryBindings[]),
  );
  return { ok: true };
}
