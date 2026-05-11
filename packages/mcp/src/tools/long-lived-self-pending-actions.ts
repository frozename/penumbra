import type { Database } from 'bun:sqlite';
import { verifyRunningIdentity } from '../long-lived-context.js';

export async function handleLongLivedSelfPendingActions(
  db: Database,
  ctx: { running_agent_id?: string; running_tick_id?: string },
  _args: Record<string, never>,
) {
  const identity = verifyRunningIdentity(db, ctx);
  const rows = db.query(
    "SELECT id, action_kind, action_target, payload_json, rationale, status, expires_at, created_at FROM long_lived_pending_actions WHERE agent_id=? AND status='pending' ORDER BY created_at DESC",
  ).all(identity.agent_id);
  return { pending_actions: rows };
}
