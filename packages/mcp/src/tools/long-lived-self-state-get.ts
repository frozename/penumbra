import type { Database } from 'bun:sqlite';
import { WorkingMemorySchema } from '@penumbra/core/long-lived/types';

export interface SelfStateGetContext {
  running_agent_id?: string;
}

export async function handleLongLivedSelfStateGet(
  db: Database,
  ctx: SelfStateGetContext,
  _args: Record<string, never>,
) {
  if (!ctx.running_agent_id) throw new Error('no_running_long_lived_tick');
  const row = db.query<{ working_memory_json: string }, [string]>(
    'SELECT working_memory_json FROM long_lived_agents WHERE id = ?',
  ).get(ctx.running_agent_id);
  if (!row) throw new Error('agent_not_found');
  return { working_memory: WorkingMemorySchema.parse(JSON.parse(row.working_memory_json)) };
}
