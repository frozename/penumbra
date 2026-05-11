import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { WorkingMemorySchema } from '@penumbra/core/long-lived/types';
import { verifyRunningIdentity } from '../long-lived-context.js';

const SelfStateSetArgsBaseSchema = z.object({
  intent_summary: z.string().optional(),
  working_memory: WorkingMemorySchema.optional(),
});

export const SelfStateSetInputShape = SelfStateSetArgsBaseSchema.shape;
export const SelfStateSetArgsSchema = SelfStateSetArgsBaseSchema.refine(
  (a) => a.intent_summary !== undefined || a.working_memory !== undefined,
  { message: 'at least one of intent_summary or working_memory required' },
);

export interface SelfStateSetContext {
  running_agent_id?: string;
  running_tick_id?: string;
}

export async function handleLongLivedSelfStateSet(
  db: Database,
  ctx: SelfStateSetContext,
  args: unknown,
) {
  const identity = verifyRunningIdentity(db, ctx);
  const parsed = SelfStateSetArgsSchema.parse(args);

  if (parsed.working_memory) {
    const now = Date.now();
    db.query('UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...parsed.working_memory, updated_at: now }), now, identity.agent_id);
  }
  if (parsed.intent_summary !== undefined) {
    const now = Date.now();
    db.query('UPDATE long_lived_agents SET last_intent_summary=?, updated_at=? WHERE id=?')
      .run(parsed.intent_summary, now, identity.agent_id);
  }
  return { ok: true };
}
