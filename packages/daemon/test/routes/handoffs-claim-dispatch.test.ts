import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { registerWorkerForTest } from "../../test-utils.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch { /* already loaded */ }

const SHARED_TOKEN = "shared-sec";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/claim-dispatch-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
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

function seedApprovedHandoff(services: Services, handoff_id: string): void {
  services.handoffWriter.createApproved({
    handoff_id,
    ts: "2026-05-21T10:00:00.000Z",
    project_id: null,
    conversation_id: `conv-${handoff_id}`,
    from: "planner",
    to: "worker",
    to_role: null,
    message: "go",
    triggered_by_event_id: null,
    resolved_by: "machine-test",
    resolved_at: "2026-05-21T10:00:00.000Z",
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: null,
    parent_handoff_id: null,
  });
}

test("/handoffs/:id/claim with shared bearer returns 403 worker_token_required", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-1");

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-1/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${SHARED_TOKEN}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(403);
  const body = await res.json();
  expect((body as any).error.code).toBe("worker_token_required");

  const row = services.db
    .query<{ status: string; worker_id: string | null }, [string]>(
      "SELECT status, worker_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-1");
  expect(row?.status).toBe("approved");
  expect(row?.worker_id).toBeNull();
});

test("/handoffs/:id/claim with worker token + mismatched body returns 403 worker_id_mismatch", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-2");

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-2/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );
  expect(res.status).toBe(403);
  const body = await res.json();
  expect((body as any).error.code).toBe("worker_id_mismatch");

  const row = services.db
    .query<{ status: string }, [string]>(
      "SELECT status FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-2");
  expect(row?.status).toBe("approved");
});

test("/handoffs/:id/claim with worker token + matching body claims successfully", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-3");

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-3/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect((body as any).status).toBe("dispatched");

  const row = services.db
    .query<{ status: string; worker_id: string | null }, [string]>(
      "SELECT status, worker_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-3");
  expect(row?.status).toBe("dispatched");
  expect(row?.worker_id).toBe("W-A");
});

test("Claim collision: W-A claims; W-B token + W-B body cannot steal", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-4");

  const { worker_token: tokenA } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-A",
    fetcher: makeFetcher(fetchHandler),
  });
  const { worker_token: tokenB } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: SHARED_TOKEN,
    worker_id: "W-B",
    fetcher: makeFetcher(fetchHandler),
  });

  const resA = await fetchHandler(
    new Request("http://x/handoffs/h-4/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(resA.status).toBe(200);

  const resB = await fetchHandler(
    new Request("http://x/handoffs/h-4/claim", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ worker_id: "W-B" }),
    }),
  );
  expect(resB.status).toBe(409);

  const row = services.db
    .query<{ worker_id: string | null }, [string]>(
      "SELECT worker_id FROM handoffs WHERE handoff_id = ?",
    )
    .get("h-4");
  expect(row?.worker_id).toBe("W-A");
});

test("/handoffs/:id/claim without Authorization returns 401", async () => {
  const services = tempServices();
  const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
  seedApprovedHandoff(services, "h-5");

  const res = await fetchHandler(
    new Request("http://x/handoffs/h-5/claim", {
      method: "POST",
      body: JSON.stringify({ worker_id: "W-A" }),
    }),
  );
  expect(res.status).toBe(401);
  const body = await res.json();
  expect((body as any).error.code).toBe("unauthorized");
});
