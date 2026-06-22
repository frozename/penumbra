import { applySchema, loadSqliteVec } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it } from "bun:test";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // The Homebrew SQLite override is optional in CI and Linux test environments.
}

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
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const requiredColumn of [
      "pattern_id",
      "pattern",
      "reason",
      "status",
      "proposed_by",
      "proposed_at",
      "enabled",
    ]) {
      expect(names).toContain(requiredColumn);
    }
  });

  it("idx_curator_ephemera_status index exists", () => {
    const idx = db
      .prepare(`SELECT name FROM pragma_index_list('curator_ephemera_patterns')`)
      .all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_curator_ephemera_status");
  });
});
