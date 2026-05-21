import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { workerHeartbeatRoute } from "../../src/routes/worker-heartbeat.js";
import { WatchdogService } from "../../src/services/watchdog.js";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { registerWorkerForTest } from "../../test-utils.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/heartbeat-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-26T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    handler(new Request(input as string, init))) as typeof fetch;
}

test("POST /worker/heartbeat returns 200 and records heartbeat", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "test-worker-1",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${worker_token}` },
    body: JSON.stringify({ worker_id: "test-worker-1" }),
  }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  const map = (watchdog as any).lastHeartbeats as Map<string, number>;
  expect(map.has("test-worker-1")).toBe(true);
  expect(services.dispatchEventLog.listByHandoff("").some((event) => (
    event.kind === "heartbeat.received" && event.worker_id === "test-worker-1"
  ))).toBe(true);
});

test("POST /worker/heartbeat returns 400 invalid_json on missing body", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/heartbeat", {
    method: "POST",
  });
  const res = await workerHeartbeatRoute(req, services);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect((body as any).error.code).toBe("invalid_json");
});

test("POST /worker/heartbeat returns 400 validation_error on missing worker_id", async () => {
  const services = tempServices();
  const req = new Request("http://x/worker/heartbeat", {
    method: "POST",
    body: JSON.stringify({ wrong_field: "test" }),
  });
  const res = await workerHeartbeatRoute(req, services);
  expect(res.status).toBe(400);
  const body = await res.json();
  expect((body as any).error.code).toBe("validation_error");
});

test("POST /worker/heartbeat is idempotent for same worker", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "test-worker-2",
    fetcher: makeFetcher(fetchHandler),
  });

  // First heartbeat
  await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${worker_token}` },
    body: JSON.stringify({ worker_id: "test-worker-2" }),
  }));

  const map = (watchdog as any).lastHeartbeats as Map<string, number>;
  const time1 = map.get("test-worker-2");

  await new Promise(resolve => setTimeout(resolve, 5));

  await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${worker_token}` },
    body: JSON.stringify({ worker_id: "test-worker-2" }),
  }));

  expect(map.size).toBe(1);
  const time2 = map.get("test-worker-2");
  expect(time2).toBeGreaterThanOrEqual(time1!);
});

test("POST /worker/heartbeat auth boundary", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const token = "secret-token";

  const fetchHandler = createDaemonFetchHandler({ services, token });

  // 1. Without authz token -> 401
  const res401 = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res401.status).toBe(401);

  // 2. Shared bearer -> 403 worker_token_required (no longer accepted for heartbeat)
  const res403 = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res403.status).toBe(403);
  expect((await res403.json() as any).error.code).toBe("worker_token_required");

  // 3. Worker bearer + matching worker_id -> 200
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w1",
    fetcher: makeFetcher(fetchHandler),
  });

  const res200 = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${worker_token}` },
    body: JSON.stringify({ worker_id: "w1" }),
  }));
  expect(res200.status).toBe(200);
  expect(await res200.json()).toEqual({ ok: true });

  const map = (watchdog as any).lastHeartbeats as Map<string, number>;
  expect(map.has("w1")).toBe(true);
});

// --- Phase 4.1 principal enforcement tests ---

test("POST /worker/heartbeat with shared bearer returns 403 worker_token_required", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const res = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ worker_id: "W-A" }),
  }));
  expect(res.status).toBe(403);
  const body = await res.json();
  expect((body as any).error.code).toBe("worker_token_required");
});

test("POST /worker/heartbeat with worker token + mismatched body worker_id returns 403 worker_id_mismatch", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${worker_token}` },
    body: JSON.stringify({ worker_id: "W-B" }),
  }));
  expect(res.status).toBe(403);
  const body = await res.json();
  expect((body as any).error.code).toBe("worker_id_mismatch");
});

test("POST /worker/heartbeat with worker token + matching body worker_id returns 200 and updates last_seen_at", async () => {
  const services = tempServices();
  const watchdog = new WatchdogService(services);
  (services as any).watchdog = watchdog;
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  await new Promise(resolve => setTimeout(resolve, 5));
  const t1 = Date.now();

  const res = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${worker_token}` },
    body: JSON.stringify({ worker_id: "W-A" }),
  }));
  expect(res.status).toBe(200);

  const token_hash = createHash("sha256").update(worker_token).digest("hex");
  const row = services.db
    .query<{ last_seen_at: number }, [string]>(
      "SELECT last_seen_at FROM worker_tokens WHERE token_hash = ?",
    )
    .get(token_hash);
  expect(row).not.toBeNull();
  expect(row!.last_seen_at).toBeGreaterThanOrEqual(t1);
});

test("POST /worker/heartbeat without Authorization header returns 401 (not 403)", async () => {
  const services = tempServices();
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({ services, token });

  const res = await fetchHandler(new Request("http://x/worker/heartbeat", {
    method: "POST",
    body: JSON.stringify({ worker_id: "W-A" }),
  }));
  expect(res.status).toBe(401);
  const body = await res.json();
  expect((body as any).error.code).toBe("unauthorized");
});
