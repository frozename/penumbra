import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedApproveAction } from "@penumbra/mcp/tools/long-lived-approve-action";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface ActionRow {
  status: string;
  decided_by: string;
  decided_at: number;
}

interface AgentRow {
  working_memory_json: string;
}

interface WorkingMemoryDoc {
  pending_goals: {
    kind: string;
    pending_action_id: string;
    original_payload: unknown;
  }[];
}

interface EmittedEvent {
  type: string;
  agent_id: string;
  payload: unknown;
}

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [buildLongLivedAgentFixture({ name: "a" })], { now: 1 });
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('p1', 'a', 't1', 'ha:integration.install', 'mqtt', '{\"domain\":\"mqtt\"}', 'pending', 9999, 1)",
  ).run();
}

describe("long_lived_approve_action", () => {
  it("marks approved, injects approved_action into working memory, and emits an event", () => {
    const db = new Database(":memory:");
    seed(db);
    const events: EmittedEvent[] = [];

    const result = handleLongLivedApproveAction(
      db,
      { emit: (event) => events.push(event), now: () => 50 },
      { action_id: "p1" },
    );

    expect(result.ok).toBe(true);
    const row = db
      .query<
        ActionRow,
        []
      >("SELECT status, decided_by, decided_at FROM long_lived_pending_actions WHERE id='p1'")
      .get();
    expect(row?.status).toBe("approved");
    expect(row?.decided_by).toBe("user");
    expect(row?.decided_at).toBe(50);

    const agentRow = db
      .query<AgentRow, []>("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
      .get();
    const wm = JSON.parse(agentRow?.working_memory_json ?? "{}") as WorkingMemoryDoc;
    expect(wm.pending_goals).toHaveLength(1);
    expect(wm.pending_goals[0]).toMatchObject({
      kind: "approved_action",
      pending_action_id: "p1",
      original_payload: { domain: "mqtt" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "long_lived_action_decided",
      agent_id: "a",
      payload: { action_id: "p1", decision: "approved" },
    });
  });

  it("does not append a duplicate pending_goals entry when approve is called a second time on the same action_id", () => {
    const db = new Database(":memory:");
    seed(db);

    // First call - must succeed
    const r1 = handleLongLivedApproveAction(
      db,
      { emit: () => undefined, now: () => 50 },
      { action_id: "p1" },
    );
    expect(r1.ok).toBe(true);

    // Second call on the same (now 'approved') action_id must throw
    expect(() =>
      handleLongLivedApproveAction(
        db,
        { emit: () => undefined, now: () => 60 },
        { action_id: "p1" },
      ),
    ).toThrow("not_pending");

    // Invariant: exactly one pending_goals entry - no duplicate from the second call
    const agentRow = db
      .query<
        { working_memory_json: string },
        []
      >("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
      .get()!;
    const wm = JSON.parse(agentRow.working_memory_json) as { pending_goals: unknown[] };
    expect(wm.pending_goals).toHaveLength(1);
  });

  it("throws not_pending and does not overwrite an expired row to approved", () => {
    const db = new Database(":memory:");
    seed(db);

    // Simulate the TTL sweep having fired - row is now expired
    db.query("UPDATE long_lived_pending_actions SET status='expired' WHERE id='p1'").run();

    // Approve must reject
    expect(() =>
      handleLongLivedApproveAction(
        db,
        { emit: () => undefined, now: () => 50 },
        { action_id: "p1" },
      ),
    ).toThrow("not_pending");

    // Row must remain expired - not overwritten to approved
    const row = db
      .query<{ status: string }, []>("SELECT status FROM long_lived_pending_actions WHERE id='p1'")
      .get()!;
    expect(row.status).toBe("expired");

    // working_memory must have no pending_goals entries
    const agentRow = db
      .query<
        { working_memory_json: string },
        []
      >("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
      .get()!;
    const wm = JSON.parse(agentRow.working_memory_json) as { pending_goals?: unknown[] };
    expect(wm.pending_goals ?? []).toHaveLength(0);
  });
});
