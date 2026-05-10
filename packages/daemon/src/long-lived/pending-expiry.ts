import type { Database } from 'bun:sqlite';

export interface PendingExpiryResult {
  expired: number;
}

export function runPendingExpiry(db: Database, opts: { now: number }): PendingExpiryResult {
  const expired = db.query<{ id: string; agent_id: string }, [number]>(
    "SELECT id, agent_id FROM long_lived_pending_actions WHERE status='pending' AND expires_at < ?",
  ).all(opts.now);

  for (const row of expired) {
    db.query(
      "UPDATE long_lived_pending_actions SET status='expired', decided_by='auto-expired', decided_at=? WHERE id=?",
    ).run(opts.now, row.id);

    const agent = db.query<{ working_memory_json: string }, [string]>(
      'SELECT working_memory_json FROM long_lived_agents WHERE id=?',
    ).get(row.agent_id);
    if (!agent) continue;

    const workingMemory = JSON.parse(agent.working_memory_json) as {
      recent_decisions?: Array<{ pending_action_id: string; decision: 'approved' | 'rejected' | 'expired'; reason?: string; decided_at: number }>;
      updated_at?: number;
    };

    workingMemory.recent_decisions ??= [];
    workingMemory.recent_decisions.push({
      pending_action_id: row.id,
      decision: 'expired',
      decided_at: opts.now,
    });
    workingMemory.updated_at = opts.now;

    db.query('UPDATE long_lived_agents SET working_memory_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(workingMemory), opts.now, row.agent_id);
  }

  return { expired: expired.length };
}
