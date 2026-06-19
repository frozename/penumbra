import type { Database } from "bun:sqlite";
import { WorkingMemorySchema, type WorkingMemory } from "./types.js";
import { trimWorkingMemoryThreadNotes } from "./thread-notes-trim.js";

type Goal = WorkingMemory["pending_goals"][number];

interface WorkingMemoryRow {
  working_memory_json: string;
}

interface TickStartRow {
  started_at: number;
}

interface UpdateContext {
  running_tick_id?: string;
}

function parseWorkingMemory(value: string): WorkingMemory | null {
  try {
    return WorkingMemorySchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function goalAppendedAfterTick(goal: Goal, tickStartedAt: number): boolean {
  if (goal === null || typeof goal !== "object") return false;
  const createdAt = (goal as { created_at?: unknown }).created_at;
  return typeof createdAt === "number" && createdAt > tickStartedAt;
}

function mergePendingGoals(base: Goal[], preserve: Goal[]): Goal[] {
  const seen = new Set<string>();
  const next: Goal[] = [];

  for (const goal of base) {
    const key = JSON.stringify(goal);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(goal);
  }

  for (const goal of preserve) {
    const key = JSON.stringify(goal);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(goal);
  }

  return next;
}

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
  context: UpdateContext = {},
): void {
  const now = Date.now();
  if (patch.working_memory) {
    const workingMemoryFromAgent = trimWorkingMemoryThreadNotes(patch.working_memory);
    let nextWorkingMemory = workingMemoryFromAgent;

    if (context.running_tick_id) {
      const tick = db
        .query<
          TickStartRow,
          [string]
        >("SELECT started_at FROM long_lived_ticks WHERE id = ? LIMIT 1")
        .get(context.running_tick_id);
      if (tick) {
        const current = db
          .query<
            WorkingMemoryRow,
            [string]
          >("SELECT working_memory_json FROM long_lived_agents WHERE id = ?")
          .get(agent_id);
        if (current) {
          const currentWorkingMemory = parseWorkingMemory(current.working_memory_json);
          const existingGoals =
            currentWorkingMemory?.pending_goals?.filter((goal) =>
              goalAppendedAfterTick(goal, tick.started_at),
            ) ?? [];
          nextWorkingMemory = {
            ...workingMemoryFromAgent,
            pending_goals: mergePendingGoals(workingMemoryFromAgent.pending_goals, existingGoals),
          };
        }
      }
    }

    const persisted = trimWorkingMemoryThreadNotes({ ...nextWorkingMemory, updated_at: now });
    db.query(
      "UPDATE long_lived_agents SET working_memory_json = ?, updated_at = ? WHERE id = ?",
    ).run(JSON.stringify(persisted), now, agent_id);
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
