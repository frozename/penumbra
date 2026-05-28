import { expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { TestEmbedder } from "@penumbra/core/testing";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { createDaemonFetchHandler } from "../../src/serve.js";
import { registerWorkerForTest } from "../../test-utils.js";

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/worker-probe-ack-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-24T00:00:00Z"),
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

test("POST /worker/probe-ack records ACK and returns 200", async () => {
  const services = tempServices();
  const token = "secret-token";
  let calledWith: { worker_id: string; probe_id: string } | null = null;
  const recordAck = vi.fn((worker_id: string, probe_id: string) => {
    calledWith = { worker_id, probe_id };
    return true;
  });
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    workerHealthProbe: {
      ...services,
      recordAck: (worker_id: string, probe_id: string) => recordAck(worker_id, probe_id),
    } as any,
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w1",
    fetcher: makeFetcher(fetchHandler),
  });

  const res = await fetchHandler(
    new Request("http://x/worker/probe-ack", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "w1", probe_id: "p-1" }),
    }),
  );

  expect(res.status).toBe(200);
  expect(recordAck).toHaveBeenCalledTimes(1);
  expect(calledWith).toEqual({ worker_id: "w1", probe_id: "p-1" });
});

test("POST /worker/probe-ack rejects mismatched worker auth", async () => {
  const services = tempServices();
  const token = "secret-token";
  const fetchHandler = createDaemonFetchHandler({
    services,
    token,
    workerHealthProbe: {
      ...services,
      recordAck: () => {
        throw new Error("should not be called");
      },
    } as any,
  });

  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: token,
    worker_id: "w1",
    fetcher: makeFetcher(fetchHandler),
  });

  const wrong = await fetchHandler(
    new Request("http://x/worker/probe-ack", {
      method: "POST",
      headers: { authorization: `Bearer ${worker_token}` },
      body: JSON.stringify({ worker_id: "wrong-worker", probe_id: "p-1" }),
    }),
  );
  expect(wrong.status).toBe(403);
  expect(((await wrong.json()) as any).error.code).toBe("worker_id_mismatch");
});
