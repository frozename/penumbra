import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { migrate } from "../../src/db/migrations.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // platform-specific SQLite override; ignore failures elsewhere
}

test("claude_code_sessions table exists with expected columns after migrate", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const tableRow = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='claude_code_sessions'")
    .get() as { name: string } | undefined;
  expect(tableRow?.name).toBe("claude_code_sessions");

  const cols = db.query("PRAGMA table_info('claude_code_sessions')").all() as {
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }[];
  const colMap = Object.fromEntries(cols.map((c) => [c.name, c]));
  expect(colMap.session_id?.pk).toBe(1);
  expect(colMap.session_id?.type).toBe("TEXT");
  expect(colMap.session_start_at?.type).toBe("TEXT");
  expect(colMap.session_start_at?.notnull).toBe(1);
  expect(colMap.last_seen_at?.type).toBe("TEXT");
  expect(colMap.last_seen_at?.notnull).toBe(1);
  expect(colMap.project_id?.type).toBe("TEXT");

  const idxRow = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='claude_code_sessions_by_last_seen'",
    )
    .get() as { name: string } | undefined;
  expect(idxRow?.name).toBe("claude_code_sessions_by_last_seen");
});

test("claude_code_sessions upsert preserves session_start_at, updates last_seen_at", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const upsert = db.prepare(`
    INSERT INTO claude_code_sessions (session_id, session_start_at, last_seen_at, project_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      project_id = COALESCE(excluded.project_id, claude_code_sessions.project_id)
  `);

  upsert.run("s1", "2026-05-05T10:00:00Z", "2026-05-05T10:00:00Z", "penumbra");
  upsert.run("s1", "2026-05-05T11:00:00Z", "2026-05-05T11:30:00Z", null);

  const row = db
    .query<
      {
        session_id: string;
        session_start_at: string;
        last_seen_at: string;
        project_id: string | null;
      },
      [string]
    >("SELECT * FROM claude_code_sessions WHERE session_id = ?")
    .get("s1");

  expect(row?.session_start_at).toBe("2026-05-05T10:00:00Z");
  expect(row?.last_seen_at).toBe("2026-05-05T11:30:00Z");
  expect(row?.project_id).toBe("penumbra");
});
