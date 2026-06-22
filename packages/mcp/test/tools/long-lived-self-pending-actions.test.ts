import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedSelfPendingActions } from "@penumbra/mcp/tools/long-lived-self-pending-actions";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

describe("long_lived_self_pending_actions", () => {
  it("returns only the running agent's pending actions", () => {
    const db = new Database(":memory:");
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
      "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pa', 'a', 'ta', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)",
    ).run();
    db.query(
      "INSERT INTO long_lived_pending_actions (id, agent_id, tick_id, action_kind, action_target, payload_json, status, expires_at, created_at) VALUES ('pb', 'b', 'tb', 'ha:x.set', 'f', '{}', 'pending', 9999, 1)",
    ).run();

    const result = handleLongLivedSelfPendingActions(
      db,
      { running_agent_id: "a", running_tick_id: "ta" },
      {},
    );
    expect(result.pending_actions.map((p) => p.id)).toEqual(["pa"]);
  });

  it("errors with tick_terminal_status_set when running tick is already terminal", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 384 });
    reconcileLongLivedAgents(db, [buildLongLivedAgentFixture({ name: "a" })], { now: 1 });
    db.query(
      "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at, completed_at, outcome) VALUES ('ta', 'a', 'manual', 1, 2, 'success')",
    ).run();

    expect(() =>
      handleLongLivedSelfPendingActions(db, { running_agent_id: "a", running_tick_id: "ta" }, {}),
    ).toThrow(/tick_terminal_status_set/);
  });
});
