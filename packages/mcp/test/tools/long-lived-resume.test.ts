import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { handleLongLivedResume } from "@penumbra/mcp/tools/long-lived-resume";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { buildLongLivedAgentFixture } from "../helpers.js";

interface AgentStateRow {
  status: string;
  consecutive_failures: number;
  degraded_reason: string | null;
  retired_at?: number | null;
}

function seed(db: Database): void {
  loadSqliteVec(db);
  applySchema(db, { embeddingDim: 384 });
  reconcileLongLivedAgents(
    db,
    [
      buildLongLivedAgentFixture({
        name: "a",
        display_name: "A",
        schedule_cron: "*/15 * * * *",
      }),
    ],
    { now: 1 },
  );
}

describe("long_lived_resume", () => {
  it("resumes paused agents and clears degraded metadata", () => {
    const db = new Database(":memory:");
    seed(db);
    db.query(
      "UPDATE long_lived_agents SET status='paused', consecutive_failures=7, degraded_reason='oops' WHERE id='a'",
    ).run();

    const result = handleLongLivedResume(db, { id: "a" });
    const row = db
      .query<
        AgentStateRow,
        []
      >("SELECT status, consecutive_failures, degraded_reason FROM long_lived_agents WHERE id='a'")
      .get();

    expect(result).toEqual({ id: "a", status: "active" });
    expect(row).toEqual({ status: "active", consecutive_failures: 0, degraded_reason: null });
  });

  it("resumes retired agents and clears retired state", () => {
    const db = new Database(":memory:");
    seed(db);
    db.query(
      "UPDATE long_lived_agents SET status='retired', consecutive_failures=7, degraded_reason='oops', retired_at=123 WHERE id='a'",
    ).run();

    const result = handleLongLivedResume(db, { id: "a" });
    const row = db
      .query<
        AgentStateRow,
        []
      >("SELECT status, consecutive_failures, degraded_reason, retired_at FROM long_lived_agents WHERE id='a'")
      .get();

    expect(result).toEqual({ id: "a", status: "active" });
    expect(row).toEqual({
      status: "active",
      consecutive_failures: 0,
      degraded_reason: null,
      retired_at: null,
    });
  });

  it("rejects invalid transitions", () => {
    const db = new Database(":memory:");
    seed(db);

    expect(() => handleLongLivedResume(db, { id: "a" })).toThrow(
      /invalid_long_lived_status_transition/,
    );
  });
});
