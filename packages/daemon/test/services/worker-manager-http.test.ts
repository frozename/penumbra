import { expect, test } from "bun:test";

import { createHttpWorkerManager } from "@src/maestro/worker-manager-http.js";

type FetchInput = Request | URL | string;
type FetchCall = [input: unknown, init?: unknown];

async function expectRejectsWithMessage(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("expected promise to reject with Error");
  expect(caught.message).toContain(expectedMessage);
}

function createFetchStub(response: Response): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: (input: FetchInput, init?: unknown): Promise<Response> => {
      calls.push([input, init]);
      return Promise.resolve(response);
    },
  };
}

function expectInjectRequestInit(init: unknown): void {
  if (typeof init !== "object" || init === null) {
    throw new Error("expected fetch init object");
  }
  expect("method" in init ? init.method : undefined).toBe("POST");
  expect("headers" in init ? init.headers : undefined).toMatchObject({
    authorization: "Bearer secret",
    "content-type": "application/json",
  });
  expect("body" in init ? init.body : undefined).toBe(JSON.stringify({ content: "hello" }));
}

test("HTTP worker manager relays injects to the worker route", async () => {
  const fetchStub = createFetchStub(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const manager = createHttpWorkerManager({
    workerUrl: "http://worker.local",
    token: "secret",
    fetch: fetchStub.fetch,
  });

  const session = await manager.lookupSession("h-1");
  if (!session?.inject) throw new Error("expected injectable session");
  await Promise.resolve(session.inject({ role: "user", text: "hello" }));

  expect(fetchStub.calls).toHaveLength(1);
  const [url, init] = fetchStub.calls[0];
  expect(url).toBe("http://worker.local/sessions/h-1/inject");
  expectInjectRequestInit(init);
});

test("HTTP worker manager prefers PENUMBRA_WORKER_URL over the port file", async () => {
  const previous = process.env.PENUMBRA_WORKER_URL;
  process.env.PENUMBRA_WORKER_URL = "http://worker.local";
  const fetchStub = createFetchStub(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  try {
    const manager = createHttpWorkerManager({
      token: "secret",
      fetch: fetchStub.fetch,
    });

    const session = await manager.lookupSession("h-2");
    if (!session?.inject) throw new Error("expected injectable session");
    await Promise.resolve(session.inject({ role: "user", text: "ping" }));

    const [url] = fetchStub.calls[0];
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
  const fetchStub = createFetchStub(new Response("nope", { status: 404 }));
  const manager = createHttpWorkerManager({
    workerUrl: "http://worker.local",
    token: "secret",
    fetch: fetchStub.fetch,
  });

  const session = await manager.lookupSession("h-1");
  if (!session?.inject) throw new Error("expected injectable session");
  await expectRejectsWithMessage(
    Promise.resolve(session.inject({ role: "user", text: "hello" })),
    "worker inject 404: nope",
  );
});

test("HTTP worker manager returns null and warns once when no worker URL is configured", async () => {
  const warns: string[] = [];
  const manager = createHttpWorkerManager({
    workerUrl: null,
    logWarn: (message) => warns.push(message),
  });

  expect(await Promise.resolve(manager.lookupSession("h-1"))).toBeNull();
  expect(await Promise.resolve(manager.lookupSession("h-2"))).toBeNull();
  expect(warns).toEqual(["[serve] worker URL unavailable; ACP soft warnings will no-op"]);
});
