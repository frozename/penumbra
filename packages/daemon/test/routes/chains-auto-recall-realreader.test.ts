import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
  type Watchdog,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";

import { chainsStartRoute } from "../../src/routes/chains.js";

// Real-reader regression test: verify non-stubbed recallReader + seeded t2 memory reaches recalled_memory_ids.
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

beforeAll(() => {
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

const STUB_WATCHDOG: Watchdog = {
  recordHeartbeat: (): void => undefined,
  hasActiveWorker: (): boolean => true,
  getStaleWorkers: (): string[] => [],
  getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
  tick: (): Promise<void> => Promise.resolve(),
};

function tempServices(withProjectRegistry = false): { db: Database; services: Services } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chains-auto-recall-realreader-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `id-${String(++n)}`;
    })(),
    ...(withProjectRegistry
      ? {
          projectRegistry: new ProjectRegistry(
            new Map([["penumbra", { project_id: "penumbra", root_path: "/tmp/penumbra" }]]),
          ),
        }
      : {}),
  });
  services.watchdog = STUB_WATCHDOG;
  return { db, services };
}

async function seedT2Memory(
  db: Database,
  memoryId: string,
  createdAt: string,
  text: string,
): Promise<void> {
  const embedder = new TestEmbedder({ dim: 384 });
  const [vec] = await embedder.embed([text]);
  db.run(
    `INSERT INTO t2_memories(memory_id, project_id, user_id, kind, source_session_ids, window_start, window_end,
                             title, body, metadata_json, compressed_from, created_at, updated_at)
     VALUES (?, 'penumbra', 'u', 'summary', '[]', ?, ?, ?, ?, '{}', NULL, ?, ?)`,
    [memoryId, createdAt, createdAt, `Triage memory ${memoryId}`, text, createdAt, createdAt],
  );
  const rowid = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM t2_memories WHERE memory_id=?")
    .get(memoryId)!.rowid;
  db.run("INSERT INTO t2_vec(rowid, embedding) VALUES(?, ?)", [rowid, vec]);
}

interface RecalledMemory {
  id: string;
  title: string;
  obs_type: string;
  snippet_head?: string;
}
interface ChainsStartBody {
  lane_id: string;
  recalled_memory_ids: string[];
  recalled_memories: RecalledMemory[];
}

test("POST /chains/start reaches recalled_memory_ids with real recallReader and seeded t2_memories", async () => {
  const { db, services } = tempServices(true);
  const recallText = "A deterministic memory for real-reader auto-recall regression testing";
  await seedT2Memory(db, "m-real-1", "2026-05-12T00:00:00Z", recallText);

  const res = await chainsStartRoute(
    new Request("http://x/chains/start", {
      method: "POST",
      body: JSON.stringify({
        initial_agent: "planner",
        message: recallText,
        task_class: "STANDARD",
        project_id: "penumbra",
      }),
    }),
    services,
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as ChainsStartBody;
  expect(body.recalled_memory_ids).toEqual(["m-real-1"]);
  expect(body.recalled_memories).toEqual([
    {
      id: "m-real-1",
      title: "Triage memory m-real-1",
      obs_type: "t2",
      snippet_head: recallText,
    },
  ]);
});
