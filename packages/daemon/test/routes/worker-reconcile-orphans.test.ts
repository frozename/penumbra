import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { workerReconcileOrphansRoute } from "@src/routes/worker-reconcile-orphans.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { OrphanHandoffRecoveryService } from "@src/services/orphan-handoff-recovery.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch (err) {
  void err;
}

interface RecoveryResult {
  requeued: number;
  exhausted: number;
  requeuedRowIds: string[];
  exhaustedRowIds: string[];
  _requeuedRows: unknown[];
  _exhaustedRows: unknown[];
}

interface ErrorBody {
  error: { code?: string; field_errors?: unknown };
}

interface ReconcileResultBody {
  requeued: number;
  exhausted: number;
  requeuedRowIds: string[];
  exhaustedRowIds: string[];
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Test mocks expose only the subset of OrphanHandoffRecoveryService that the route invokes.
// Centralizing the cast keeps the production type intact while satisfying the route signature.
function asRecoveryService(
  mock: Pick<OrphanHandoffRecoveryService, "runOnce">,
): OrphanHandoffRecoveryService {
  return mock as unknown as OrphanHandoffRecoveryService;
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
      return () => `e-${String(++n)}`;
    })(),
  });
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

// Placeholder recovery service used purely for routes that should never reach it (auth-rejected paths).
// A never-invoked placeholder may use one documented `{} as unknown as T` per the helper rule.
const PLACEHOLDER_RECOVERY = {} as unknown as OrphanHandoffRecoveryService;

test("POST /worker/reconcile-orphans requires worker_id", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const res = await workerReconcileOrphansRoute(req, services, PLACEHOLDER_RECOVERY);
  expect(res.status).toBe(400);
  const body = await readJson<ErrorBody>(res);
  expect(body.error.code).toBe("validation_error");
});

test("POST /worker/reconcile-orphans returns 400 invalid_json on missing body", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
  });
  const res = await workerReconcileOrphansRoute(req, services, PLACEHOLDER_RECOVERY);
  expect(res.status).toBe(400);
  const body = await readJson<ErrorBody>(res);
  expect(body.error.code).toBe("invalid_json");
});

test("POST /worker/reconcile-orphans returns 400 validation_error on malformed body (wrong types)", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/reconcile-orphans", {
    method: "POST",
    body: JSON.stringify({ worker_id: 123 }), // should be string
  });
  const res = await workerReconcileOrphansRoute(req, services, PLACEHOLDER_RECOVERY);
  expect(res.status).toBe(400);
  const body = await readJson<ErrorBody>(res);
  expect(body.error.code).toBe("validation_error");
  expect(body.error.field_errors).toBeDefined();
});

test("POST /worker/reconcile-orphans returns 500 recovery_failed on runOnce error", async () => {
  const services = tempServices();
  const token = "secret-token";
  const mockRecovery = asRecoveryService({
    runOnce: (_workerId?: string, _opts?: { workerKnownDead?: boolean }) => {
      throw new Error("database crash");
    },
  });
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: mockRecovery,
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w1",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "w1" }),
    }),
  );
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body).toEqual({ error: { code: "recovery_failed" } });
});

test("POST /worker/reconcile-orphans passes worker_id to runOnce", async () => {
  const services = tempServices();
  const token = "secret-token";

  let passedWorkerId: string | undefined;
  let passedOptions: { workerKnownDead?: boolean } | undefined;
  const mockRecovery = asRecoveryService({
    runOnce: (workerId?: string, opts?: { workerKnownDead?: boolean }): RecoveryResult => {
      passedWorkerId = workerId;
      passedOptions = opts;
      return {
        requeued: 4,
        exhausted: 2,
        requeuedRowIds: ["1"],
        exhaustedRowIds: ["2"],
        _requeuedRows: [],
        _exhaustedRows: [],
      };
    },
  });

  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: mockRecovery,
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "test-worker-123",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "test-worker-123" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    requeued: 4,
    exhausted: 2,
    requeuedRowIds: ["1"],
    exhaustedRowIds: ["2"],
  });
  expect(passedWorkerId).toBe("test-worker-123");
  expect(passedOptions).toEqual({ workerKnownDead: true });
});

test("POST /worker/reconcile-orphans auth boundary and service-unavailable", async () => {
  const services = tempServices();
  const token = "secret-token";

  const fetchHandler = createDaemonFetchHandler({ services, token });

  // 1. Without authz token -> 401
  const res401 = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      body: JSON.stringify({ worker_id: "w1" }),
    }),
  );
  expect(res401.status).toBe(401);

  // 2. With wrong authz token -> 401
  const res401Wrong = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: JSON.stringify({ worker_id: "w1" }),
    }),
  );
  expect(res401Wrong.status).toBe(401);

  // 3. Worker token + no recovery service -> 503 (503 guard in serve.ts fires before route)
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w1",
    fetcher: makeFetcher(fetchHandler),
  });
  const res503 = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "w1" }),
    }),
  );
  expect(res503.status).toBe(503);
  expect(await res503.json()).toEqual({ error: { code: "recovery_service_unavailable" } });

  // 4. Shared bearer + recovery service -> 403 (route runs, principal check fires)
  const mockRecovery = asRecoveryService({
    runOnce: (_workerId?: string, _opts?: { workerKnownDead?: boolean }): RecoveryResult => ({
      requeued: 1,
      exhausted: 0,
      requeuedRowIds: ["1"],
      exhaustedRowIds: [],
      _requeuedRows: [],
      _exhaustedRows: [],
    }),
  });
  const fetchHandlerWithRecovery = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: mockRecovery,
  });
  const res403 = await fetchHandlerWithRecovery(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ worker_id: "w1" }),
    }),
  );
  expect(res403.status).toBe(403);
  expect((await readJson<ErrorBody>(res403)).error.code).toBe("worker_token_required");

  // 5. Worker token + valid recovery service -> 200
  const { worker_token: wt2 } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w2",
    fetcher: makeFetcher(fetchHandlerWithRecovery),
  });
  const res200 = await fetchHandlerWithRecovery(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${wt2}` },
      body: JSON.stringify({ worker_id: "w2" }),
    }),
  );
  expect(res200.status).toBe(200);
  expect(await res200.json()).toEqual({
    requeued: 1,
    exhausted: 0,
    requeuedRowIds: ["1"],
    exhaustedRowIds: [],
  });
});

// --- Phase 4.2 principal enforcement tests ---

test("POST /worker/reconcile-orphans with shared bearer returns 403 worker_token_required", async () => {
  const services = tempServices();
  const token = "secret-token";
  const mockRecovery = asRecoveryService({
    runOnce: (_workerId?: string, _opts?: { workerKnownDead?: boolean }): RecoveryResult => ({
      requeued: 0,
      exhausted: 0,
      requeuedRowIds: [],
      exhaustedRowIds: [],
      _requeuedRows: [],
      _exhaustedRows: [],
    }),
  });
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: mockRecovery,
  });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(403);
  const body = await readJson<ErrorBody>(res);
  expect(body.error.code).toBe("worker_token_required");
});

test("POST /worker/reconcile-orphans with worker token + mismatched body worker_id returns 403 worker_id_mismatch", async () => {
  const services = tempServices();
  const token = "secret-token";
  const mockRecovery = asRecoveryService({
    runOnce: (_workerId?: string, _opts?: { workerKnownDead?: boolean }): RecoveryResult => ({
      requeued: 0,
      exhausted: 0,
      requeuedRowIds: [],
      exhaustedRowIds: [],
      _requeuedRows: [],
      _exhaustedRows: [],
    }),
  });
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: mockRecovery,
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );
  expect(res.status).toBe(403);
  const body = await readJson<ErrorBody>(res);
  expect(body.error.code).toBe("worker_id_mismatch");
});

test("POST /worker/reconcile-orphans with worker token + matching body worker_id reaches the recovery service (200)", async () => {
  const services = tempServices();
  const token = "secret-token";

  let calledWith: string | undefined;
  const mockRecovery = asRecoveryService({
    runOnce: (workerId?: string, _opts?: { workerKnownDead?: boolean }): RecoveryResult => {
      calledWith = workerId;
      return {
        requeued: 2,
        exhausted: 1,
        requeuedRowIds: ["r1", "r2"],
        exhaustedRowIds: ["e1"],
        _requeuedRows: [],
        _exhaustedRows: [],
      };
    },
  });
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: mockRecovery,
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await readJson<ReconcileResultBody>(res)).toEqual({
    requeued: 2,
    exhausted: 1,
    requeuedRowIds: ["r1", "r2"],
    exhaustedRowIds: ["e1"],
  });
  expect(calledWith).toBe("W-A");
});

test("POST /worker/reconcile-orphans without Authorization returns 401", async () => {
  const services = tempServices();
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(401);
  const body = await readJson<ErrorBody>(res);
  expect(body.error.code).toBe("unauthorized");
});
