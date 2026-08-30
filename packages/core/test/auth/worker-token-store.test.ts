import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { WorkerTokenStore } from "@src/auth/worker-token-store.js";
import { applySchema } from "@src/db/schema.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // already loaded by a sibling test file — no-op
  }
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  return db;
}

test("issue() returns base64url token + sha256 hash; row persists", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);
  const now = 1_000_000;

  const { token, token_hash } = store.issue({ worker_id: "W-A", metadata: { host: "mac" } }, now);

  // token is base64url-decodable to 32 bytes
  const decoded = Buffer.from(token, "base64url");
  expect(decoded.length).toBe(32);

  // token_hash matches sha256(token) as hex
  const expected = createHash("sha256").update(token).digest("hex");
  expect(token_hash).toBe(expected);

  type Row = {
    token_hash: string;
    worker_id: string;
    issued_at: number;
    last_seen_at: number;
    revoked_at: number | null;
    metadata_json: string | null;
  };
  const row = db
    .query<Row, [string]>("SELECT * FROM worker_tokens WHERE token_hash = ?")
    .get(token_hash);

  expect(row).not.toBeNull();
  expect(row!.worker_id).toBe("W-A");
  expect(row!.issued_at).toBe(now);
  expect(row!.last_seen_at).toBe(now);
  expect(row!.revoked_at).toBeNull();
  expect(row!.metadata_json).toBe('{"host":"mac"}');

  db.close();
});

test("issue() persists metadata_json as NULL when metadata omitted", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);
  const now = 1_000_000;

  const { token_hash } = store.issue({ worker_id: "W-A" }, now);

  const row = db
    .query<
      { metadata_json: string | null },
      [string]
    >("SELECT metadata_json FROM worker_tokens WHERE token_hash = ?")
    .get(token_hash);

  expect(row).not.toBeNull();
  expect(row!.metadata_json).toBeNull();

  db.close();
});

test("lookup() returns the row for an active token, null for unknown", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);
  const now = 1_000_000;

  const { token, token_hash } = store.issue({ worker_id: "W-B" }, now);

  const found = store.lookup(token);
  expect(found).not.toBeNull();
  expect(found!.token_hash).toBe(token_hash);
  expect(found!.worker_id).toBe("W-B");
  expect(found!.issued_at).toBe(now);
  expect(found!.last_seen_at).toBe(now);
  expect(found!.revoked_at).toBeNull();
  expect(found!.metadata_json).toBeNull();

  const missing = store.lookup("unknown-token");
  expect(missing).toBeNull();

  db.close();
});

test("lookup() returns null for revoked tokens", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);
  const now = 1_000_000;

  const { token, token_hash } = store.issue({ worker_id: "W-C" }, now);
  store.revoke(token_hash, now + 1000);

  const result = store.lookup(token);
  expect(result).toBeNull();

  db.close();
});

test("touch() updates last_seen_at; no-op on revoked tokens", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);

  const { token_hash } = store.issue({ worker_id: "W-D" }, 1000);

  store.touch(token_hash, 2000);
  const afterTouch = db
    .query<
      { last_seen_at: number },
      [string]
    >("SELECT last_seen_at FROM worker_tokens WHERE token_hash = ?")
    .get(token_hash);
  expect(afterTouch!.last_seen_at).toBe(2000);

  store.revoke(token_hash, 3000);
  store.touch(token_hash, 4000);
  const afterRevoke = db
    .query<
      { last_seen_at: number },
      [string]
    >("SELECT last_seen_at FROM worker_tokens WHERE token_hash = ?")
    .get(token_hash);
  expect(afterRevoke!.last_seen_at).toBe(2000);

  db.close();
});

test("revoke() sets revoked_at; row retained for audit", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);

  const { token_hash } = store.issue({ worker_id: "W-E" }, 1000);
  store.revoke(token_hash, 5000);

  const row = db
    .query<
      { revoked_at: number | null },
      [string]
    >("SELECT revoked_at FROM worker_tokens WHERE token_hash = ?")
    .get(token_hash);

  expect(row).not.toBeNull();
  expect(row!.revoked_at).toBe(5000);

  db.close();
});

test("two issue() calls for the same worker_id produce distinct tokens", () => {
  const db = makeDb();
  const store = new WorkerTokenStore(db);
  const now = 1_000_000;

  const a = store.issue({ worker_id: "W-F" }, now);
  const b = store.issue({ worker_id: "W-F" }, now + 1);

  expect(a.token).not.toBe(b.token);
  expect(a.token_hash).not.toBe(b.token_hash);

  expect(store.lookup(a.token)).not.toBeNull();
  expect(store.lookup(b.token)).not.toBeNull();

  const rows = db
    .query<{ token_hash: string }, []>("SELECT token_hash FROM worker_tokens ORDER BY issued_at")
    .all();
  expect(rows.length).toBe(2);

  db.close();
});
