import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedPendingActions } from "@penumbra/mcp/tools/long-lived-pending-actions";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface PendingActionRow {
  id: string;
}

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      buildLongLivedAgentFixture({ name: "a" }),
      buildLongLivedAgentFixture({ name: "b", standing_brief: "y" }),
    ],
    { now: 1 },
  );
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('ta', 'a', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tb', 'b', 'manual', 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa1', 'a', 'ta', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)",
  ).run();
  db.query(
    "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa2', 'b', 'tb', 'ha:x.set', 'f', '{}', 'approved', 9999, 2)",
  ).run();
}

describe("long_lived_pending_actions", () => {
  it("lists pending actions and filters by agent id and status", () => {
    const db = new Database(":memory:");
    seed(db);

    const allPending = handleLongLivedPendingActions(db, { id: null, status: "pending" });
    expect(allPending.pending_actions.map((row) => (row as PendingActionRow).id)).toEqual(["pa1"]);

    const agentPending = handleLongLivedPendingActions(db, { id: "b", status: "approved" });
    expect(agentPending.pending_actions.map((row) => (row as PendingActionRow).id)).toEqual([
      "pa2",
    ]);
  });
});
