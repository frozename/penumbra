import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { stampAgentPerformanceGateOutcomeForHandoff } from "../../src/db/lane-ledger.js";

const CREATE_AGENT_PERFORMANCE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_performance (
    performance_id       TEXT PRIMARY KEY,
    ts                   TEXT NOT NULL,
    handoff_id           TEXT NOT NULL UNIQUE,
    conversation_id      TEXT,
    project_id           TEXT,
    agent_name           TEXT NOT NULL,
    task_type            TEXT NOT NULL,
    outcome              TEXT NOT NULL,
    gate_outcome         TEXT,
    rounds               INTEGER,
    latency_ms           INTEGER NOT NULL DEFAULT 0,
    cost_cents           INTEGER NOT NULL DEFAULT 0,
    tokens_in            INTEGER,
    tokens_out           INTEGER
  );
`;

describe("stampAgentPerformanceGateOutcomeForHandoff", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(CREATE_AGENT_PERFORMANCE_SQL);
  });

  function seedPerformance(handoffId: string, gateOutcome: string | null): void {
    db.prepare(
      `INSERT INTO agent_performance (
        performance_id, ts, handoff_id, agent_name, task_type, outcome, gate_outcome
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `perf_${handoffId}`,
      new Date().toISOString(),
      handoffId,
      "test-agent",
      "test-task",
      "success",
      gateOutcome,
    );
  }

  function getGateOutcome(handoffId: string): string | null {
    const row = db
      .prepare(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get(handoffId) as { gate_outcome: string | null };
    return row.gate_outcome;
  }

  it("does not upgrade review_debt to passed", () => {
    seedPerformance("h1", "review_debt");
    stampAgentPerformanceGateOutcomeForHandoff(db, "h1", "passed");
    expect(getGateOutcome("h1")).toBe("review_debt");
  });

  it("does not upgrade failed to passed", () => {
    seedPerformance("h2", "failed");
    stampAgentPerformanceGateOutcomeForHandoff(db, "h2", "passed");
    expect(getGateOutcome("h2")).toBe("failed");
  });

  it("sets passed when initially NULL", () => {
    seedPerformance("h3", null);
    stampAgentPerformanceGateOutcomeForHandoff(db, "h3", "passed");
    expect(getGateOutcome("h3")).toBe("passed");
  });

  it("does not downgrade passed to skipped", () => {
    seedPerformance("h4", "passed");
    stampAgentPerformanceGateOutcomeForHandoff(db, "h4", "skipped");
    expect(getGateOutcome("h4")).toBe("passed");
  });

  it("emits a structured warn when the UPDATE matches zero rows", () => {
    const warns: { obj: Record<string, unknown>; msg: string }[] = [];
    const result = stampAgentPerformanceGateOutcomeForHandoff(db, "missing-handoff", "passed", {
      warn: (obj, msg) => warns.push({ obj, msg }),
    });
    expect(result).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toEqual({
      event: "gate_stamp.no_perf_row",
      handoff_id: "missing-handoff",
      gate_status: "passed",
    });
    expect(warns[0]!.msg).toContain("zero agent_performance rows");
  });

  it("does not warn when the UPDATE matches an existing row", () => {
    seedPerformance("h-warn-ok", null);
    const warns: { obj: Record<string, unknown>; msg: string }[] = [];
    stampAgentPerformanceGateOutcomeForHandoff(db, "h-warn-ok", "passed", {
      warn: (obj, msg) => warns.push({ obj, msg }),
    });
    expect(warns).toHaveLength(0);
    expect(getGateOutcome("h-warn-ok")).toBe("passed");
  });
});
