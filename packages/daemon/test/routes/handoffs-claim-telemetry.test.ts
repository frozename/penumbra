import {
  buildServices,
  HandoffWriter,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const SHARED_TOKEN = "test-token";

interface ClaimMeta {
  root_handoff_id: string;
  per_root_top3: { root_handoff_id: string; in_flight_count: number }[];
}

function makeDb(): Database {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return db;
}

function makeServices(db: Database): Services {
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/claim-telemetry-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-25T20:00:00.000Z"),
    uuid: (() => {
      let n = 0;
      return (): string => `evt-${String(++n)}`;
    })(),
  });
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

function seedApproved(
  db: Database,
  input: {
    handoff_id: string;
    ts: string;
    conversation_id: string;
    from: string;
    to: string;
    message: string;
    parent_handoff_id?: string | null;
  },
): void {
  new HandoffWriter({ db }).createApproved({
    handoff_id: input.handoff_id,
    ts: input.ts,
    project_id: null,
    conversation_id: input.conversation_id,
    from: input.from,
    to: input.to,
    to_role: null,
    message: input.message,
    triggered_by_event_id: null,
    resolved_by: "machine-test",
    resolved_at: input.ts,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: input.parent_handoff_id ?? null,
  });
}

test("single-chain claim emits event with one root in per_root_top3", async () => {
  const db = makeDb();
  const services = makeServices(db);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApproved(db, {
    handoff_id: "h-single",
    ts: "2026-04-25T19:00:00.000Z",
    conversation_id: "conv-1",
    from: "planner",
    to: "executor",
    message: "do it",
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "worker-1",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-single/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "worker-1" }),
    }),
  );

  expect(res.status).toBe(200);
  const rows = db
    .query<
      { kind: string; meta_json: string | null },
      []
    >("SELECT kind, meta_json FROM dispatch_events WHERE handoff_id = ?")
    .all("h-single");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind).toBe("claim");
  const meta = JSON.parse(rows[0]?.meta_json ?? "null") as ClaimMeta;
  expect(meta.root_handoff_id).toBe("h-single");
  expect(meta.per_root_top3).toEqual([{ root_handoff_id: "h-single", in_flight_count: 1 }]);
});

test("two-chain claim emits event with both roots in per_root_top3", async () => {
  const db = makeDb();
  const services = makeServices(db);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApproved(db, {
    handoff_id: "root-a",
    ts: "2026-04-25T19:00:00.000Z",
    conversation_id: "conv-a",
    from: "planner",
    to: "executor",
    message: "A",
  });
  seedApproved(db, {
    handoff_id: "a-child",
    ts: "2026-04-25T19:01:00.000Z",
    conversation_id: "conv-a",
    from: "planner",
    to: "executor",
    message: "A2",
    parent_handoff_id: "root-a",
  });
  seedApproved(db, {
    handoff_id: "root-b",
    ts: "2026-04-25T19:02:00.000Z",
    conversation_id: "conv-b",
    from: "planner",
    to: "executor",
    message: "B",
  });

  const { worker_token: tokenA } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "worker-a",
    fetcher: makeFetcher(fetchHandler),
  });
  const { worker_token: tokenB } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "worker-b",
    fetcher: makeFetcher(fetchHandler),
  });

  const claimA = await fetchHandler(
    new Request("http://x/handoffs/root-a/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ worker_id: "worker-a" }),
    }),
  );
  expect(claimA.status).toBe(200);

  const claimB = await fetchHandler(
    new Request("http://x/handoffs/root-b/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ worker_id: "worker-b" }),
    }),
  );

  expect(claimB.status).toBe(200);
  const rows = db
    .query<
      { meta_json: string | null },
      []
    >("SELECT meta_json FROM dispatch_events WHERE handoff_id = ? ORDER BY id ASC")
    .all("root-b");
  const meta = JSON.parse(rows[0]?.meta_json ?? "null") as ClaimMeta;
  expect(meta.root_handoff_id).toBe("root-b");
  expect(meta.per_root_top3).toEqual([
    { root_handoff_id: "root-a", in_flight_count: 1 },
    { root_handoff_id: "root-b", in_flight_count: 1 },
  ]);
});

test("lost claim race does NOT emit telemetry event", async () => {
  const db = makeDb();
  const services = makeServices(db);
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApproved(db, {
    handoff_id: "h-race",
    ts: "2026-04-25T19:00:00.000Z",
    conversation_id: "conv-race",
    from: "planner",
    to: "executor",
    message: "race",
  });
  db.run(
    `UPDATE handoffs SET status='dispatched', worker_id='other-worker' WHERE handoff_id='h-race'`,
  );

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "worker-1",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-race/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "worker-1" }),
    }),
  );

  expect(res.status).toBe(409);
  expect(services.dispatchEventLog.listByHandoff("h-race")).toHaveLength(0);
});
