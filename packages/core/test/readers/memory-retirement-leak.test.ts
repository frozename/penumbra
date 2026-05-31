import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { loadSqliteVec } from "../../src/db/sqlite-vec.js";
import { migrate } from "../../src/db/migrations.js";
import { TestEmbedder } from "../../src/embedder/test-embedder.js";
import { RecallReader } from "../../src/readers/recall.js";
import { search } from "../../src/readers/search.js";
import { timeline } from "../../src/readers/timeline.js";
import { getObservations } from "../../src/readers/get-observations.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded
}

const EMBEDDING_DIM = 384;

function freshDb() {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: EMBEDDING_DIM });
  return db;
}

async function seedT2(
  db: Database,
  embedder: TestEmbedder,
  opts: {
    id: string;
    createdAt: string;
    title: string;
    body: string;
    projectId: string;
    retiredAt?: string | null;
  },
): Promise<void> {
  const [vec] = await embedder.embed([`${opts.title}\n${opts.body}`]);
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids,
                             window_start, window_end, title, body, metadata_json,
                             created_at, updated_at, obs_type, concepts, file_paths, retired_at)
     VALUES (?, ?, 'u', 'rollup', '[]', ?, ?, ?, ?, '{}', ?, ?, 'feature', '[]', '[]', ?)`,
    [
      opts.id,
      opts.projectId,
      opts.createdAt,
      opts.createdAt,
      opts.title,
      opts.body,
      opts.createdAt,
      opts.createdAt,
      opts.retiredAt ?? null,
    ],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id=?")
    .get(opts.id)!.rowid;
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec!]);
}

describe("retired t2 memory filtering across recall surfaces", () => {
  test("retired memories are not rehydratable via search -> timeline -> get_observations", async () => {
    const db = freshDb();
    const embedder = new TestEmbedder({ dim: EMBEDDING_DIM });
    const projectId = "p1";

    await seedT2(db, embedder, {
      id: "m1",
      createdAt: "2026-05-01T00:00:00Z",
      title: "memory-surface-signal active one",
      body: "memory-surface-signal body active one",
      projectId,
    });
    await seedT2(db, embedder, {
      id: "m2-retired",
      createdAt: "2026-05-02T00:00:00Z",
      title: "memory-surface-signal retired",
      body: "memory-surface-signal body retired",
      projectId,
      retiredAt: "2026-05-10T00:00:00Z",
    });
    await seedT2(db, embedder, {
      id: "m3",
      createdAt: "2026-05-03T00:00:00Z",
      title: "memory-surface-signal active anchor",
      body: "memory-surface-signal body active anchor",
      projectId,
    });
    await seedT2(db, embedder, {
      id: "m4",
      createdAt: "2026-05-04T00:00:00Z",
      title: "memory-surface-signal active after",
      body: "memory-surface-signal body active after",
      projectId,
    });

    const reader = new RecallReader({ db, embedder });

    const recallHits = await reader.recall({
      query: "memory-surface-signal",
      project_id: projectId,
      limit: 10,
      include_raw: false,
      min_score: 0,
      sources: ["t2"],
    });
    const recallIds = recallHits.map((hit) => hit.id);
    expect(recallIds).toEqual(expect.arrayContaining(["m1", "m3", "m4"]));
    expect(recallIds).not.toContain("m2-retired");

    const searchHits = search(db, {
      query: "memory-surface-signal",
      project_id: projectId,
      limit: 10,
      offset: 0,
      tiers: ["t2"],
    });
    const searchIds = searchHits.map((hit) => hit.id);
    expect(searchIds).toEqual(expect.arrayContaining(["m1", "m3", "m4"]));
    expect(searchIds).not.toContain("m2-retired");

    const retiredAnchorTimeline = timeline(db, {
      anchor: "m2-retired",
      depth_before: 2,
      depth_after: 2,
      project_id: projectId,
    });
    expect(retiredAnchorTimeline).toEqual([]);

    const neighborTimeline = timeline(db, {
      anchor: "m3",
      depth_before: 3,
      depth_after: 2,
      project_id: projectId,
    });
    expect(neighborTimeline.map((row) => row.id)).toEqual(["m1", "m3", "m4"]);

    const observations = getObservations(db, { ids: ["m1", "m2-retired", "m3", "m4"] });
    expect(observations.map((obs) => obs.id)).toEqual(["m1", "m3", "m4"]);
  });
});
