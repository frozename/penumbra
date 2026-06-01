import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertEmbedderDim } from "./migrations.js";

describe("assertEmbedderDim", () => {
  function makeDb(storedDim?: number): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (storedDim !== undefined) {
      db.run("INSERT INTO db_meta (key, value) VALUES ('embedding_dim', ?)", [String(storedDim)]);
    }
    return db;
  }

  test("throws when stored embedding_dim differs from embedder dim", () => {
    const db = makeDb(384);
    expect(() => assertEmbedderDim(db, 1536, "sirius")).toThrow(
      "embedding dim mismatch: embedder 'sirius' produces 1536-dim vectors but the store is 384-dim. Re-embed the corpus or fix PENUMBRA_SIRIUS_DIM/PENUMBRA_EMBEDDINGS_DIM.",
    );
  });

  test("is a no-op when stored dim equals embedder dim", () => {
    const db = makeDb(384);
    expect(() => assertEmbedderDim(db, 384, "fastembed")).not.toThrow();
  });

  test("is a no-op on a fresh db with no stored dim", () => {
    const db = makeDb();
    expect(() => assertEmbedderDim(db, 384, "fastembed")).not.toThrow();
  });
});
