import { expect, test, mock } from "bun:test";
import { createHttpWorkerManager } from "../../src/maestro/worker-manager-http.js";

test("HTTP worker manager relays injects to the worker route", async () => {
  const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const manager = createHttpWorkerManager({
    workerUrl: "http://worker.local",
    token: "secret",
    fetch: fetchMock as unknown as typeof fetch,
  });

  const session = await manager.lookupSession("h-1");
  await session!.inject!({ role: "user", text: "hello" });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("http://worker.local/sessions/h-1/inject");
  expect(init.method).toBe("POST");
  expect(init.headers).toMatchObject({
    authorization: "Bearer secret",
    "content-type": "application/json",
  });
  expect(init.body).toBe(JSON.stringify({ content: "hello" }));
});

test("HTTP worker manager prefers PENUMBRA_WORKER_URL over the port file", async () => {
  const previous = process.env.PENUMBRA_WORKER_URL;
  process.env.PENUMBRA_WORKER_URL = "http://worker.local";
  const fetchMock = mock(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    const manager = createHttpWorkerManager({
      token: "secret",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const session = await manager.lookupSession("h-2");
    await session!.inject!({ role: "user", text: "ping" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://worker.local/sessions/h-2/inject");
  } finally {
    if (previous === undefined) {
      delete process.env.PENUMBRA_WORKER_URL;
    } else {
      process.env.PENUMBRA_WORKER_URL = previous;
    }
  }
});

test("HTTP worker manager throws when the worker returns a non-2xx response", async () => {
  const fetchMock = mock(async () => new Response("nope", { status: 404 }));
  const manager = createHttpWorkerManager({
    workerUrl: "http://worker.local",
    token: "secret",
    fetch: fetchMock as unknown as typeof fetch,
  });

  const session = await manager.lookupSession("h-1");
  await expect(session!.inject!({ role: "user", text: "hello" })).rejects.toThrow(
    "worker inject 404: nope",
  );
});

test("HTTP worker manager returns null and warns once when no worker URL is configured", async () => {
  const warns: string[] = [];
  const manager = createHttpWorkerManager({
    workerUrl: null,
    logWarn: (message) => warns.push(message),
  });

  await expect(manager.lookupSession("h-1")).resolves.toBeNull();
  await expect(manager.lookupSession("h-2")).resolves.toBeNull();
  expect(warns).toEqual(["[serve] worker URL unavailable; ACP soft warnings will no-op"]);
});
