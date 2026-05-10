import type { Database } from 'bun:sqlite';
import { z } from 'zod';

export const LongLivedRejectActionArgsSchema = z.object({
  action_id: z.string().min(1),
  reason: z.string().optional(),
}).strict();

export async function handleLongLivedRejectAction(
  db: Database,
  deps: { emit: (event: { type: string; agent_id: string; payload: unknown }) => void; now: () => number },
  args: unknown,
) {
  const { action_id, reason } = LongLivedRejectActionArgsSchema.parse(args ?? {});
  const row = db.query<{ agent_id: string; status: string }, [string]>(
    'SELECT agent_id, status FROM long_lived_pending_actions WHERE id=?',
  ).get(action_id);
  if (!row) throw new Error('not_found');
  if (row.status !== 'pending') throw new Error('not_pending');

  const now = deps.now();
  db.query("UPDATE long_lived_pending_actions SET status='rejected', decided_by='user', decided_at=? WHERE id=?").run(now, action_id);

  const agent = db.query<{ working_memory_json: string }, [string]>(
    'SELECT working_memory_json FROM long_lived_agents WHERE id=?',
  ).get(row.agent_id);
  if (agent) {
    const workingMemory = JSON.parse(agent.working_memory_json);
    workingMemory.recent_decisions = workingMemory.recent_decisions ?? [];
    const entry: Record<string, unknown> = {
      pending_action_id: action_id,
      decision: 'rejected',
      decided_at: now,
    };
    if (reason !== undefined) entry.reason = reason;
    workingMemory.recent_decisions.push(entry);
    workingMemory.updated_at = now;
    db.query('UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(workingMemory), now, row.agent_id);
  }

  deps.emit({
    type: 'long_lived_action_decided',
    agent_id: row.agent_id,
    payload: { action_id, decision: 'rejected', reason },
  });
  return { ok: true };
}
