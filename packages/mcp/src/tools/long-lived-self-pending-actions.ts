import type { Database } from 'bun:sqlite';
import { listLongLivedPendingActionsForAgent } from '../../../core/src/long-lived/self-reader.js';
import { verifyRunningIdentity } from '../long-lived-context.js';

export async function handleLongLivedSelfPendingActions(
  db: Database,
  ctx: { running_agent_id?: string; running_tick_id?: string },
  _args: Record<string, never>,
) {
  const identity = verifyRunningIdentity(db, ctx);
  const rows = listLongLivedPendingActionsForAgent(db, identity.agent_id);
  return { pending_actions: rows };
}
