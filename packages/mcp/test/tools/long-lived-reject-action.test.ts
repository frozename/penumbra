import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedRejectAction } from "@penumbra/mcp/tools/long-lived-reject-action";
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
  pending_goals?: unknown[];
  recent_decisions: {
    pending_action_id: string;
    decision: string;
    reason?: string;
    decided_at: number;
  }[];
}

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(db, [buildLongLivedAgentFixture({ name: "a" })], { now: 1 });
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('t1', 'a', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('p1', 'a', 't1', 'ha:integration.install', 'mqtt', '{}', 'pending', 9999, 1)",
  ).run();
}

describe("long_lived_reject_action", () => {
  it("marks rejected and appends to recent_decisions", () => {
    const db = new Database(":memory:");
    seed(db);

    const result = handleLongLivedRejectAction(
      db,
      {
        emit: (): void => {
          // no-op for test
        },
        now: () => 50,
      },
      { action_id: "p1", reason: "too risky right now" },
    );

    expect(result.ok).toBe(true);
    const row = db
      .query<
        ActionRow,
        []
      >("SELECT status, decided_by, decided_at FROM long_lived_pending_actions WHERE id='p1'")
      .get();
    expect(row?.status).toBe("rejected");
    expect(row?.decided_by).toBe("user");
    expect(row?.decided_at).toBe(50);

    const agentRow = db
      .query<AgentRow, []>("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
      .get();
    const wm = JSON.parse(agentRow?.working_memory_json ?? "{}") as WorkingMemoryDoc;
    expect(wm.pending_goals ?? []).toHaveLength(0);
    expect(wm.recent_decisions).toHaveLength(1);
    expect(wm.recent_decisions[0]).toMatchObject({
      pending_action_id: "p1",
      decision: "rejected",
      reason: "too risky right now",
      decided_at: 50,
    });
  });

  it("does not append a duplicate recent_decisions entry when reject is called a second time on the same action_id", () => {
    const db = new Database(":memory:");
    seed(db);

    // First call - must succeed
    const r1 = handleLongLivedRejectAction(
      db,
      { emit: () => undefined, now: () => 50 },
      { action_id: "p1", reason: "too risky" },
    );
    expect(r1.ok).toBe(true);

    // Second call on the same (now 'rejected') action_id must throw
    expect(() =>
      handleLongLivedRejectAction(
        db,
        { emit: () => undefined, now: () => 60 },
        { action_id: "p1" },
      ),
    ).toThrow("not_pending");

    // Invariant: exactly one recent_decisions entry - no duplicate from the second call
    const agentRow = db
      .query<
        { working_memory_json: string },
        []
      >("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
      .get()!;
    const wm = JSON.parse(agentRow.working_memory_json) as { recent_decisions: unknown[] };
    expect(wm.recent_decisions).toHaveLength(1);
  });

  it("throws not_pending and does not overwrite an expired row to rejected", () => {
    const db = new Database(":memory:");
    seed(db);

    // Simulate the TTL sweep having fired - row is now expired
    db.query("UPDATE long_lived_pending_actions SET status='expired' WHERE id='p1'").run();

    // Reject must refuse
    expect(() =>
      handleLongLivedRejectAction(
        db,
        { emit: () => undefined, now: () => 50 },
        { action_id: "p1" },
      ),
    ).toThrow("not_pending");

    // Row must remain expired - not overwritten to rejected
    const row = db
      .query<{ status: string }, []>("SELECT status FROM long_lived_pending_actions WHERE id='p1'")
      .get()!;
    expect(row.status).toBe("expired");

    // working_memory must have no recent_decisions entries
    const agentRow = db
      .query<
        { working_memory_json: string },
        []
      >("SELECT working_memory_json FROM long_lived_agents WHERE id='a'")
      .get()!;
    const wm = JSON.parse(agentRow.working_memory_json) as { recent_decisions?: unknown[] };
    expect(wm.recent_decisions ?? []).toHaveLength(0);
  });
});
