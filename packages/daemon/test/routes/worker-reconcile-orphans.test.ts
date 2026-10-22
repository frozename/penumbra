import {
  buildServices,
  type HandoffRow,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";

import { workerReconcileOrphansRoute } from "@src/routes/worker-reconcile-orphans.js";
import { createDaemonFetchHandler } from "@src/serve.js";
import { OrphanHandoffRecoveryService } from "@src/services/orphan-handoff-recovery.js";
import { countProviderInFlight } from "@src/services/provider-concurrency.js";

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
  _requeuedRows: HandoffRow[];
  _exhaustedRows: HandoffRow[];
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

test("POST /worker/reconcile-orphans forwards claimed_before to runOnce", async () => {
  const services = tempServices();
  const token = "secret-token";

  let passedOptions: { workerKnownDead?: boolean; claimedBefore?: string } | undefined;
  const mockRecovery = asRecoveryService({
    runOnce: (
      _workerId?: string,
      opts?: { workerKnownDead?: boolean; claimedBefore?: string },
    ): RecoveryResult => {
      passedOptions = opts;
      return {
        requeued: 1,
        exhausted: 0,
        requeuedRowIds: ["1"],
        exhaustedRowIds: [],
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
    worker_id: "w-bound",
    fetcher: makeFetcher(fetchHandler),
  });

  const bound = "2026-10-06T12:00:00.000Z";
  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "w-bound", claimed_before: bound }),
    }),
  );
  expect(res.status).toBe(200);
  expect(passedOptions).toEqual({ workerKnownDead: true, claimedBefore: bound });
});

test("POST /worker/reconcile-orphans without claimed_before leaves opts unchanged", async () => {
  const services = tempServices();
  const token = "secret-token";

  let passedOptions: { workerKnownDead?: boolean; claimedBefore?: string } | undefined;
  const mockRecovery = asRecoveryService({
    runOnce: (
      _workerId?: string,
      opts?: { workerKnownDead?: boolean; claimedBefore?: string },
    ): RecoveryResult => {
      passedOptions = opts;
      return {
        requeued: 0,
        exhausted: 0,
        requeuedRowIds: [],
        exhaustedRowIds: [],
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
    worker_id: "w-plain",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "w-plain" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(passedOptions).toEqual({ workerKnownDead: true });
});

test.each([
  ["a non-date string", "soon"],
  ["a number", 42],
  ["a date-only string", "2026-10-06"],
])(
  "POST /worker/reconcile-orphans rejects malformed claimed_before (%s) with 400",
  async (_label, claimedBefore) => {
    const services = tempServices();
    const token = "secret-token";
    let called = false;
    const mockRecovery = asRecoveryService({
      runOnce: (): RecoveryResult => {
        called = true;
        return {
          requeued: 0,
          exhausted: 0,
          requeuedRowIds: [],
          exhaustedRowIds: [],
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
      worker_id: "w-bad",
      fetcher: makeFetcher(fetchHandler),
    });

    const res = await fetchHandler(
      new Request("http://x/worker/reconcile-orphans", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ worker_id: "w-bad", claimed_before: claimedBefore }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<ErrorBody>(res);
    expect(body.error.code).toBe("validation_error");
    expect(called).toBe(false);
  },
);

test("POST /worker/reconcile-orphans rejects unknown body keys with 400 (fail closed)", async () => {
  const services = tempServices();
  const token = "secret-token";
  let called = false;
  const mockRecovery = asRecoveryService({
    runOnce: (): RecoveryResult => {
      called = true;
      return {
        requeued: 0,
        exhausted: 0,
        requeuedRowIds: [],
        exhaustedRowIds: [],
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
    worker_id: "w-xtra",
    fetcher: makeFetcher(fetchHandler),
  });

  // A worker-side typo (claimedBefore) must not silently disable the filter.
  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "w-xtra", claimedBefore: "2026-10-06T12:00:00.000Z" }),
    }),
  );
  expect(res.status).toBe(400);
  expect(called).toBe(false);
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

test("POST /worker/reconcile-orphans resolves recovery attached to services after handler creation", async () => {
  const services: Services & { orphanHandoffRecovery?: OrphanHandoffRecoveryService } =
    tempServices();
  const handler = createDaemonFetchHandler({ services, token: "test-token" });
  try {
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: "test-token",
      worker_id: "w-late",
      fetcher: makeFetcher(handler),
    });
    const request = (): Request =>
      new Request("http://x/worker/reconcile-orphans", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ worker_id: "w-late", claimed_before: "2026-10-07T12:00:00.000Z" }),
      });
    expect((await handler(request())).status).toBe(503);
    services.orphanHandoffRecovery = new OrphanHandoffRecoveryService(services, { intervalMs: 0 });
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requeued: 0,
      exhausted: 0,
      requeuedRowIds: [],
      exhaustedRowIds: [],
    });
  } finally {
    services.db.close();
  }
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

// Mirrors sweepers/stale-handoff.ts: the force-fail and the sweeper dispatch.end row
// are written in one transaction.
function seedSweptDispatch(
  services: Services,
  handoff_id: string,
  worker_id: string,
  sweptAt: string,
): void {
  services.handoffWriter.createApproved({
    handoff_id,
    ts: "2026-05-19T23:00:00.000Z",
    project_id: null,
    conversation_id: `conv-${handoff_id}`,
    from: "planner",
    to: "claude-a",
    to_role: null,
    message: "go",
    triggered_by_event_id: null,
    resolved_by: "machine-test",
    resolved_at: "2026-05-19T23:00:00.000Z",
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
    dispatch_kind: null,
    workflow_run_id: null,
  });
  expect(services.handoffWriter.claimDispatch(handoff_id, worker_id)).toBe(true);
  services.db.transaction(() => {
    expect(
      services.handoffWriter.markFailed(handoff_id, {
        reason: "stale_force_resolve",
        resolved_by: "stale-handoff-sweeper",
        ts: sweptAt,
      }),
    ).toBe(true);
    services.db.run(
      `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json) VALUES (?, NULL, 'sweeper', 'dispatch.end', ?, NULL)`,
      [handoff_id, sweptAt],
    );
  })();
}

test("POST /worker/reconcile-orphans releases the caller's drain holds swept before claimed_before (#236)", async () => {
  const services = tempServices();
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: asRecoveryService({
      runOnce: (): RecoveryResult => ({
        requeued: 0,
        exhausted: 0,
        requeuedRowIds: [],
        exhaustedRowIds: [],
        _requeuedRows: [],
        _exhaustedRows: [],
      }),
    }),
  });
  // Both workers heartbeat, so only a reconcile can release their holds early.
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w-restarted",
    fetcher: makeFetcher(fetchHandler),
  });
  await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w-peer",
    fetcher: makeFetcher(fetchHandler),
  });
  seedSweptDispatch(services, "h-own", "w-restarted", "2026-05-19T23:30:00.000Z");
  seedSweptDispatch(services, "h-peer", "w-peer", "2026-05-19T23:30:00.000Z");
  seedSweptDispatch(services, "h-own-after-boot", "w-restarted", "2026-05-19T23:50:00.000Z");
  const inFlight = (): number => countProviderInFlight(services, ["claude-a"]);
  const releasedBy = (handoff_id: string): (string | null)[] =>
    services.dispatchEventLog
      .listByHandoff(handoff_id)
      .filter((event) => event.kind === "worker.recovery.drain_released")
      .map((event) => event.worker_id);
  const reconcile = (body: Record<string, string>): Promise<Response> =>
    fetchHandler(
      new Request("http://x/worker/reconcile-orphans", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify(body),
      }),
    );
  expect(inFlight()).toBe(3);

  expect((await reconcile({ worker_id: "w-restarted" })).status).toBe(200);
  expect(inFlight()).toBe(3);

  const res = await reconcile({
    worker_id: "w-restarted",
    claimed_before: "2026-05-19T19:40:00.000-04:00",
  });

  expect(res.status).toBe(200);
  expect(inFlight()).toBe(2);
  expect(releasedBy("h-own")).toEqual(["w-restarted"]);
  expect(releasedBy("h-peer")).toEqual([]);
  expect(releasedBy("h-own-after-boot")).toEqual([]);
});

test("POST /worker/reconcile-orphans keeps its recovery result when the drain-hold release fails (#236)", async () => {
  const services = tempServices();
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    orphanHandoffRecovery: asRecoveryService({
      runOnce: (): RecoveryResult => ({
        requeued: 1,
        exhausted: 0,
        requeuedRowIds: ["h-orphan"],
        exhaustedRowIds: [],
        _requeuedRows: [],
        _exhaustedRows: [],
      }),
    }),
  });
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w-restarted",
    fetcher: makeFetcher(fetchHandler),
  });
  seedSweptDispatch(services, "h-own", "w-restarted", "2026-05-19T23:30:00.000Z");
  const recordBatch = spyOn(services.dispatchEventLog, "recordBatch").mockImplementation(
    (): never => {
      throw new Error("disk I/O error");
    },
  );
  const warn = spyOn(services.log, "warn").mockImplementation((): void => undefined);

  const res = await fetchHandler(
    new Request("http://x/worker/reconcile-orphans", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({
        worker_id: "w-restarted",
        claimed_before: "2026-05-19T23:40:00.000Z",
      }),
    }),
  );

  expect(res.status).toBe(200);
  expect(await readJson<ReconcileResultBody>(res)).toEqual({
    requeued: 1,
    exhausted: 0,
    requeuedRowIds: ["h-orphan"],
    exhaustedRowIds: [],
  });
  expect(recordBatch).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ worker_id: "w-restarted" }),
    "worker reconcile drain-hold release failed",
  );
  expect(countProviderInFlight(services, ["claude-a"])).toBe(1);
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
