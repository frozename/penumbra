import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { assertEmbedderDim, migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

test("assertEmbedderDim throws when embedder dim differs from stored dim", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  expect(() => {
    assertEmbedderDim(db, 1536, "sirius");
  }).toThrow(
    "embedding dim mismatch: embedder 'sirius' produces 1536-dim vectors but the store is 384-dim. Re-embed the corpus or fix PENUMBRA_EMBEDDINGS_DIM.",
  );
});

test("assertEmbedderDim is a no-op when dims are equal", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  expect(() => {
    assertEmbedderDim(db, 384, "bundled-fastembed");
  }).not.toThrow();
});

test("assertEmbedderDim is a no-op when no dim is stored yet", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  expect(() => {
    assertEmbedderDim(db, 1536, "sirius");
  }).not.toThrow();
});
