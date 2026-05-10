import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const LongLivedTicksArgsSchema = z.object({
  id: z.string().min(1),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
}).strict();

export async function handleLongLivedTicks(db: Database, args: unknown) {
  const parsed = LongLivedTicksArgsSchema.parse(args ?? {});
  const rows = db.query(
    `SELECT id, agent_id, chain_id, trigger_kind, trigger_payload_json, intent_summary, started_at,
            completed_at, outcome, cost_cents, error_summary, working_memory_diff_json
     FROM long_lived_ticks
     WHERE agent_id = ?
       AND (?2 IS NULL OR started_at >= ?2)
     ORDER BY started_at DESC, id DESC
     LIMIT ?3`,
  ).all(parsed.id, parsed.since ?? null, parsed.limit ?? 50);
  return { ticks: rows };
}
