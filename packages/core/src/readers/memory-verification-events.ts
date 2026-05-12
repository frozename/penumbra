import type { Database } from 'bun:sqlite';

export type MemoryVerificationEvent = {
  event_id: string;
  memory_id: string;
  verifier_actor: string;
  claimed_by: string | null;
  reason: string | null;
  session_id: string | null;
  verified_at: string;
};

export function getMemoryVerificationEvents(
  db: Database,
  memoryId: string,
  limit = 50,
): MemoryVerificationEvent[] {
  return db
    .query<MemoryVerificationEvent, [string, number]>(
      `SELECT event_id, memory_id, verifier_actor, claimed_by, reason, session_id, verified_at
         FROM t2_memory_verification_events
        WHERE memory_id = ?
        ORDER BY verified_at DESC, event_id DESC
        LIMIT ?`,
    )
    .all(memoryId, limit);
}
