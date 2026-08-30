import { migrate } from "@src/db/migrations.js";
import { SCHEMA_VERSION } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

let warnSpy: ReturnType<typeof mock>;
let originalWarn: typeof console.warn;
let warnings: string[];

beforeEach(() => {
  warnings = [];
  originalWarn = console.warn;
  warnSpy = mock((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  });
  console.warn = warnSpy;
});

afterEach(() => {
  console.warn = originalWarn;
});

function insertHandoff(
  db: Database,
  handoffId: string,
  parentHandoffId: string | null,
  status = "pending",
): void {
  db.run(
    `INSERT INTO handoffs (
       handoff_id, ts, project_id, conversation_id, from_agent, to_agent,
       message, status, parent_handoff_id, root_handoff_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      handoffId,
      "2026-05-05T00:00:00Z",
      "proj-1",
      "conv-1",
      "agent-a",
      "agent-b",
      "msg " + handoffId,
      status,
      parentHandoffId,
    ],
  );
}

function getRoots(db: Database): Map<string, string | null> {
  const rows = db
    .query<
      { handoff_id: string; root_handoff_id: string | null },
      []
    >(`SELECT handoff_id, root_handoff_id FROM handoffs`)
    .all();
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.handoff_id, r.root_handoff_id);
  return map;
}

test("SCHEMA_VERSION matches current version", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const row = db
    .query<{ value: string }, [string]>(`SELECT value FROM db_meta WHERE key = ?`)
    .get("schema_version");
  expect(row?.value).toBe(String(SCHEMA_VERSION));
  db.close();
});

test("idx_handoffs_root_status index is created", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const idx = db
    .query<
      { name: string },
      []
    >(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_handoffs_root_status'`)
    .all();
  expect(idx.length).toBe(1);
  expect(idx[0]?.name).toBe("idx_handoffs_root_status");
  db.close();
});

test("backfill resolves self-roots, parents, and grandchildren", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  // Pre-seed v11 state by inserting rows with NULL root_handoff_id.
  insertHandoff(db, "R1", null);
  insertHandoff(db, "C1", "R1");
  insertHandoff(db, "G1", "C1");
  insertHandoff(db, "R2", null);

  // Re-run migrate; backfill processes the NULL roots.
  migrate(db, { embeddingDim: 384 });

  const roots = getRoots(db);
  expect(roots.get("R1")).toBe("R1");
  expect(roots.get("C1")).toBe("R1");
  expect(roots.get("G1")).toBe("R1");
  expect(roots.get("R2")).toBe("R2");
  expect(warnings).toEqual([]);
  db.close();
});

test("backfill is idempotent on re-run", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  insertHandoff(db, "R1", null);
  insertHandoff(db, "C1", "R1");
  migrate(db, { embeddingDim: 384 });
  const first = getRoots(db);

  migrate(db, { embeddingDim: 384 });
  migrate(db, { embeddingDim: 384 });
  const second = getRoots(db);

  expect(second.get("R1")).toBe(first.get("R1") ?? null);
  expect(second.get("C1")).toBe(first.get("C1") ?? null);
  expect(second.get("R1")).toBe("R1");
  expect(second.get("C1")).toBe("R1");

  // Index still exists, no duplicate-index errors thrown.
  const idx = db
    .query<
      { name: string },
      []
    >(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_handoffs_root_status'`)
    .all();
  expect(idx.length).toBe(1);
  db.close();
});

test("depth-cap fallback self-roots the deepest row with warning", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  // 17-deep chain: d0 (root), d1 (parent=d0), ..., d16 (parent=d15).
  // Insert leaf-first so the leaf is processed before any ancestor's
  // root_handoff_id is memoized; with a 16-visit cap the leaf cannot
  // reach d0 within the limit and falls back to self-root.
  const ids = Array.from({ length: 17 }, (_, i) => `d${String(i)}`);
  for (let i = ids.length - 1; i >= 1; i--) {
    insertHandoff(db, ids[i]!, ids[i - 1]!);
  }
  insertHandoff(db, ids[0]!, null);

  migrate(db, { embeddingDim: 384 });

  const roots = getRoots(db);
  // Deepest row self-roots.
  expect(roots.get(ids[16]!)).toBe(ids[16]);
  // Other rows in the chain still resolve to the true root r0.
  expect(roots.get(ids[0]!)).toBe(ids[0]);
  expect(roots.get(ids[15]!)).toBe(ids[0]);
  expect(roots.get(ids[1]!)).toBe(ids[0]);

  expect(warnings.some((w) => w.includes("depth-cap fallback") && w.includes(ids[16]!))).toBe(true);
  db.close();
});

test("orphaned-parent fallback self-roots with warning", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  // A points at parent B, but B does not exist in the table.
  insertHandoff(db, "A", "B-missing");

  migrate(db, { embeddingDim: 384 });

  const roots = getRoots(db);
  expect(roots.get("A")).toBe("A");

  expect(warnings.some((w) => w.includes("orphaned parent fallback") && w.includes("A"))).toBe(
    true,
  );
  db.close();
});
