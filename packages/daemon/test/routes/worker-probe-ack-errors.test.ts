import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { registerWorkerForTest } from "@penumbra/daemon/test-utils";
import { Database } from "bun:sqlite";
import { expect, test, vi } from "bun:test";

import { createDaemonFetchHandler } from "@src/serve.js";
import { WorkerHealthProbe } from "@src/services/worker-health-probe.js";

interface ErrorBody {
  error: {
    code: string;
    message?: string;
    field_errors?: { path: unknown[]; message: string }[];
  };
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  return buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/worker-probe-ack-errors-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-05-24T00:00:00Z"),
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `e-${String(n)}`;
      };
    })(),
  });
}

function makeFetcher(handler: (req: Request) => Promise<Response>): typeof fetch {
  const impl = (input: string | Request | URL, init?: RequestInit): Promise<Response> =>
    handler(new Request(input as string, init));
  return Object.assign(impl, { preconnect: (): void => undefined });
}

function stubProbe(
  services: Services,
  recordAck: (worker_id: string, probe_id: string) => boolean,
): WorkerHealthProbe {
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 0,
    log: services.log,
    controller: { onSignal: (): void => undefined },
  });
  probe.recordAck = recordAck;
  return probe;
}

function realProbe(services: Services): WorkerHealthProbe {
  return new WorkerHealthProbe({
    services,
    intervalMs: 0,
    log: services.log,
    controller: { onSignal: (): void => undefined },
  });
}

async function setup(workerHealthProbe: WorkerHealthProbe | undefined): Promise<{
  fetchHandler: (req: Request) => Promise<Response>;
  sharedToken: string;
  workerToken: string;
}> {
  const services = tempServices();
  const sharedToken = "secret-token";
  const fetchHandler = createDaemonFetchHandler({
    services,
    token: sharedToken,
    ...(workerHealthProbe ? { workerHealthProbe } : {}),
  });
  const { worker_token } = await registerWorkerForTest({
    baseUrl: "http://x",
    sharedBearer: sharedToken,
    worker_id: "w1",
    fetcher: makeFetcher(fetchHandler),
  });
  return { fetchHandler, sharedToken, workerToken: worker_token };
}

function ack(
  fetchHandler: (req: Request) => Promise<Response>,
  bearer: string,
  body: string,
): Promise<Response> {
  return fetchHandler(
    new Request("http://x/worker/probe-ack", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body,
    }),
  );
}

test("returns 503 worker_health_probe_unavailable when the probe is not wired", async () => {
  const { fetchHandler, workerToken } = await setup(undefined);

  const res = await ack(
    fetchHandler,
    workerToken,
    JSON.stringify({ worker_id: "w1", probe_id: "p-1" }),
  );

  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: { code: "worker_health_probe_unavailable" } });
});

test("returns 400 invalid_json and skips recordAck for a non-JSON body", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => true);
  const { fetchHandler, workerToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(fetchHandler, workerToken, "not json");

  expect(res.status).toBe(400);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe("invalid_json");
  expect(recordAck).not.toHaveBeenCalled();
});

test("returns 400 validation_error for a missing probe_id and skips recordAck", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => true);
  const { fetchHandler, workerToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(fetchHandler, workerToken, JSON.stringify({ worker_id: "w1" }));

  expect(res.status).toBe(400);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe("validation_error");
  expect(body.error.message).toBe("body failed schema validation");
  const paths = (body.error.field_errors ?? []).map((fe) => fe.path);
  expect(paths).toContainEqual(["probe_id"]);
  expect(recordAck).not.toHaveBeenCalled();
});

test("returns 400 validation_error for an empty worker_id", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => true);
  const { fetchHandler, workerToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(
    fetchHandler,
    workerToken,
    JSON.stringify({ worker_id: "", probe_id: "p-1" }),
  );

  expect(res.status).toBe(400);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe("validation_error");
  const paths = (body.error.field_errors ?? []).map((fe) => fe.path);
  expect(paths).toContainEqual(["worker_id"]);
  expect(recordAck).not.toHaveBeenCalled();
});

test("validates the body before the principal check", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => true);
  const { fetchHandler, workerToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(fetchHandler, workerToken, JSON.stringify({ worker_id: "someone-else" }));

  expect(res.status).toBe(400);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe("validation_error");
  expect(recordAck).not.toHaveBeenCalled();
});

test("rejects a shared-bearer caller with 403 worker_token_required", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => true);
  const { fetchHandler, sharedToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(
    fetchHandler,
    sharedToken,
    JSON.stringify({ worker_id: "w1", probe_id: "p-1" }),
  );

  expect(res.status).toBe(403);
  const body = (await res.json()) as ErrorBody;
  expect(body.error.code).toBe("worker_token_required");
  expect(recordAck).not.toHaveBeenCalled();
});

test("returns 404 probe_id_unknown when recordAck returns false", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => false);
  const { fetchHandler, workerToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(
    fetchHandler,
    workerToken,
    JSON.stringify({ worker_id: "w1", probe_id: "p-1" }),
  );

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "probe_id_unknown" } });
  expect(recordAck).toHaveBeenCalledTimes(1);
  expect(recordAck).toHaveBeenCalledWith("w1", "p-1");
});

test("returns 404 probe_id_unknown for a real probe that never issued the id", async () => {
  const services = tempServices();
  const { fetchHandler, workerToken } = await setup(realProbe(services));

  const res = await ack(
    fetchHandler,
    workerToken,
    JSON.stringify({ worker_id: "w1", probe_id: "never-issued" }),
  );

  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "probe_id_unknown" } });
});

test("returns 200 with an empty object body when recordAck returns true", async () => {
  const services = tempServices();
  const recordAck = vi.fn(() => true);
  const { fetchHandler, workerToken } = await setup(stubProbe(services, recordAck));

  const res = await ack(
    fetchHandler,
    workerToken,
    JSON.stringify({ worker_id: "w1", probe_id: "p-1" }),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});
