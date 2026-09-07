import { describe, expect, test } from "bun:test";

// eslint-disable-next-line no-restricted-imports -- e2e harness lives outside src/
import { FixtureRouter } from "../../e2e/harness/router";

interface MockResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

const noop = (): void => {
  void 0;
};

function createMockResponse(): {
  response: import("node:http").ServerResponse;
  mock: MockResponse;
} {
  const mock: MockResponse = { statusCode: 0, body: "", headers: {} };
  const response = {
    writeHead: (status: number, hdrs?: Record<string, string>) => {
      mock.statusCode = status;
      if (hdrs) mock.headers = hdrs;
    },
    end: (data?: unknown) => {
      mock.body = typeof data === "string" ? data : "";
    },
    write: noop,
    on: noop,
  } as unknown as import("node:http").ServerResponse;
  return { response, mock };
}

function createMockRequest(): import("node:http").IncomingMessage {
  return {
    headers: {},
    method: "GET",
    url: "/",
    on: noop,
  } as unknown as import("node:http").IncomingMessage;
}

describe("FixtureRouter", () => {
  test("route('GET','/agents', handler) serves it and appears in getCalls()", async () => {
    const router = new FixtureRouter();
    let called = false;
    router.route("GET", "/agents", (ctx) => {
      called = true;
      ctx.response.writeHead(200, { "content-type": "application/json" });
      ctx.response.end(JSON.stringify({ agents: [] }));
    });

    const { response, mock } = createMockResponse();
    const matched = await router.dispatch({
      method: "GET",
      path: "/agents",
      params: {},
      query: new URLSearchParams(),
      body: undefined,
      request: createMockRequest(),
      response,
    });

    expect(matched).toBe(true);
    expect(called).toBe(true);
    expect(mock.statusCode).toBe(200);
    expect(JSON.parse(mock.body)).toEqual({ agents: [] });
    expect(router.misses()).toEqual([]);
  });

  test("a regex route captures :id into params", async () => {
    const router = new FixtureRouter();
    let captured: Record<string, string> = {};
    router.route("GET", /^\/registrar\/(?<id>[^/]+)$/, (ctx) => {
      captured = ctx.params;
      ctx.response.writeHead(200, { "content-type": "application/json" });
      ctx.response.end(JSON.stringify({ id: ctx.params.id }));
    });

    const { response, mock } = createMockResponse();
    const matched = await router.dispatch({
      method: "GET",
      path: "/registrar/reg-42",
      params: {},
      query: new URLSearchParams(),
      body: undefined,
      request: createMockRequest(),
      response,
    });

    expect(matched).toBe(true);
    expect(captured.id).toBe("reg-42");
    expect(JSON.parse(mock.body)).toEqual({ id: "reg-42" });
  });

  test("registering two fixtures on one method+path throws", () => {
    const router = new FixtureRouter();
    router.route("GET", "/agents", noop);
    expect(() => {
      router.route("GET", "/agents", noop);
    }).toThrow("duplicate fixture route GET /agents");
  });

  test("an unregistered path returns 404 {error:'unregistered_fixture_route'} and is listed in misses()", async () => {
    const router = new FixtureRouter();
    router.route("GET", "/agents", noop);

    const { response, mock } = createMockResponse();
    const matched = await router.dispatch({
      method: "GET",
      path: "/unknown",
      params: {},
      query: new URLSearchParams(),
      body: undefined,
      request: createMockRequest(),
      response,
    });

    expect(matched).toBe(false);
    expect(mock.statusCode).toBe(404);
    expect(JSON.parse(mock.body)).toEqual({
      error: "unregistered_fixture_route",
      method: "GET",
      path: "/unknown",
    });
    expect(router.misses()).toEqual([{ method: "GET", path: "/unknown" }]);
  });
});
