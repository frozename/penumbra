import type { Database } from 'bun:sqlite';

export async function handleLongLivedSelfPendingActions(
  db: Database,
  ctx: { running_agent_id?: string },
  _args: Record<string, never>,
) {
  if (!ctx.running_agent_id) throw new Error('no_running_long_lived_tick');
  const rows = db.query(
    "SELECT id, action_kind, action_target, payload_json, rationale, status, expires_at, created_at FROM long_lived_pending_actions WHERE agent_id=? AND status='pending' ORDER BY created_at DESC",
  ).all(ctx.running_agent_id);
  return { pending_actions: rows };
}
