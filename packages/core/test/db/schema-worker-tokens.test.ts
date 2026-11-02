import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

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

function must<T>(value: T | undefined, what: string): T {
  expect(value, what).toBeDefined();
  if (value === undefined) {
    throw new Error(`missing ${what}`);
  }
  return value;
}

test("applySchema creates worker_tokens table with the expected columns", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  const cols = db.query<ColumnInfo, []>("PRAGMA table_info(worker_tokens)").all();

  expect(cols.length).toBe(6);

  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

  expect(must(byName["token_hash"], "token_hash column").type).toBe("TEXT");
  expect(must(byName["token_hash"], "token_hash column").notnull).toBe(1);

  expect(must(byName["worker_id"], "worker_id column").type).toBe("TEXT");
  expect(must(byName["worker_id"], "worker_id column").notnull).toBe(1);

  expect(must(byName["issued_at"], "issued_at column").type).toBe("INTEGER");
  expect(must(byName["issued_at"], "issued_at column").notnull).toBe(1);

  expect(must(byName["last_seen_at"], "last_seen_at column").type).toBe("INTEGER");
  expect(must(byName["last_seen_at"], "last_seen_at column").notnull).toBe(1);

  expect(must(byName["revoked_at"], "revoked_at column").type).toBe("INTEGER");
  expect(must(byName["revoked_at"], "revoked_at column").notnull).toBe(0);

  expect(must(byName["metadata_json"], "metadata_json column").type).toBe("TEXT");
  expect(must(byName["metadata_json"], "metadata_json column").notnull).toBe(0);

  db.close();
});

test("worker_tokens primary key is token_hash", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);

  const cols = db.query<ColumnInfo, []>("PRAGMA table_info(worker_tokens)").all();

  const pk = cols.filter((c) => c.pk === 1);
  expect(pk.length).toBe(1);
  expect(must(pk[0], "primary key column").name).toBe("token_hash");

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

  const first = must(rows[0], "first worker_tokens row");
  expect(first.token_hash).toBe("hash-a");
  expect(first.worker_id).toBe("worker-1");
  expect(first.issued_at).toBe(1000);
  expect(first.last_seen_at).toBe(1001);
  expect(first.revoked_at).toBeNull();
  expect(first.metadata_json).toBeNull();

  const second = must(rows[1], "second worker_tokens row");
  expect(second.token_hash).toBe("hash-b");
  expect(second.metadata_json).toBe('{"host":"x"}');

  db.close();
});
