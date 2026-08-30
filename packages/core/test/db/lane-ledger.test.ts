import {
  type ClosedLaneGateStatus,
  closeLane,
  getClosedLaneRoundCountForHandoffLineage,
  getLane,
  insertLane,
  recentLanes,
  stampAgentPerformanceGateOutcomeForHandoff,
} from "@src/db/lane-ledger.js";
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

const CREATE_LANE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS lane_ledger (
    lane_id              TEXT PRIMARY KEY,
    ts_opened            TEXT NOT NULL,
    ts_closed            TEXT,
    task_class           TEXT NOT NULL,
    implementer_handoff  TEXT NOT NULL,
    reviewer_handoff     TEXT,
    gate_status          TEXT NOT NULL,
    recalled_memory_ids  TEXT NOT NULL DEFAULT '[]',
    recalled_query       TEXT,
    override_reason      TEXT,
    metadata_json        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS lane_ledger_by_status_ts ON lane_ledger(gate_status, ts_opened DESC);
  CREATE INDEX IF NOT EXISTS lane_ledger_by_task_class ON lane_ledger(task_class, ts_opened DESC);
`;

const CREATE_HANDOFFS_SQL = `
  CREATE TABLE IF NOT EXISTS handoffs (
    handoff_id TEXT PRIMARY KEY,
    to_agent TEXT NOT NULL,
    parent_handoff_id TEXT,
    root_handoff_id TEXT
  );
`;

const CREATE_AGENT_PERFORMANCE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_performance (
    performance_id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    handoff_id TEXT NOT NULL,
    conversation_id TEXT,
    project_id TEXT,
    agent_name TEXT NOT NULL,
    task_type TEXT NOT NULL,
    outcome TEXT,
    gate_outcome TEXT,
    rounds INTEGER,
    smoke_pass TEXT,
    reviewer_findings INTEGER,
    maestro_score REAL,
    cost_usd REAL,
    tokens_used INTEGER,
    latency_ms INTEGER,
    source TEXT,
    notes TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );
`;

describe("lane-ledger dao", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(CREATE_HANDOFFS_SQL);
    db.run(CREATE_AGENT_PERFORMANCE_SQL);
    db.run(CREATE_LANE_LEDGER_SQL);
  });

  it("round-trips an inserted lane", () => {
    insertLane(db, {
      lane_id: "lane-1",
      ts_opened: "2026-05-12T10:00:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "handoff-1",
      gate_status: "open",
      recalled_memory_ids: ["m1", "m2"],
      recalled_query: "quality push",
      metadata_json: '{"source":"test"}',
    });

    expect(getLane(db, "lane-1")).toEqual({
      lane_id: "lane-1",
      ts_opened: "2026-05-12T10:00:00.000Z",
      ts_closed: null,
      task_class: "BOUNDARY",
      implementer_handoff: "handoff-1",
      reviewer_handoff: null,
      gate_status: "open",
      recalled_memory_ids: ["m1", "m2"],
      recalled_query: "quality push",
      override_reason: null,
      metadata_json: '{"source":"test"}',
    });
  });

  it("applies defaults when optional fields are omitted", () => {
    insertLane(db, {
      lane_id: "lane-2",
      ts_opened: "2026-05-12T10:05:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-2",
      gate_status: "open",
    });

    expect(getLane(db, "lane-2")).toEqual({
      lane_id: "lane-2",
      ts_opened: "2026-05-12T10:05:00.000Z",
      ts_closed: null,
      task_class: "STANDARD",
      implementer_handoff: "handoff-2",
      reviewer_handoff: null,
      gate_status: "open",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: null,
      metadata_json: "{}",
    });
  });

  it("closes a lane and persists the final gate status", () => {
    insertLane(db, {
      lane_id: "lane-3",
      ts_opened: "2026-05-12T10:10:00.000Z",
      task_class: "TRIVIAL",
      implementer_handoff: "handoff-3",
      gate_status: "open",
    });

    closeLane(db, "lane-3", {
      ts_closed: "2026-05-12T10:15:00.000Z",
      gate_status: "passed",
      reviewer_handoff: "reviewer-1",
      override_reason: "approved by reviewer",
    });

    expect(getLane(db, "lane-3")).toEqual({
      lane_id: "lane-3",
      ts_opened: "2026-05-12T10:10:00.000Z",
      ts_closed: "2026-05-12T10:15:00.000Z",
      task_class: "TRIVIAL",
      implementer_handoff: "handoff-3",
      reviewer_handoff: "reviewer-1",
      gate_status: "passed",
      recalled_memory_ids: [],
      recalled_query: null,
      override_reason: "approved by reviewer",
      metadata_json: "{}",
    });
  });

  it("stamps agent_performance gate_outcome on close and preserves stronger verdicts", () => {
    const insertPerf = (handoffId: string, gateOutcome: string | null): void => {
      db.run(
        `INSERT INTO agent_performance (
           performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
           outcome, gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd,
           tokens_used, latency_ms, source, notes, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${handoffId}-perf`,
          "2026-05-12T10:13:00.000Z",
          handoffId,
          "conv",
          "proj",
          "agent",
          "implement_small",
          "merged",
          gateOutcome,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          "worker",
          null,
          "{}",
        ],
      );
    };

    insertLane(db, {
      lane_id: "lane-perf-skipped",
      ts_opened: "2026-05-12T10:12:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-perf-skipped",
      gate_status: "open",
    });
    insertPerf("handoff-perf-skipped", null);
    closeLane(db, "lane-perf-skipped", {
      ts_closed: "2026-05-12T10:15:00.000Z",
      gate_status: "skipped",
    });
    const skipped = db
      .query<
        { gate_outcome: string | null },
        [string]
      >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("handoff-perf-skipped");
    expect(skipped?.gate_outcome).toBe("skipped");

    insertLane(db, {
      lane_id: "lane-perf-passed",
      ts_opened: "2026-05-12T10:16:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-perf-passed",
      gate_status: "open",
    });
    insertPerf("handoff-perf-passed", "passed");
    closeLane(db, "lane-perf-passed", {
      ts_closed: "2026-05-12T10:20:00.000Z",
      gate_status: "skipped",
    });
    const passed = db
      .query<
        { gate_outcome: string | null },
        [string]
      >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("handoff-perf-passed");
    expect(passed?.gate_outcome).toBe("passed");

    insertLane(db, {
      lane_id: "lane-perf-failed",
      ts_opened: "2026-05-12T10:21:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-perf-failed",
      gate_status: "open",
    });
    insertPerf("handoff-perf-failed", "failed");
    closeLane(db, "lane-perf-failed", {
      ts_closed: "2026-05-12T10:25:00.000Z",
      gate_status: "skipped",
    });
    const failed = db
      .query<
        { gate_outcome: string | null },
        [string]
      >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("handoff-perf-failed");
    expect(failed?.gate_outcome).toBe("failed");
  });

  it("lets a terminal lane close override a prior optimistic passed gate_outcome", () => {
    insertLane(db, {
      lane_id: "lane-perf-review-debt",
      ts_opened: "2026-05-12T10:26:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "handoff-perf-review-debt",
      gate_status: "open",
    });
    db.run(
      `INSERT INTO agent_performance (
         performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
         outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd,
         tokens_used, latency_ms, source, notes, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "perf-handoff-perf-review-debt",
        "2026-05-12T10:26:01.000Z",
        "handoff-perf-review-debt",
        "conv",
        "proj",
        "agent",
        "implement_small",
        "merged",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "worker",
        null,
        "{}",
      ],
    );
    stampAgentPerformanceGateOutcomeForHandoff(db, "handoff-perf-review-debt", "passed");

    closeLane(db, "lane-perf-review-debt", {
      ts_closed: "2026-05-12T10:27:00.000Z",
      gate_status: "review_debt",
    });

    const row = db
      .query<
        { gate_outcome: string | null },
        [string]
      >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("handoff-perf-review-debt");
    expect(row?.gate_outcome).toBe("review_debt");
  });

  it("warns and preserves passed when a close is suppressed by monotonicity", () => {
    insertLane(db, {
      lane_id: "lane-perf-suppressed",
      ts_opened: "2026-05-12T10:28:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-perf-suppressed",
      gate_status: "open",
    });
    db.run(
      `INSERT INTO agent_performance (
         performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
         outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd,
         tokens_used, latency_ms, source, notes, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "perf-handoff-perf-suppressed",
        "2026-05-12T10:28:01.000Z",
        "handoff-perf-suppressed",
        "conv",
        "proj",
        "agent",
        "implement_small",
        "merged",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "worker",
        null,
        "{}",
      ],
    );
    stampAgentPerformanceGateOutcomeForHandoff(db, "handoff-perf-suppressed", "passed");

    const warns: { obj: Record<string, unknown>; msg: string }[] = [];
    closeLane(
      db,
      "lane-perf-suppressed",
      {
        ts_closed: "2026-05-12T10:29:00.000Z",
        gate_status: "skipped",
      },
      {
        warn: (obj, msg) => warns.push({ obj, msg }),
      },
    );

    const row = db
      .query<
        { gate_outcome: string | null },
        [string]
      >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
      .get("handoff-perf-suppressed");
    expect(row?.gate_outcome).toBe("passed");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toEqual({
      event: "gate_stamp.suppressed_downgrade",
      handoff_id: "handoff-perf-suppressed",
      lane_id: "lane-perf-suppressed",
      gate_status: "skipped",
    });
  });

  it("warns with lane_id context when close stamps against a missing agent_performance row", () => {
    insertLane(db, {
      lane_id: "lane-missing-perf",
      ts_opened: "2026-05-12T10:31:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-missing-perf",
      gate_status: "open",
    });

    const warns: { obj: Record<string, unknown>; msg: string }[] = [];
    closeLane(
      db,
      "lane-missing-perf",
      {
        ts_closed: "2026-05-12T10:32:00.000Z",
        gate_status: "failed",
      },
      {
        warn: (obj, msg) => warns.push({ obj, msg }),
      },
    );

    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toEqual({
      event: "gate_stamp.no_perf_row",
      handoff_id: "handoff-missing-perf",
      lane_id: "lane-missing-perf",
      gate_status: "failed",
    });
    expect(warns[0]!.msg).toContain("zero agent_performance rows");
  });

  it("throws on double-close", () => {
    insertLane(db, {
      lane_id: "lane-4",
      ts_opened: "2026-05-12T10:20:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "handoff-4",
      gate_status: "open",
    });
    closeLane(db, "lane-4", { ts_closed: "2026-05-12T10:25:00.000Z", gate_status: "failed" });

    expect(() => {
      closeLane(db, "lane-4", { ts_closed: "2026-05-12T10:30:00.000Z", gate_status: "passed" });
    }).toThrow();
  });

  it("rejects invalid close statuses", () => {
    insertLane(db, {
      lane_id: "lane-5",
      ts_opened: "2026-05-12T10:30:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-5",
      gate_status: "open",
    });

    expect(() => {
      closeLane(db, "lane-5", {
        ts_closed: "2026-05-12T10:35:00.000Z",
        // Deliberately bypassing the type to verify the runtime guard rejects "open".
        gate_status: "open" as unknown as ClosedLaneGateStatus,
      });
    }).toThrow();
  });

  it("filters and orders recent lanes by status, task class, and since", () => {
    insertLane(db, {
      lane_id: "lane-a",
      ts_opened: "2026-05-12T10:00:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "handoff-a",
      gate_status: "open",
    });
    insertLane(db, {
      lane_id: "lane-b",
      ts_opened: "2026-05-12T10:05:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-b",
      gate_status: "passed",
    });
    insertLane(db, {
      lane_id: "lane-c",
      ts_opened: "2026-05-12T10:10:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-c",
      gate_status: "passed",
    });

    expect(recentLanes(db, { gate_status: "passed" }, 50).map((row) => row.lane_id)).toEqual([
      "lane-c",
      "lane-b",
    ]);
    expect(recentLanes(db, { task_class: "STANDARD" }, 50).map((row) => row.lane_id)).toEqual([
      "lane-c",
      "lane-b",
    ]);
    expect(
      recentLanes(db, { since_iso: "2026-05-12T10:06:00.000Z" }, 50).map((row) => row.lane_id),
    ).toEqual(["lane-c"]);
  });

  it("returns null for unknown lanes", () => {
    expect(getLane(db, "missing")).toBeNull();
  });

  it("rejects invalid stored gate_status values", () => {
    db.run(
      `INSERT INTO lane_ledger (
        lane_id, ts_opened, task_class, implementer_handoff, gate_status
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        "lane-bad",
        "2026-05-12T10:30:00.000Z",
        "STANDARD",
        "handoff-bad",
        "definitely-not-a-status",
      ],
    );
    expect(() => {
      getLane(db, "lane-bad");
    }).toThrow();
  });

  it("preserves recalled_memory_ids as json", () => {
    insertLane(db, {
      lane_id: "lane-json",
      ts_opened: "2026-05-12T10:40:00.000Z",
      task_class: "TRIVIAL",
      implementer_handoff: "handoff-json",
      gate_status: "open",
      recalled_memory_ids: ["mem-1", "mem-2", "mem-3"],
    });

    const raw = db
      .query<
        { recalled_memory_ids: string },
        [string]
      >("SELECT recalled_memory_ids FROM lane_ledger WHERE lane_id=?")
      .get("lane-json");
    expect(raw?.recalled_memory_ids).toBe('["mem-1","mem-2","mem-3"]');
    expect(getLane(db, "lane-json")?.recalled_memory_ids).toEqual(["mem-1", "mem-2", "mem-3"]);
  });

  it("closeLane with metadata writes serialized JSON to the row", () => {
    insertLane(db, {
      lane_id: "lane-meta1",
      ts_opened: "2026-05-14T00:00:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "h-meta1",
      gate_status: "open",
    });

    closeLane(db, "lane-meta1", {
      ts_closed: "2026-05-14T00:05:00.000Z",
      gate_status: "passed",
      metadata: { high_findings: 1, round_count: 2 },
    });

    const raw = db
      .query<
        { metadata_json: string },
        [string]
      >("SELECT metadata_json FROM lane_ledger WHERE lane_id=?")
      .get("lane-meta1");
    expect(JSON.parse(raw!.metadata_json)).toEqual({ high_findings: 1, round_count: 2 });
  });

  it("closeLane without metadata preserves prior value", () => {
    insertLane(db, {
      lane_id: "lane-meta2",
      ts_opened: "2026-05-14T00:10:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "h-meta2",
      gate_status: "open",
      metadata_json: '{"prior":true}',
    });

    closeLane(db, "lane-meta2", {
      ts_closed: "2026-05-14T00:15:00.000Z",
      gate_status: "passed",
    });

    expect(getLane(db, "lane-meta2")?.metadata_json).toBe('{"prior":true}');
  });

  it("closeLane with metadata={} overwrites prior value to {}", () => {
    insertLane(db, {
      lane_id: "lane-meta3",
      ts_opened: "2026-05-14T00:20:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "h-meta3",
      gate_status: "open",
      metadata_json: '{"prior":true}',
    });

    closeLane(db, "lane-meta3", {
      ts_closed: "2026-05-14T00:25:00.000Z",
      gate_status: "passed",
      metadata: {},
    });

    expect(getLane(db, "lane-meta3")?.metadata_json).toBe("{}");
  });

  it("counts only closed lanes whose implementer handoffs share the same root", () => {
    db.run(
      "INSERT INTO handoffs (handoff_id, to_agent, parent_handoff_id, root_handoff_id) VALUES (?, ?, ?, ?)",
      ["root", "codex", null, "root"],
    );
    db.run(
      "INSERT INTO handoffs (handoff_id, to_agent, parent_handoff_id, root_handoff_id) VALUES (?, ?, ?, ?)",
      ["child-1", "codex", "root", "root"],
    );
    db.run(
      "INSERT INTO handoffs (handoff_id, to_agent, parent_handoff_id, root_handoff_id) VALUES (?, ?, ?, ?)",
      ["child-2", "codex", "child-1", "root"],
    );
    db.run(
      "INSERT INTO handoffs (handoff_id, to_agent, parent_handoff_id, root_handoff_id) VALUES (?, ?, ?, ?)",
      ["other-root", "codex", null, "other-root"],
    );

    insertLane(db, {
      lane_id: "lane-root",
      ts_opened: "2026-05-14T01:00:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "root",
    });
    closeLane(db, "lane-root", {
      ts_closed: "2026-05-14T01:05:00.000Z",
      gate_status: "failed",
    });
    insertLane(db, {
      lane_id: "lane-child-1",
      ts_opened: "2026-05-14T01:10:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "child-1",
    });
    closeLane(db, "lane-child-1", {
      ts_closed: "2026-05-14T01:15:00.000Z",
      gate_status: "failed",
    });
    insertLane(db, {
      lane_id: "lane-child-2-open",
      ts_opened: "2026-05-14T01:20:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "child-2",
    });
    insertLane(db, {
      lane_id: "lane-other",
      ts_opened: "2026-05-14T01:30:00.000Z",
      task_class: "BOUNDARY",
      implementer_handoff: "other-root",
    });
    closeLane(db, "lane-other", {
      ts_closed: "2026-05-14T01:35:00.000Z",
      gate_status: "failed",
    });

    expect(getClosedLaneRoundCountForHandoffLineage(db, "child-2")).toBe(2);
  });

  it("counts lineage rounds with an IN union query instead of correlated OR exists", () => {
    let capturedSql = "";
    const originalQuery = db.query.bind(db);
    // bun:sqlite's Database.query is overloaded; replacing it for a spy needs a
    // typed wrapper so the assignment doesn't widen to `any`.
    const captureQuery = ((sql: string) => {
      capturedSql = sql;
      return originalQuery(sql);
    }) as typeof db.query;
    db.query = captureQuery;

    expect(getClosedLaneRoundCountForHandoffLineage(db, "unknown-handoff")).toBe(0);

    expect(capturedSql).toContain(" IN ");
    expect(capturedSql).toContain("UNION");
    expect(capturedSql).not.toMatch(/\bOR\s+EXISTS\b/i);
  });
});
