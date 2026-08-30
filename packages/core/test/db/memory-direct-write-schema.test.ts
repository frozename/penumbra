import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;

function seedCycle(db: Database, cycleId = "C1"): void {
  db.run(
    `INSERT INTO dream_cycles(cycle_id, started_at, trigger, budget_usd_cap) VALUES(?, 1, 'cron', 0.1)`,
    [cycleId],
  );
}

function seedMemory(
  db: Database,
  memoryId: string,
  options: {
    slug?: string | null;
    projectId?: string | null;
    hook?: string | null;
    subKind?: string | null;
    origin?: string | null;
    body?: string;
  } = {},
): void {
  const {
    slug = null,
    projectId = null,
    hook = null,
    subKind = null,
    origin = null,
    body = "body",
  } = options;

  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
      title, body, created_at, updated_at, slug, hook, sub_kind, origin
    ) VALUES(?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryId,
      projectId,
      "u1",
      "summary",
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
      memoryId,
      body,
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
      slug,
      hook,
      subKind,
      origin,
    ],
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 4 });
});

test("t2_memories accepts direct-write fields including origin, slug, hook, sub_kind", () => {
  seedMemory(db, "m1", {
    slug: "s1",
    hook: "hook://notes/m1",
    subKind: "decision",
    origin: "direct",
  });

  const row = db
    .query<
      { slug: string | null; hook: string | null; sub_kind: string | null; origin: string | null },
      [string]
    >(`SELECT slug, hook, sub_kind, origin FROM t2_memories WHERE memory_id = ?`)
    .get("m1");

  expect(row).toEqual({
    slug: "s1",
    hook: "hook://notes/m1",
    sub_kind: "decision",
    origin: "direct",
  });
});

test("memory_links accepts wiki and wiki_unresolved inserts with dst_id nullability for unresolved links", () => {
  seedCycle(db);
  seedMemory(db, "src");
  seedMemory(db, "dst");

  db.run(
    `INSERT INTO memory_links(
      link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle
    ) VALUES('L1','src','dst','wiki',0.8,1,'C1')`,
  );
  db.run(
    `INSERT INTO memory_links(
      link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle, metadata_json
    ) VALUES('L2','src',NULL,'wiki_unresolved',0.2,1,'C1', ?)`,
    [JSON.stringify({ raw_slug: "some-target" })],
  );

  const wiki = db
    .query<{ link_type: string; dst_id: string | null; metadata_json: string }, [string]>(
      `
      SELECT link_type, dst_id, metadata_json FROM memory_links WHERE link_id = ?`,
    )
    .get("L1");
  expect(wiki?.link_type).toBe("wiki");
  expect(wiki?.dst_id).toBe("dst");

  const unresolved = db
    .query<{ link_type: string; dst_id: string | null; metadata_json: string }, [string]>(
      `
      SELECT link_type, dst_id, metadata_json FROM memory_links WHERE link_id = ?`,
    )
    .get("L2");
  expect(unresolved?.link_type).toBe("wiki_unresolved");
  expect(unresolved?.dst_id).toBeNull();
  expect(JSON.parse(unresolved?.metadata_json ?? "{}")).toEqual({ raw_slug: "some-target" });
});

test("legacy rows without slug, hook, and sub_kind are still queryable", () => {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
      title, body, created_at, updated_at
    ) VALUES(?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    [
      "legacy-memory",
      "p1",
      "u1",
      "summary",
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
      "title",
      "body",
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
    ],
  );
  const row = db
    .query<
      { slug: string | null; hook: string | null; sub_kind: string | null },
      [string]
    >(`SELECT slug, hook, sub_kind FROM t2_memories WHERE memory_id = ?`)
    .get("legacy-memory");

  expect(row).toEqual({ slug: null, hook: null, sub_kind: null });
});

test("t2_memories.cc_kind accepts CC taxonomy values and round-trips", () => {
  db.run(
    `INSERT INTO t2_memories(
      memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
      title, body, created_at, updated_at, slug, hook, sub_kind, cc_kind, origin
    ) VALUES(?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "cc-1",
      "p1",
      "u1",
      "direct",
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
      "CC kind test",
      "body",
      "2026-05-23T00:00:00Z",
      "2026-05-23T00:00:00Z",
      "cc-1-slug",
      "cc test hook",
      "rule",
      "feedback",
      "direct",
    ],
  );
  const row = db
    .query<
      { kind: string; cc_kind: string | null; sub_kind: string | null },
      [string]
    >(`SELECT kind, cc_kind, sub_kind FROM t2_memories WHERE memory_id = ?`)
    .get("cc-1");
  expect(row).toEqual({ kind: "direct", cc_kind: "feedback", sub_kind: "rule" });
});

test("idx_t2_slug enforces project-scoped UNIQUE on non-null slugs", () => {
  seedMemory(db, "u-a", { slug: "shared-slug", origin: "direct", projectId: "proj-a" });
  expect(() => {
    seedMemory(db, "u-b", { slug: "shared-slug", origin: "direct", projectId: "proj-b" });
  }).not.toThrow();
  expect(() => {
    seedMemory(db, "u-c", { slug: "shared-slug", origin: "direct", projectId: "proj-a" });
  }).toThrow(/UNIQUE/);
  expect(() => {
    seedMemory(db, "u-d", { slug: "shared-slug", origin: "direct", projectId: "proj-b" });
  }).toThrow(/UNIQUE/);

  // UNIQUE applies even after the first row is retired for the same project.
  db.run(`UPDATE t2_memories SET retired_at = 1 WHERE memory_id = 'u-a'`);
  expect(() => {
    seedMemory(db, "u-c", { slug: "shared-slug", origin: "direct", projectId: "proj-a" });
  }).toThrow(/UNIQUE/);
});

test("idx_t2_slug allows many rows with NULL slug (legacy + dreaming-promoted)", () => {
  seedMemory(db, "n-1");
  seedMemory(db, "n-2");
  seedMemory(db, "n-3");
  const count = db
    .query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM t2_memories WHERE slug IS NULL`)
    .get()?.c;
  expect(count).toBeGreaterThanOrEqual(3);
});

test("idx_t2_slug rejects duplicate NULL project_id slug", () => {
  seedMemory(db, "null-1", { slug: "shared" });
  expect(() => {
    seedMemory(db, "null-2", { slug: "shared" });
  }).toThrow(/UNIQUE/);
});

test("t2_fts trigger keeps rowid alignment for rows with slug/hook/sub_kind", () => {
  seedMemory(db, "fts-memory", {
    slug: "s-fts",
    hook: "hook://notes/fts",
    subKind: "decision",
    origin: "direct",
  });
  const memoryRow = db
    .query<{ rowid: number }, [string]>(`SELECT rowid FROM t2_memories WHERE memory_id=?`)
    .get("fts-memory");
  const ftsRow = db
    .query<{ rowid: number }, [number]>(`SELECT rowid FROM t2_fts WHERE rowid=?`)
    .get(memoryRow!.rowid);

  expect(memoryRow?.rowid).toBeGreaterThan(0);
  expect(ftsRow?.rowid).toBe(memoryRow?.rowid);
});

test("memory_links_unique unresolved raw_slug index enforces dedupe by src/link_type/raw_slug", () => {
  seedCycle(db, "cycle-unresolved");
  seedMemory(db, "src-memory");
  db.run(
    `INSERT INTO memory_links(
      link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle, raw_slug, metadata_json
    ) VALUES(?, ?, NULL, 'wiki_unresolved', 1.0, ?, 'cycle-unresolved', ?, ?)`,
    ["L1", "src-memory", 123, "missing", JSON.stringify({ raw_slug: "missing" })],
  );
  expect(() =>
    db.run(
      `INSERT INTO memory_links(
      link_id, src_id, dst_id, link_type, weight, minted_at, minted_by_cycle, raw_slug, metadata_json
    ) VALUES(?, ?, NULL, 'wiki_unresolved', 1.0, ?, 'cycle-unresolved', ?, ?)`,
      ["L2", "src-memory", 123, "missing", JSON.stringify({ raw_slug: "missing" })],
    ),
  ).toThrow(/UNIQUE/);
});
