import type { Database } from "bun:sqlite";

export function getHandoffToAgent(db: Database, handoffId: string): string | null {
  const row = db
    .query<
      { to_agent: string | null },
      [string]
    >(`SELECT to_agent FROM handoffs WHERE handoff_id = ? LIMIT 1`)
    .get(handoffId);
  return row?.to_agent ?? null;
}
