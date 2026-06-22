import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createDaemonFetchHandler } from "../../src/serve.js";
import { registerWorkerForTest } from "../../test-utils.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

interface ErrorResponse {
  error: {
    code: string;
  };
}

const SHARED_TOKEN = "shared-sec";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/terminal-cas-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-21T10:00:00Z"),
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

function seedDispatched(services: Services, worker_id: string, handoff_id: string): void {
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

  services.db.run("UPDATE handoffs SET status = 'dispatched', worker_id = ? WHERE handoff_id = ?", [
    worker_id,
    handoff_id,
  ]);
}

describe("/handoffs/:id/complete terminal CAS", () => {
  test("worker principal + omitted body worker_id: completes with expected = principal.worker_id", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-A", "h-1");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-1");
    expect(row?.status).toBe("completed");
  });

  test("worker principal + body worker_id matching principal: same 200 result", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-A", "h-1");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ worker_id: "W-A" }),
      }),
    );
    expect(res.status).toBe(200);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-1");
    expect(row?.status).toBe("completed");
  });

  test("worker principal + body worker_id disagreeing with principal: 403 worker_id_mismatch, no CAS", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-A", "h-1");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ worker_id: "W-B" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("worker_id_mismatch");

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-1");
    expect(row?.status).toBe("dispatched");
  });

  test("worker principal trying to terminate another worker's handoff: writer CAS rejects", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-B", "h-B");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-B/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(409);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-B");
    expect(row?.status).toBe("dispatched");
  });

  test("shared principal + omitted body worker_id: admin force-terminate (200, no expected_worker_id check)", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

    seedDispatched(services, "W-X", "h-X");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-X/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-X");
    expect(row?.status).toBe("completed");
  });

  test("shared principal + body worker_id present: uses body as expected_worker_id", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

    seedDispatched(services, "W-Y", "h-Y");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-Y/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify({ worker_id: "W-Y" }),
      }),
    );
    expect(res.status).toBe(200);

    seedDispatched(services, "W-Z", "h-Z");
    const resFail = await fetchHandler(
      new Request("http://x/handoffs/h-Z/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify({ worker_id: "W-A" }),
      }),
    );
    expect(resFail.status).toBe(409);
  });

  test("no Authorization → 401", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/complete", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("/handoffs/:id/fail terminal CAS", () => {
  test("worker principal + omitted body worker_id: fails with expected = principal.worker_id", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-A", "h-1");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ reason: "broken" }),
      }),
    );
    expect(res.status).toBe(200);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-1");
    expect(row?.status).toBe("failed");
  });

  test("worker principal + body worker_id matching principal: same 200 result", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-A", "h-1");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ reason: "broken", worker_id: "W-A" }),
      }),
    );
    expect(res.status).toBe(200);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-1");
    expect(row?.status).toBe("failed");
  });

  test("worker principal + body worker_id disagreeing with principal: 403 worker_id_mismatch, no CAS", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "W-A", "h-1");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ reason: "broken", worker_id: "W-B" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe("worker_id_mismatch");

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-1");
    expect(row?.status).toBe("dispatched");
  });

  test("worker principal trying to terminate another worker's handoff: writer CAS rejects", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const { worker_token } = await registerWorkerForTest({
      baseUrl: "http://x",
      sharedBearer: SHARED_TOKEN,
      worker_id: "W-A",
      fetcher: makeFetcher(fetchHandler),
    });

    seedDispatched(services, "WPB", "h-B");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-B/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${worker_token}` },
        body: JSON.stringify({ reason: "broken" }),
      }),
    );
    expect(res.status).toBe(409);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-B");
    expect(row?.status).toBe("dispatched");
  });

  test("shared principal + omitted body worker_id: admin force-terminate (200, no expected_worker_id check)", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

    seedDispatched(services, "W-X", "h-X");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-X/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify({ reason: "broken" }),
      }),
    );
    expect(res.status).toBe(200);

    const row = services.db
      .query<{ status: string }, [string]>("SELECT status FROM handoffs WHERE handoff_id = ?")
      .get("h-X");
    expect(row?.status).toBe("failed");
  });

  test("shared principal + body worker_id present: uses body as expected_worker_id", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });

    seedDispatched(services, "W-Y", "h-Y");

    const res = await fetchHandler(
      new Request("http://x/handoffs/h-Y/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify({ reason: "broken", worker_id: "W-Y" }),
      }),
    );
    expect(res.status).toBe(200);

    seedDispatched(services, "W-Z", "h-Z");
    const resFail = await fetchHandler(
      new Request("http://x/handoffs/h-Z/fail", {
        method: "POST",
        headers: { authorization: `Bearer ${SHARED_TOKEN}` },
        body: JSON.stringify({ reason: "broken", worker_id: "W-A" }),
      }),
    );
    expect(resFail.status).toBe(409);
  });

  test("no Authorization → 401", async () => {
    const services = tempServices();
    const fetchHandler = createDaemonFetchHandler({ services, token: SHARED_TOKEN });
    const res = await fetchHandler(
      new Request("http://x/handoffs/h-1/fail", {
        method: "POST",
        body: JSON.stringify({ reason: "broken" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
