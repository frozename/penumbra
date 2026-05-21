import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { workerReconcileOrphansRoute } from "../../src/routes/worker-reconcile-orphans.js";
import { createDaemonFetchHandler } from "../../src/serve.js";

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

test("POST /worker/reconcile-orphans returns 400 invalid_json on missing body", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
  });
  const res = await workerReconcileOrphansRoute(req, services, {} as any);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect((body as any).error.code).toBe("invalid_json");
});

test("POST /worker/reconcile-orphans returns 400 validation_error on malformed body (wrong types)", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({ worker_id: 123 }), // should be string
  });
  const res = await workerReconcileOrphansRoute(req, services, {} as any);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect((body as any).error.code).toBe("validation_error");
  expect((body as any).error.field_errors).toBeDefined();
});

test("POST /worker/reconcile-orphans returns 500 recovery_failed on runOnce error", async () => {
  const services = tempServices();
  const mockRecovery = {
    runOnce: () => {
      throw new Error("database crash");
    }
  } as any;
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({ worker_id: "w1" }),
  });
  const res = await workerReconcileOrphansRoute(req, services, mockRecovery);
  expect(res.status).toBe(500);
  const body = await res.json();
  // Route redacts internal error messages — surface only the stable error code.
  expect(body).toEqual({ error: { code: "recovery_failed" } });
});

test("POST /worker/reconcile-orphans passes worker_id to runOnce", async () => {
  const services = tempServices();
  
  let passedWorkerId: string | undefined;
  const mockRecovery = {
    runOnce: (workerId?: string) => {
      passedWorkerId = workerId;
      return { requeued: 4, exhausted: 2, requeuedRowIds: ['1'], exhaustedRowIds: ['2'], _requeuedRows: [], _exhaustedRows: [] };
    }
  } as any;

  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({ worker_id: "test-worker-123" }),
  });
  
  const res = await workerReconcileOrphansRoute(req, services, mockRecovery);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ requeued: 4, exhausted: 2, requeuedRowIds: ['1'], exhaustedRowIds: ['2'] });
  expect(passedWorkerId).toBe("test-worker-123");
});

test("POST /worker/reconcile-orphans auth boundary and service-unavailable", async () => {
  const services = tempServices();
  const token = "secret-token";
  
  // 1. Without authz token -> 401
  const fetchHandler = createDaemonFetchHandler({ services, token });
  const res401 = await fetchHandler(new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res401.status).toBe(401);

  // 2. With wrong authz token -> 401
  const res401Wrong = await fetchHandler(new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res401Wrong.status).toBe(401);

  // 3. With auth but recovery service missing -> 503
  const res503 = await fetchHandler(new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res503.status).toBe(503);
  expect(await res503.text()).toBe("recovery service unavailable");

  // 4. Happy path through fetch handler
  const mockRecovery = {
    runOnce: () => ({ requeued: 1, exhausted: 0, requeuedRowIds: ['1'], exhaustedRowIds: [], _requeuedRows: [], _exhaustedRows: [] })
  } as any;
  const fetchHandlerWithRecovery = createDaemonFetchHandler({ services, token, orphanHandoffRecovery: mockRecovery });
  const res200 = await fetchHandlerWithRecovery(new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res200.status).toBe(200);
  expect(await res200.json()).toEqual({ requeued: 1, exhausted: 0, requeuedRowIds: ['1'], exhaustedRowIds: [] });
});
