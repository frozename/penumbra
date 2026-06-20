import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { type Services, migrate, loadSqliteVec, insertLane, getLane } from "@penumbra/core";
import { runOrphanLanesSweep } from "../../src/sweepers/orphan-lanes.js";

try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {}

const NOW = "2026-01-01T12:00:00.000Z";
const PAST_GRACE = "2026-01-01T11:00:00.000Z"; // 60 min ago — past the 30-min default grace
const WITHIN_GRACE = "2026-01-01T11:55:00.000Z"; // 5 min ago — inside grace window

function setupDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database, t0Sink: unknown[] = []): Services {
  return {
    db,
    machineId: { get: () => "machine-test" },
    uuid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
    clock: () => new Date(NOW),
    t0Writer: { write: (e: unknown) => t0Sink.push(e) },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Services;
}

function insertHandoff(
  db: Database,
  handoff_id: string,
  status: string,
  resolved_at: string | null,
): void {
  db.run(
    `INSERT INTO handoffs (handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       to_role, message, status, resolved_at)
     VALUES (?, '2026-01-01T09:00:00.000Z', NULL, 'c-test', 'maestro', 'worker', NULL, 'work', ?, ?)`,
    [handoff_id, status, resolved_at],
  );
}

function openLane(
  db: Database,
  lane_id: string,
  implementer_handoff: string,
  task_class = "STANDARD",
): void {
  insertLane(db, {
    lane_id,
    ts_opened: "2026-01-01T09:00:00.000Z",
    task_class,
    implementer_handoff,
  });
}

function setReviewerHandoff(db: Database, lane_id: string, reviewer_handoff: string): void {
  db.run(`UPDATE lane_ledger SET reviewer_handoff=? WHERE lane_id=?`, [reviewer_handoff, lane_id]);
}

function insertMemory(db: Database, memoryId: string): void {
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, compressed_from, created_at, updated_at)
     VALUES (?, NULL, 'u1', 'fact', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    [
      memoryId,
      "2026-01-01T10:00:00.000Z",
      "2026-01-01T11:00:00.000Z",
      memoryId,
      `${memoryId} body`,
      "2026-01-01T11:00:00.000Z",
      "2026-01-01T11:00:00.000Z",
    ],
  );
}

function insertDispatchMemory(db: Database, handoffId: string, memoryId: string): void {
  db.run(
    `INSERT INTO dispatch_events(handoff_id, worker_id, source, kind, ts, meta_json)
     VALUES (?, NULL, 'worker', 'memory_recall_injected', '2026-01-01T11:30:00.000Z', ?)`,
    [handoffId, JSON.stringify({ memory_id: memoryId })],
  );
}

function insertPerformance(db: Database, handoffId: string, gateOutcome: string | null): void {
  db.run(
    `INSERT INTO agent_performance (
       performance_id, ts, handoff_id, conversation_id, project_id, agent_name, task_type,
       outcome, gate_outcome, rounds, smoke_pass, reviewer_findings, maestro_score, cost_usd,
       tokens_used, latency_ms, source, notes, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `perf-${handoffId}`,
      "2026-01-01T10:00:00.000Z",
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
}

test("closes orphan lane whose implementer handoff completed past grace window", () => {
  const db = setupDb();
  const t0Sink: unknown[] = [];
  const services = makeServices(db, t0Sink);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");
  insertPerformance(db, "h-impl", null);

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.lane_ids).toEqual(["lane-1"]);

  const lane = getLane(db, "lane-1");
  // Non-trivial orphan lanes must not receive success-eligible skipped credit.
  expect(lane?.gate_status).toBe("review_debt");
  expect(lane?.override_reason).toContain("orphan-lane sweeper");
  expect(lane?.override_reason).toContain("completed");
  const metadata = JSON.parse(lane?.metadata_json ?? "{}") as { notes?: string };
  expect(metadata.notes).toContain("orphan-lane sweep");
  expect(metadata.notes).toContain("h-impl");

  const perf = db
    .query<
      { gate_outcome: string | null },
      [string]
    >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
    .get("h-impl");
  expect(perf?.gate_outcome).toBe("review_debt");
});

test("closes trivial orphan lane as skipped", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  openLane(db, "lane-1", "h-impl", "TRIVIAL");
  insertPerformance(db, "h-impl", null);

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.lane_ids).toEqual(["lane-1"]);
  expect(getLane(db, "lane-1")?.gate_status).toBe("skipped");

  const perf = db
    .query<
      { gate_outcome: string | null },
      [string]
    >(`SELECT gate_outcome FROM agent_performance WHERE handoff_id = ?`)
    .get("h-impl");
  expect(perf?.gate_outcome).toBe("skipped");
});

test("skips lane within grace window", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", WITHIN_GRACE);
  openLane(db, "lane-1", "h-impl");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(0);
  expect(result.closed).toBe(0);
  expect(getLane(db, "lane-1")?.gate_status).toBe("open");
});

test("skips lane with non-terminal implementer handoff", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "dispatched", null);
  openLane(db, "lane-1", "h-impl");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(0);
  expect(result.closed).toBe(0);
  expect(getLane(db, "lane-1")?.gate_status).toBe("open");
});

test("skips lane with in-flight reviewer handoff", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  insertHandoff(db, "h-reviewer", "dispatched", null);
  openLane(db, "lane-1", "h-impl");
  setReviewerHandoff(db, "lane-1", "h-reviewer");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(1);
  expect(result.closed).toBe(0);
  expect(getLane(db, "lane-1")?.gate_status).toBe("open");
});

test("closes lane whose reviewer handoff is terminal", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  insertHandoff(db, "h-reviewer", "completed", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");
  setReviewerHandoff(db, "lane-1", "h-reviewer");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.closed).toBe(1);
  expect(getLane(db, "lane-1")?.gate_status).toBe("review_debt");
  expect(getLane(db, "lane-1")?.reviewer_handoff).toBe("h-reviewer");
});

test("already-closed lane is untouched", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");
  // Pre-close the lane
  db.run(`UPDATE lane_ledger SET gate_status='passed', ts_closed=? WHERE lane_id='lane-1'`, [
    PAST_GRACE,
  ]);

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(0);
  expect(result.closed).toBe(0);
  expect(getLane(db, "lane-1")?.gate_status).toBe("passed");
});

test("idempotent: second sweep closes 0 lanes", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");

  const first = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });
  const second = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(first.closed).toBe(1);
  expect(second.closed).toBe(0);
  expect(second.scanned).toBe(0);
});

test("closes orphan lane whose implementer handoff was rejected past grace window", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "rejected", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.lane_ids).toEqual(["lane-1"]);
  expect(getLane(db, "lane-1")?.gate_status).toBe("review_debt");
});

test("closes orphan lane whose implementer handoff was expired past grace window", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "expired", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(1);
  expect(result.closed).toBe(1);
  expect(result.lane_ids).toEqual(["lane-1"]);
  expect(getLane(db, "lane-1")?.gate_status).toBe("review_debt");
});

test("closes lane with rejected reviewer handoff + terminal-past-grace implementer", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  insertHandoff(db, "h-reviewer", "rejected", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");
  setReviewerHandoff(db, "lane-1", "h-reviewer");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.scanned).toBe(1);
  expect(result.closed).toBe(1);
  expect(getLane(db, "lane-1")?.gate_status).toBe("review_debt");
});

test("emits one audit t0 event per sweep cycle covering all closed lane_ids", () => {
  const db = setupDb();
  const t0Sink: unknown[] = [];
  const services = makeServices(db, t0Sink);

  insertHandoff(db, "h-a", "completed", PAST_GRACE);
  insertHandoff(db, "h-b", "failed", PAST_GRACE);
  openLane(db, "lane-a", "h-a");
  openLane(db, "lane-b", "h-b");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });

  expect(result.closed).toBe(2);
  expect(t0Sink).toHaveLength(1);

  const event = t0Sink[0] as {
    event_type: string;
    payload_json: { lane_ids: string[]; scanned: number };
  };
  expect(event.event_type).toBe("lane.orphan-swept");
  expect(event.payload_json.lane_ids).toHaveLength(2);
  expect(event.payload_json.lane_ids).toContain("lane-a");
  expect(event.payload_json.lane_ids).toContain("lane-b");
  expect(event.payload_json.scanned).toBe(2);
});

test("orphan-lane sweeper close explicitly skips memory verify authorization", () => {
  const db = setupDb();
  const services = makeServices(db);

  insertHandoff(db, "h-impl", "completed", PAST_GRACE);
  insertHandoff(db, "h-reviewer", "completed", PAST_GRACE);
  openLane(db, "lane-1", "h-impl");
  setReviewerHandoff(db, "lane-1", "h-reviewer");
  insertMemory(db, "m-sweeper-skip");
  insertDispatchMemory(db, "h-impl", "m-sweeper-skip");

  const result = runOrphanLanesSweep(services, { nowIso: NOW, graceMs: 30 * 60_000 });
  expect(result.closed).toBe(1);

  const count = db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memory_verification_events`)
    .get();
  expect(count?.c).toBe(0);
});
