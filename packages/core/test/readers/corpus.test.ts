import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
try {
  if (process.platform === "darwin")
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
} catch {}
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";
import { buildCorpus, listCorpora, queryCorpus, removeCorpus } from "../../src/readers/corpus.js";

class FixedEmbedder {
  readonly name = "fixed";
  readonly dim = 2;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array([1, 0]));
  }
}

const insertT2 = (
  db: Database,
  id: string,
  opts: { obs_type?: string; concepts?: string[]; body?: string; vec?: number[] } = {},
) => {
  const obs_type = opts.obs_type ?? null;
  const concepts = opts.concepts ? JSON.stringify(opts.concepts) : null;
  const body = opts.body ?? "b";
  db.run(
    `INSERT INTO t2_memories(memory_id, user_id, kind, source_session_ids, window_start, window_end, title, body, metadata_json, created_at, updated_at, obs_type, concepts)
     VALUES (?, 'u', 'rollup', '[]', '2026-05-03', '2026-05-03', 't', ?, '{}', '2026-05-03', '2026-05-03', ?, ?)`,
    [id, body, obs_type, concepts],
  );
  if (opts.vec) {
    const rowid = db
      .query<{ rowid: number }, [string]>(`SELECT rowid FROM t2_memories WHERE memory_id=?`)
      .get(id)!.rowid;
    db.run(`INSERT INTO t2_vec(rowid, embedding) VALUES (?, ?)`, [
      rowid,
      new Float32Array(opts.vec),
    ]);
  }
};

describe("corpus", () => {
  test("buildCorpus selects t2 rows by filter and persists membership", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    insertT2(db, "m1", { obs_type: "feature", concepts: ["acp"] });
    insertT2(db, "m2", { obs_type: "bugfix", concepts: ["acp"] });
    insertT2(db, "m3", { obs_type: "feature", concepts: ["acp"] });
    insertT2(db, "m4", { obs_type: "feature", concepts: ["mcp"] });

    const result = await buildCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "acp-features",
      description: "Feature work on ACP",
      filter: { obs_type: "feature", concept: "acp" },
    });
    expect(result.member_count).toBe(2);

    const list = listCorpora(db);
    expect(list.find((c) => c.name === "acp-features")?.member_count).toBe(2);
  });

  test("buildCorpus is idempotent on name (ON CONFLICT replaces members)", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    insertT2(db, "m1", { obs_type: "feature" });
    insertT2(db, "m2", { obs_type: "feature" });
    insertT2(db, "m3", { obs_type: "bugfix" });

    const a = await buildCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "all-features",
      filter: { obs_type: "feature" },
    });
    expect(a.member_count).toBe(2);

    const b = await buildCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "all-features",
      filter: { obs_type: "bugfix" },
    });
    expect(b.member_count).toBe(1);
    expect(b.corpus_id).toBe(a.corpus_id);
    const list = listCorpora(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.member_count).toBe(1);
  });

  test("queryCorpus restricts vector rerank to members only", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    insertT2(db, "m1", { obs_type: "feature", body: "codex acp wiring", vec: [1, 0, 0, 0] });
    insertT2(db, "m2", { obs_type: "bugfix", body: "codex acp crash", vec: [0.9, 0, 0, 0] });
    insertT2(db, "m3", { obs_type: "feature", body: "banana split", vec: [0, 1, 0, 0] });

    await buildCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "features-only",
      filter: { obs_type: "feature" },
    });
    const out = await queryCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "features-only",
      query: "codex",
      limit: 5,
    });
    const ids = out.map((h) => h.id).sort();
    expect(ids).toEqual(["m1", "m3"]);
    expect(out.find((h) => h.id === "m2")).toBeUndefined();
  });

  test("queryCorpus returns [] for unknown corpus name", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    const out = await queryCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "no-such-corpus",
      query: "whatever",
    });
    expect(out).toEqual([]);
  });

  test("removeCorpus deletes the corpus and cascades members", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 4 });
    insertT2(db, "m1", { obs_type: "feature" });
    await buildCorpus(db, new TestEmbedder({ dim: 4 }), {
      name: "tmp",
      filter: { obs_type: "feature" },
    });
    expect(removeCorpus(db, "tmp")).toBe(true);
    expect(listCorpora(db)).toHaveLength(0);
    const memberCount =
      db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM corpus_members`).get()?.c ?? 0;
    expect(memberCount).toBe(0);
    expect(removeCorpus(db, "tmp")).toBe(false);
  });

  test("uses the canonical L2 distance to similarity mapping", async () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 2 });
    insertT2(db, "same", { obs_type: "feature", body: "same", vec: [1, 0] });
    insertT2(db, "distance1", { obs_type: "feature", body: "distance1", vec: [0.5, 0.8660254] });
    insertT2(db, "orthogonal", { obs_type: "feature", body: "orthogonal", vec: [0, 1] });
    insertT2(db, "opposite", { obs_type: "feature", body: "opposite", vec: [-1, 0] });

    await buildCorpus(db, new FixedEmbedder() as unknown as TestEmbedder, {
      name: "all",
      filter: { obs_type: "feature" },
    });
    const out = await queryCorpus(db, new FixedEmbedder() as unknown as TestEmbedder, {
      name: "all",
      query: "ignored",
      limit: 4,
    });

    expect(out.find((h) => h.id === "same")?.score).toBe(1);
    expect(out.find((h) => h.id === "distance1")?.score).toBeCloseTo(0.5, 10);
    expect(out.find((h) => h.id === "orthogonal")?.score).toBeCloseTo(0.2928932188, 6);
    expect(out.find((h) => h.id === "opposite")?.score).toBe(0);
    expect(out.every((h) => h.score >= 0 && h.score <= 1)).toBe(true);
  });
});
