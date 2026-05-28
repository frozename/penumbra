import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema, loadSqliteVec } from "@penumbra/core";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {}

describe("curator schema", () => {
  let db: Database;
  beforeAll(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    applySchema(db, { embeddingDim: 3 });
  });

  it("curator_ephemera_patterns table has required columns", () => {
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('curator_ephemera_patterns')`)
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "pattern_id",
        "pattern",
        "reason",
        "status",
        "proposed_by",
        "proposed_at",
        "enabled",
      ]),
    );
  });

  it("idx_curator_ephemera_status index exists", () => {
    const idx = db
      .prepare(`SELECT name FROM pragma_index_list('curator_ephemera_patterns')`)
      .all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain("idx_curator_ephemera_status");
  });
});
