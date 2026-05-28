import type { Database } from "bun:sqlite";

export type Handoff = {
  handoff_id: string;
  ts: string;
  project_id: string | null;
  conversation_id: string;
  from_agent: string;
  to_agent: string;
  to_role: string | null;
  message: string;
  status: string;
};

export type HandoffSourceOutput = { handoffs: Handoff[]; warnings: string[] };

export function runHandoffPendingSource(input: {
  db: Database;
  args?: { conversation_id?: string };
}): HandoffSourceOutput {
  const { db, args } = input;
  const sql = `
    SELECT handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role, message, status
    FROM handoffs
    WHERE status = 'pending'
    ${args?.conversation_id ? "AND conversation_id = ?" : ""}
    ORDER BY ts ASC
  `;
  try {
    const params = args?.conversation_id ? [args.conversation_id] : [];
    const rows = db.query(sql).all(...(params as never[])) as Handoff[];
    return { handoffs: rows, warnings: [] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handoffs: [], warnings: [`handoff.list_pending: ${msg}`] };
  }
}
