import type { Database } from "bun:sqlite";

export function verifyRunningIdentity(db: Database, agent_id: string, tick_id: string): boolean {
  const row = db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM long_lived_ticks WHERE id = ? AND agent_id = ? AND completed_at IS NULL")
    .get(tick_id, agent_id);
  return row !== null;
}
