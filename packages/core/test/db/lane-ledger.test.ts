/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures and sqlite row mocks intentionally use loose shapes */
import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  closeLane,
  getClosedLaneRoundCountForHandoffLineage,
  getLane,
  insertLane,
  recentLanes,
} from "../../src/db/lane-ledger.js";

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
    db.exec(CREATE_HANDOFFS_SQL);
    db.exec(CREATE_AGENT_PERFORMANCE_SQL);
    db.exec(CREATE_LANE_LEDGER_SQL);
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
    const insertPerf = (handoffId: string, gateOutcome: string | null) => {
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
      .query<{ gate_outcome: string | null }, [string]>(
        `SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`,
      )
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
      .query<{ gate_outcome: string | null }, [string]>(
        `SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`,
      )
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
      .query<{ gate_outcome: string | null }, [string]>(
        `SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`,
      )
      .get("handoff-perf-failed");
    expect(failed?.gate_outcome).toBe("failed");
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

    expect(() =>
      closeLane(db, "lane-4", { ts_closed: "2026-05-12T10:30:00.000Z", gate_status: "passed" }),
    ).toThrow();
  });

  it("rejects invalid close statuses", () => {
    insertLane(db, {
      lane_id: "lane-5",
      ts_opened: "2026-05-12T10:30:00.000Z",
      task_class: "STANDARD",
      implementer_handoff: "handoff-5",
      gate_status: "open",
    });

    expect(() =>
      closeLane(db, "lane-5", {
        ts_closed: "2026-05-12T10:35:00.000Z",
        gate_status: "open" as any,
      }),
    ).toThrow();
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
    db.query = ((sql: string) => {
      capturedSql = sql;
      return originalQuery(sql);
    }) as typeof db.query;

    expect(getClosedLaneRoundCountForHandoffLineage(db, "unknown-handoff")).toBe(0);

    expect(capturedSql).toContain(" IN ");
    expect(capturedSql).toContain("UNION");
    expect(capturedSql).not.toMatch(/\bOR\s+EXISTS\b/i);
  });
});
