import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { workerReconcileOrphansRoute } from "../../src/routes/worker-reconcile-orphans.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/sqlite3.dylib");
  }
} catch {
  // ignore
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/reconcile-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-20T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

test("POST /worker/reconcile-orphans requires worker_id", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await workerReconcileOrphansRoute(req, services, {} as any);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect((body as any).error.code).toBe("validation_error");
});

test("POST /worker/reconcile-orphans passes worker_id to runOnce", async () => {
  const services = tempServices();
  
  let passedWorkerId: string | undefined = undefined;
  const mockRecovery = {
    runOnce: (workerId?: string) => {
      passedWorkerId = workerId;
      return { requeued: 4, exhausted: 2 };
    }
  } as any;

  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({ worker_id: "test-worker-123" }),
  });
  
  const res = await workerReconcileOrphansRoute(req, services, mockRecovery);
  if(res.status !== 200) console.log(await res.json()); expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ requeued: 4, exhausted: 2 });
  expect(passedWorkerId).toBe("test-worker-123");
});
