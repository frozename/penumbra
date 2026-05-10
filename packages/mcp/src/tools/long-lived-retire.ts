import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const LongLivedRetireArgsSchema = z.object({
  id: z.string().min(1),
}).strict();

export async function handleLongLivedRetire(db: Database, args: unknown) {
  const parsed = LongLivedRetireArgsSchema.parse(args ?? {});
  const row = db.query<{ status: string }, [string]>(
    'SELECT status FROM long_lived_agents WHERE id = ?',
  ).get(parsed.id);
  if (!row) throw new Error('agent_not_found');

  const now = Date.now();
  // V1: status flag only; cron stop happens at next reactor.reload(). Tick gate enforces.
  db.query('UPDATE long_lived_agents SET status=?, retired_at=?, updated_at=? WHERE id=?')
    .run('retired', now, now, parsed.id);
  return { id: parsed.id, status: 'retired', retired_at: now };
}
