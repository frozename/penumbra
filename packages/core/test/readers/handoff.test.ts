import { expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}
import { migrate } from "../../src/db/migrations.js";
import { HandoffWriter } from "../../src/writers/handoff.js";
import { HandoffReader } from "../../src/readers/handoff.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js"; // Ensure to load vector extension if required by tests!

let db: Database;
let reader: HandoffReader;
let writer: HandoffWriter;

const baseTs = Date.parse("2026-05-05T00:00:00.000Z");

function isoAt(offsetMs: number): string {
  return new Date(baseTs + offsetMs).toISOString();
}

function insertHandoffRow(opts: {
  handoff_id: string;
  ts: string;
  conversation_id: string;
  root_handoff_id: string | null;
  project_id?: string | null;
  parent_handoff_id?: string | null;
  status?: "pending" | "approved" | "redirected" | "dispatched";
}): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
       message, status, triggered_by_event_id, use_worktree, parent_handoff_id, root_handoff_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.handoff_id,
      opts.ts,
      opts.project_id ?? null,
      opts.conversation_id,
      "claude",
      "gemini",
      null,
      `m-${opts.handoff_id}`,
      opts.status ?? "approved",
      `e-${opts.handoff_id}`,
      null,
      opts.parent_handoff_id ?? null,
      opts.root_handoff_id,
    ],
  );
}

function markDispatched(handoff_id: string): void {
  db.run(`UPDATE handoffs SET status='dispatched' WHERE handoff_id=?`, [handoff_id]);
}

function seedChainA(): void {
  insertHandoffRow({
    handoff_id: "A.1",
    ts: isoAt(0),
    conversation_id: "conv-a",
    root_handoff_id: "A.1",
    parent_handoff_id: null,
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "A.2",
    ts: isoAt(1),
    conversation_id: "conv-a",
    root_handoff_id: "A.1",
    parent_handoff_id: "A.1",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "A.3",
    ts: isoAt(2),
    conversation_id: "conv-a",
    root_handoff_id: "A.1",
    parent_handoff_id: "A.2",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "A.4",
    ts: isoAt(3),
    conversation_id: "conv-a",
    root_handoff_id: "A.1",
    parent_handoff_id: "A.3",
    status: "approved",
  });
}

function seedChainB(): void {
  insertHandoffRow({
    handoff_id: "B.1",
    ts: isoAt(50),
    conversation_id: "conv-b",
    root_handoff_id: "B.1",
    parent_handoff_id: null,
    status: "approved",
  });
}

function seedSingleRootChain(count: number): void {
  for (let i = 1; i <= count; i++) {
    const id = `R.${i}`;
    insertHandoffRow({
      handoff_id: id,
      ts: isoAt(i - 1),
      conversation_id: "conv-r",
      root_handoff_id: "R.1",
      parent_handoff_id: i === 1 ? null : `R.${i - 1}`,
      status: "approved",
    });
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db); // Required because schema has vector indexes now
  migrate(db, { embeddingDim: 384 });
  writer = new HandoffWriter({ db });
  reader = new HandoffReader({ db });
});

const sampleParams = (id: string, conv: string) => ({
  handoff_id: id,
  ts: `2026-04-25T20:00:0${id.slice(-1)}.000Z`,
  from: "claude",
  to: "gemini",
  to_role: null,
  message: `m-${id}`,
  conversation_id: conv,
  project_id: null,
  triggered_by_event_id: `e-${id}`,
});

test("listPending returns only pending handoffs, oldest first", () => {
  writer.create(sampleParams("h-1", "c-a"));
  writer.create(sampleParams("h-2", "c-a"));
  writer.create(sampleParams("h-3", "c-b"));
  writer.approve("h-2", { resolved_by: "u", resolved_at: "t" });

  const all = reader.listPending();
  expect(all.map((h) => h.handoff_id)).toEqual(["h-1", "h-3"]);
});

test("listPending filters by conversation_id when provided", () => {
  writer.create(sampleParams("h-1", "c-a"));
  writer.create(sampleParams("h-2", "c-b"));

  const inA = reader.listPending({ conversation_id: "c-a" });
  expect(inA.map((h) => h.handoff_id)).toEqual(["h-1"]);
});

test("get returns the row by id, or null", () => {
  writer.create(sampleParams("h-1", "c-a"));
  expect(reader.get("h-1")?.handoff_id).toBe("h-1");
  expect(reader.get("missing")).toBeNull();
});

test("getRootForConversation returns earliest root handoff for conversation", () => {
  insertHandoffRow({
    handoff_id: "r-1",
    ts: isoAt(0),
    conversation_id: "conv-root",
    root_handoff_id: "r-1",
    parent_handoff_id: null,
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "c-1",
    ts: isoAt(1),
    conversation_id: "conv-root",
    root_handoff_id: "r-1",
    parent_handoff_id: "r-1",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "r-2",
    ts: isoAt(2),
    conversation_id: "conv-other",
    root_handoff_id: "r-2",
    parent_handoff_id: null,
    status: "approved",
  });

  const root = reader.getRootForConversation("conv-root");
  expect(root?.handoff_id).toBe("r-1");
});

test("getRootForConversation returns null when conversation has no root", () => {
  expect(reader.getRootForConversation("missing-conv")).toBeNull();
});

test("EXPLAIN QUERY PLAN mentions handoffs_root_by_conv for root lookup query", () => {
  insertHandoffRow({
    handoff_id: "r-1",
    ts: isoAt(0),
    conversation_id: "conv-root-plan",
    root_handoff_id: "r-1",
    parent_handoff_id: null,
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "r-2",
    ts: isoAt(1),
    conversation_id: "conv-root-plan",
    root_handoff_id: "r-1",
    parent_handoff_id: "r-1",
    status: "approved",
  });

  const planRows = db
    .query<
      { detail: string },
      [string]
    >("EXPLAIN QUERY PLAN SELECT * FROM handoffs WHERE conversation_id = ? AND parent_handoff_id IS NULL ORDER BY ts ASC LIMIT 1")
    .all("conv-root-plan");
  const allDetail = planRows.map((row) => row.detail).join(" ");
  expect(allDetail).toContain("handoffs_root_by_conv");
});

test("listByStatus returns rows matching any of the given statuses, ordered by ts", () => {
  writer.create({ ...sampleParams("h-1", "c-1"), ts: "2026-04-26T00:00:01Z" });
  writer.create({ ...sampleParams("h-2", "c-1"), ts: "2026-04-26T00:00:02Z" });
  writer.create({ ...sampleParams("h-3", "c-2"), ts: "2026-04-26T00:00:03Z" });
  writer.approve("h-2", { resolved_by: "u", resolved_at: "2026-04-26T00:00:10Z" });

  const pending = reader.listByStatus({ statuses: ["pending"] });
  expect(pending.map((r) => r.handoff_id)).toEqual(["h-1", "h-3"]);

  const both = reader.listByStatus({ statuses: ["pending", "approved"] });
  expect(both.map((r) => r.handoff_id)).toEqual(["h-1", "h-2", "h-3"]);
});

test("listByStatus fair-queues two chains by per-root in-flight count", () => {
  seedChainA();
  seedChainB();

  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)).toEqual([
    "A.1",
    "A.2",
    "A.3",
    "A.4",
    "B.1",
  ]);

  markDispatched("A.1");
  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)[0]).toBe("B.1");

  markDispatched("B.1");
  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)[0]).toBe("A.2");

  markDispatched("A.2");
  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)[0]).toBe("A.3");

  markDispatched("A.3");
  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)[0]).toBe("A.4");
});

test("listByStatus with project_id undefined does not filter by project", () => {
  insertHandoffRow({
    handoff_id: "P1",
    ts: isoAt(0),
    conversation_id: "conv-scoped",
    root_handoff_id: "P1",
    project_id: "proj-alpha",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "P2",
    ts: isoAt(1),
    conversation_id: "conv-scoped",
    root_handoff_id: "P2",
    project_id: null,
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "P3",
    ts: isoAt(2),
    conversation_id: "conv-scoped",
    root_handoff_id: "P3",
    project_id: "proj-beta",
    status: "approved",
  });

  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)).toEqual([
    "P1",
    "P2",
    "P3",
  ]);
});

test("listByStatus string filter preserves fair ordering within project", () => {
  insertHandoffRow({
    handoff_id: "F1",
    ts: isoAt(0),
    conversation_id: "conv-filter-1",
    root_handoff_id: "F1",
    project_id: "proj-alpha",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "F2",
    ts: isoAt(1),
    conversation_id: "conv-filter-1",
    root_handoff_id: "F1",
    parent_handoff_id: "F1",
    project_id: "proj-alpha",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "F3",
    ts: isoAt(2),
    conversation_id: "conv-filter-2",
    root_handoff_id: "F3",
    project_id: "proj-alpha",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "F4",
    ts: isoAt(3),
    conversation_id: "conv-filter-3",
    root_handoff_id: "F4",
    project_id: "proj-beta",
    status: "approved",
  });
  markDispatched("F1");

  expect(
    reader
      .listByStatus({ statuses: ["approved"], project_id: "proj-alpha" })
      .map((r) => r.handoff_id),
  ).toEqual(["F3", "F2"]);
});

test("listByStatus with project_id null returns only rows without project_id", () => {
  insertHandoffRow({
    handoff_id: "N1",
    ts: isoAt(0),
    conversation_id: "conv-null",
    root_handoff_id: "N1",
    project_id: "proj-alpha",
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "N2",
    ts: isoAt(1),
    conversation_id: "conv-null",
    root_handoff_id: "N2",
    project_id: null,
    status: "approved",
  });
  insertHandoffRow({
    handoff_id: "N3",
    ts: isoAt(2),
    conversation_id: "conv-null",
    root_handoff_id: "N3",
    project_id: null,
    status: "approved",
  });

  expect(
    reader.listByStatus({ statuses: ["approved"], project_id: null }).map((r) => r.handoff_id),
  ).toEqual(["N2", "N3"]);
});

test("listByStatus keeps single-root order in ts asc", () => {
  seedSingleRootChain(8);

  expect(reader.listByStatus({ statuses: ["approved"] }).map((r) => r.handoff_id)).toEqual([
    "R.1",
    "R.2",
    "R.3",
    "R.4",
    "R.5",
    "R.6",
    "R.7",
    "R.8",
  ]);
});

test("EXPLAIN QUERY PLAN mentions idx_handoffs_root_status for the fair-queue claim query", () => {
  seedChainA();
  seedChainB();

  // Correlated subquery form chosen here because SQLite's planner reports the
  // covering index on (status, root_handoff_id) for the dispatched-count lookup.
  const sql = `SELECT h.* FROM handoffs h
WHERE h.status IN ('approved')
ORDER BY (
  SELECT COUNT(*) FROM handoffs h2
  WHERE h2.status='dispatched' AND h2.root_handoff_id = h.root_handoff_id
) ASC,
h.ts ASC`;
  const planRows = db.query("EXPLAIN QUERY PLAN " + sql).all() as Array<{ detail: string }>;
  const allDetail = planRows.map((r) => r.detail).join(" ");
  expect(allDetail).toContain("idx_handoffs_root_status");
});

test("claimDispatch remains atomic for the row returned first by listByStatus", () => {
  seedChainA();
  seedChainB();

  const row = reader.listByStatus({ statuses: ["approved"] })[0];
  expect(row?.handoff_id).toBe("A.1");
  expect(writer.claimDispatch(row.handoff_id, "worker-1")).toBe(true);
  expect(writer.claimDispatch(row.handoff_id, "worker-2")).toBe(false);
});

test("listByStatus filters by conversation_id when given", () => {
  writer.create({ ...sampleParams("h-1", "cA"), ts: "2026-04-26T00:00:01Z" });
  writer.create({ ...sampleParams("h-2", "cB"), ts: "2026-04-26T00:00:02Z" });

  const r = reader.listByStatus({ statuses: ["pending"], conversation_id: "cA" });
  expect(r.map((x) => x.handoff_id)).toEqual(["h-1"]);
});

test("listByStatus normalizes raw SQLite isolated_install booleans", () => {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent, to_role,
       message, status, triggered_by_event_id, use_worktree, isolated_install,
       parent_handoff_id, root_handoff_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "h-isolated-raw",
      isoAt(0),
      null,
      "conv-isolated-raw",
      "planner",
      "gemini",
      null,
      "m",
      "approved",
      "e-isolated-raw",
      1,
      1,
      null,
      "h-isolated-raw",
    ],
  );

  const [row] = reader.listByStatus({ statuses: ["approved"] });

  expect(row?.use_worktree).toBe(true);
  expect(row?.isolated_install).toBe(true);
});

test("listByStatus rejects empty status list", () => {
  expect(() => reader.listByStatus({ statuses: [] })).toThrow();
});

test("listOrphanedDispatches respects limit", () => {
  insertHandoffRow({
    handoff_id: "h-1",
    ts: isoAt(0),
    conversation_id: "c",
    root_handoff_id: "h-1",
  });
  insertHandoffRow({
    handoff_id: "h-2",
    ts: isoAt(1),
    conversation_id: "c",
    root_handoff_id: "h-1",
  });
  insertHandoffRow({
    handoff_id: "h-3",
    ts: isoAt(2),
    conversation_id: "c",
    root_handoff_id: "h-1",
  });
  markDispatched("h-1");
  markDispatched("h-2");
  markDispatched("h-3");
  db.run("UPDATE handoffs SET worker_id='w1'");

  const all = reader.listOrphanedDispatches(["w1"]);
  expect(all.length).toBe(3);

  const limited = reader.listOrphanedDispatches(["w1"], 2);
  expect(limited.length).toBe(2);
});
