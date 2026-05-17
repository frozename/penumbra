import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { WorkingMemorySchema } from '../../../core/src/long-lived/types.js';
import { updateLongLivedAgentState } from '../../../core/src/long-lived/self-reader.js';
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
  updateLongLivedAgentState(db, identity.agent_id, parsed);
  return { ok: true };
}
