import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { migrate } from "@src/db/migrations.js";
import { loadSqliteVec } from "@src/db/sqlite-vec.js";
import { TestEmbedder } from "@src/embedder/test-embedder.js";
import { RecallReader } from "@src/readers/recall.js";
import type { RecallRequest } from "@src/schemas/recall.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
});

afterEach(() => {
  db.close();
});

async function seedT1(rollupId: string, text: string, createdAt: string): Promise<void> {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([text]);
  db.run(
    `INSERT INTO t1_rollups(rollup_id, project_id, user_id, session_id, started_at, ended_at,
                            n_events, last_response_excerpt, first_prompt_excerpt)
     VALUES (?, ?, 'u', ?, ?, ?, 1, ?, ?)`,
    [rollupId, "p1", rollupId, createdAt, createdAt, text, text],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t1_rollups WHERE rollup_id=?")
    .get(rollupId)!.rowid;
  db.run("INSERT INTO t1_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec!]);
}

const req: RecallRequest = {
  query: "the quick brown fox",
  project_id: "p1",
  limit: 10,
  include_raw: false,
  include_untrusted: false,
  min_score: 0,
};

test("recall skips the embed and the tier scans when the signal is already aborted", async () => {
  await seedT1("a", "the quick brown fox", "2026-04-20T00:00:00Z");

  let embedCalls = 0;
  const base = new TestEmbedder({ dim: 384 });
  const countingEmbedder = {
    name: "counting",
    dim: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      embedCalls += 1;
      return await base.embed(texts);
    },
  };
  const reader = new RecallReader({ db, embedder: countingEmbedder });

  expect(await reader.recall(req)).toHaveLength(1);
  expect(embedCalls).toBe(1);

  const controller = new AbortController();
  controller.abort();
  expect(await reader.recall(req, { signal: controller.signal })).toEqual([]);
  expect(embedCalls).toBe(1);
});

test("recall stops after an in-flight embed resolves when the signal aborts before tier scans", async () => {
  await seedT1("a", "the quick brown fox", "2026-04-20T00:00:00Z");

  const controlReader = new RecallReader({ db, embedder: new TestEmbedder({ dim: 384 }) });
  expect(await controlReader.recall(req)).toHaveLength(1);

  let releaseEmbed: (() => void) | undefined;
  let embedStarted: (() => void) | undefined;
  const embedInFlight = new Promise<void>((resolve) => {
    embedStarted = resolve;
  });
  const base = new TestEmbedder({ dim: 384 });
  const blockingEmbedder = {
    name: "blocking",
    dim: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      embedStarted?.();
      await new Promise<void>((resolve) => {
        releaseEmbed = resolve;
      });
      return await base.embed(texts);
    },
  };
  const reader = new RecallReader({ db, embedder: blockingEmbedder });
  const controller = new AbortController();
  const recallPromise = reader.recall(req, { signal: controller.signal });

  await embedInFlight;
  controller.abort();
  releaseEmbed?.();

  expect(await recallPromise).toEqual([]);
});
