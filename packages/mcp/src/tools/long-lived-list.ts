import type { Database } from "bun:sqlite";

export interface LongLivedListAgent {
  id: string;
  display_name: string;
  status: string;
}

export function handleLongLivedList(
  db: Database,
  _args: Record<string, never>,
): { agents: LongLivedListAgent[] } {
  const agents = db
    .query<LongLivedListAgent, []>(
      `SELECT id, display_name, status
     FROM long_lived_agents
     WHERE status != 'retired'
     ORDER BY id`,
    )
    .all();
  return { agents };
}
