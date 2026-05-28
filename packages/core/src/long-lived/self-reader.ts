import type { Database } from "bun:sqlite";
import { WorkingMemorySchema, type WorkingMemory } from "./types.js";
import { trimWorkingMemoryThreadNotes } from "./thread-notes-trim.js";

export function readLongLivedAgentWorkingMemory(db: Database, agent_id: string): WorkingMemory {
  const row = db
    .query<
      { working_memory_json: string },
      [string]
    >("SELECT working_memory_json FROM long_lived_agents WHERE id = ?")
    .get(agent_id);
  if (!row) throw new Error("agent_not_found");
  return WorkingMemorySchema.parse(JSON.parse(row.working_memory_json));
}

export interface LongLivedAgentStateUpdate {
  working_memory?: WorkingMemory;
  intent_summary?: string;
}

export function updateLongLivedAgentState(
  db: Database,
  agent_id: string,
  patch: LongLivedAgentStateUpdate,
): void {
  const now = Date.now();
  if (patch.working_memory) {
    const trimmed = trimWorkingMemoryThreadNotes(patch.working_memory);
    db.query(
      "UPDATE long_lived_agents SET working_memory_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify({ ...trimmed, updated_at: now }), now, agent_id);
  }
  if (patch.intent_summary !== undefined) {
    db.query(
      "UPDATE long_lived_agents SET last_intent_summary = ?, updated_at = ? WHERE id = ?",
    ).run(patch.intent_summary, now, agent_id);
  }
}

export interface LongLivedPendingActionRow {
  id: string;
  action_kind: string;
  action_target: string;
  payload_json: string;
  rationale: string | null;
  status: string;
  expires_at: number;
  created_at: number;
}

export function listLongLivedPendingActionsForAgent(
  db: Database,
  agent_id: string,
): LongLivedPendingActionRow[] {
  return db
    .query<LongLivedPendingActionRow, [string]>(
      `SELECT id, action_kind, action_target, payload_json, rationale, status, expires_at, created_at
     FROM long_lived_pending_actions
     WHERE agent_id = ? AND status = 'pending'
     ORDER BY created_at DESC`,
    )
    .all(agent_id);
}
