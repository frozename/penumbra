import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const LongLivedPendingActionsArgsSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  status: z.string().min(1).nullable().optional(),
}).strict();

export async function handleLongLivedPendingActions(db: Database, args: unknown) {
  const parsed = LongLivedPendingActionsArgsSchema.parse(args ?? {});
  const rows = db.query(
    `SELECT *
     FROM long_lived_pending_actions
     WHERE (?1 IS NULL OR agent_id = ?1)
       AND (?2 IS NULL OR status = ?2)
     ORDER BY created_at DESC`,
  ).all(parsed.id ?? null, parsed.status ?? null);
  return { pending_actions: rows };
}
