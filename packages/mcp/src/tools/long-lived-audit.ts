import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const LongLivedAuditArgsSchema = z.object({
  id: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
}).strict();

export async function handleLongLivedAudit(db: Database, args: unknown) {
  const parsed = LongLivedAuditArgsSchema.parse(args ?? {});
  const rows = db.query(
    `SELECT id, agent_id, tick_id, pending_action_id, action_kind, action_target, decision, reason, created_at
     FROM long_lived_action_audit
     WHERE agent_id = ?
       AND (?2 IS NULL OR created_at >= ?2)
     ORDER BY created_at DESC, id DESC
     LIMIT ?3`,
  ).all(parsed.id, parsed.since ?? null, parsed.limit ?? 100);
  return { audit: rows };
}
