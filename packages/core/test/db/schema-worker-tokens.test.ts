import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applySchema } from "../../src/db/schema.js";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

test("applySchema creates worker_tokens table with the expected columns", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  const cols = db.query<ColumnInfo, []>("PRAGMA table_info(worker_tokens)").all();

  expect(cols.length).toBe(6);

  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

  expect(byName["token_hash"].type).toBe("TEXT");
  expect(byName["token_hash"].notnull).toBe(1);

  expect(byName["worker_id"].type).toBe("TEXT");
  expect(byName["worker_id"].notnull).toBe(1);

  expect(byName["issued_at"].type).toBe("INTEGER");
  expect(byName["issued_at"].notnull).toBe(1);

  expect(byName["last_seen_at"].type).toBe("INTEGER");
  expect(byName["last_seen_at"].notnull).toBe(1);

  expect(byName["revoked_at"].type).toBe("INTEGER");
  expect(byName["revoked_at"].notnull).toBe(0);

  expect(byName["metadata_json"].type).toBe("TEXT");
  expect(byName["metadata_json"].notnull).toBe(0);

  db.close();
});

test("worker_tokens primary key is token_hash", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  const cols = db.query<ColumnInfo, []>("PRAGMA table_info(worker_tokens)").all();

  const pk = cols.filter((c) => c.pk === 1);
  expect(pk.length).toBe(1);
  expect(pk[0].name).toBe("token_hash");

  const nonPk = cols.filter((c) => c.pk !== 1);
  for (const c of nonPk) {
    expect(c.pk).toBe(0);
  }

  db.close();
});

test("idx_worker_tokens_worker partial index exists and filters revoked rows", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  const row = db
    .query<
      { sql: string },
      []
    >("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_worker_tokens_worker'")
    .get();

  expect(row).not.toBeNull();
  expect(row!.sql).toMatch(/worker_id/);
  expect(row!.sql).toMatch(/WHERE revoked_at IS NULL/);

  db.close();
});

test("worker_tokens INSERT round-trip works with metadata_json null", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  db.run(
    `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["hash-a", "worker-1", 1000, 1001, null, null],
  );
  db.run(
    `INSERT INTO worker_tokens (token_hash, worker_id, issued_at, last_seen_at, revoked_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["hash-b", "worker-2", 2000, 2001, null, '{"host":"x"}'],
  );

  type Row = {
    token_hash: string;
    worker_id: string;
    issued_at: number;
    last_seen_at: number;
    revoked_at: number | null;
    metadata_json: string | null;
  };

  const rows = db.query<Row, []>("SELECT * FROM worker_tokens ORDER BY issued_at").all();

  expect(rows.length).toBe(2);

  expect(rows[0].token_hash).toBe("hash-a");
  expect(rows[0].worker_id).toBe("worker-1");
  expect(rows[0].issued_at).toBe(1000);
  expect(rows[0].last_seen_at).toBe(1001);
  expect(rows[0].revoked_at).toBeNull();
  expect(rows[0].metadata_json).toBeNull();

  expect(rows[1].token_hash).toBe("hash-b");
  expect(rows[1].metadata_json).toBe('{"host":"x"}');

  db.close();
});
