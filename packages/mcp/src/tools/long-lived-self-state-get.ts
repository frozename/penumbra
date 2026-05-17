import type { Database } from 'bun:sqlite';
import { readLongLivedAgentWorkingMemory } from '@penumbra/core/long-lived/self-reader';
import { verifyRunningIdentity } from '../long-lived-context.js';

export interface SelfStateGetContext {
  running_agent_id?: string;
  running_tick_id?: string;
}

export async function handleLongLivedSelfStateGet(
  db: Database,
  ctx: SelfStateGetContext,
  _args: Record<string, never>,
) {
  const identity = verifyRunningIdentity(db, ctx);
  return { working_memory: readLongLivedAgentWorkingMemory(db, identity.agent_id) };
}
