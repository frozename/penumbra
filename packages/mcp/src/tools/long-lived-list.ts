import type { Database } from "bun:sqlite";

export async function handleLongLivedList(db: Database, _args: Record<string, never>) {
  const agents = db
    .query<
      {
        id: string;
        display_name: string;
        status: string;
      },
      []
    >(
      `SELECT id, display_name, status
     FROM long_lived_agents
     WHERE status != 'retired'
     ORDER BY id`,
    )
    .all();
  return { agents };
}
