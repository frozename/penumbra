import { afterEach, expect, mock, test } from "bun:test";
import { DaemonClient, DaemonHttpError } from "../src/daemon-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: typeof fetch): void {
  globalThis.fetch = handler as any;
}

test("observe POSTs to /observations with bearer token", async () => {
  let received: { url: string; headers: HeadersInit; body: unknown } | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      received = {
        url: String(input),
        headers: init?.headers ?? {},
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({ event_id: "x" });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.observe({
    source: "mcp",
    event_type: "agent-prompt",
    ts: "2026-04-23T12:00:00Z",
    lane: "local",
    payload_json: {},
    user_id: "u1",
    machine_id: "m1",
  });
  expect(r.event_id).toBe("x");
  expect(received?.url).toBe("http://localhost:1234/observations");
  expect((received?.headers as Record<string, string>).authorization).toBe("Bearer tk");
});

test("recall POSTs to /recall and returns results", async () => {
  mockFetch(
    mock(async () =>
      Response.json({
        results: [
          {
            id: "a",
            tier: "t1",
            score: 0.9,
            body: "x",
            title: null,
            project_id: null,
            source_session_ids: [],
            created_at: "now",
          },
        ],
      }),
    ),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.recall({ query: "q", project_id: null });
  expect(r.results[0]!.id).toBe("a");
});

test("recall throws on non-2xx", async () => {
  mockFetch(mock(async () => new Response("boom", { status: 500 })));
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  await expect(c.recall({ query: "q", project_id: null })).rejects.toThrow(/HTTP 500/);
});

test("resolves baseUrl/token lazily so daemon restarts at a new port stay reachable", async () => {
  const seen: string[] = [];
  mockFetch(
    mock(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return Response.json({ ok: true });
    }),
  );
  let current = { baseUrl: "http://localhost:1234", token: "tk1" };
  const c = new DaemonClient({ resolve: () => current });
  await c.endSession("s1");
  current = { baseUrl: "http://localhost:4321", token: "tk2" };
  const r = await c.endSession("s2");
  expect(seen).toEqual([
    "http://localhost:1234/sessions/end",
    "http://localhost:4321/sessions/end",
  ]);
  expect(r.ok).toBe(true);
});

test("endSession POSTs to /sessions/end with session_id body", async () => {
  let received: { url: string; body: unknown } | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      received = { url: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.endSession("sess-123");
  expect(received!.url).toBe("/sessions/end");
  expect((received!.body as { session_id: string }).session_id).toBe("sess-123");
  expect(r.ok).toBe(true);
});

test("listChainAgents GETs /chains/agents and returns ordered names", async () => {
  let receivedPath: string | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL) => {
      receivedPath = new URL(String(input)).pathname;
      return Response.json({ agents: [{ name: "planner" }, { name: "executor" }] });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.listChainAgents();
  expect(receivedPath).toBe("/chains/agents");
  expect(r).toEqual({ agents: [{ name: "planner" }, { name: "executor" }] });
});

test("reconcilerSweepOrphanPrs POSTs to /reconciler/sweep-orphan-prs", async () => {
  let received: { path: string; body: unknown } | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      received = { path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) };
      return Response.json({ scanned: 3, superseded: 1, stale: 1, errored: 0, actions: [] });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const result = await c.reconcilerSweepOrphanPrs({ dry_run: true, max_close: 5 });
  expect(received?.path).toBe("/reconciler/sweep-orphan-prs");
  expect(received?.body).toEqual({ dry_run: true, max_close: 5 });
  expect(result).toEqual({ scanned: 3, superseded: 1, stale: 1, errored: 0, actions: [] });
});

test("reconcilerVerdicts GETs /reconciler/verdicts with filters", async () => {
  let received: { path: string; search: string } | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      received = { path: url.pathname, search: url.search };
      return Response.json({ verdicts: [] });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const result = await c.reconcilerVerdicts({
    since: "2026-05-07T00:00:00.000Z",
    limit: 5,
    only_unverified: true,
  });
  expect(received?.path).toBe("/reconciler/verdicts");
  expect(received?.search).toContain("since=2026-05-07T00%3A00%3A00.000Z");
  expect(received?.search).toContain("limit=5");
  expect(received?.search).toContain("only_unverified=true");
  expect(result).toEqual({ verdicts: [] });
});

test("getFederationTools GETs the agent federation tools route with bearer auth", async () => {
  let received: { path: string; headers: Headers } | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      received = { path: new URL(String(input)).pathname, headers: new Headers(init?.headers) };
      return Response.json({ tools: [{ name: "ha:state_get", description: "x" }] });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const result = await c.getFederationTools("agent-1");
  expect(received?.path).toBe("/long-lived/agents/agent-1/federation-tools");
  expect(received?.headers.get("authorization")).toBe("Bearer tk");
  expect(result).toEqual({ tools: [{ name: "ha:state_get", description: "x" }] });
});

test("longLivedStateSet POSTs to /long-lived/<id>/state with body wrapped under partial", async () => {
  let received: { path: string; body: unknown } | null = null;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      received = { path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) };
      return Response.json({ ok: true });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  await c.longLivedStateSet("home-mgmt", { intent_summary: "probe" });
  expect(received?.path).toBe("/long-lived/home-mgmt/state");
  expect(received?.body).toEqual({ partial: { intent_summary: "probe" } });
});

test("dispatchLand throws DaemonHttpError when the async task reports status=failed", async () => {
  let postCount = 0;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "POST" && url.pathname === "/dispatch/land") {
        postCount += 1;
        return Response.json({ task_id: "task-async-1" }, { status: 202 });
      }
      if (url.pathname === "/dispatch/land/task-async-1") {
        return Response.json({
          status: "failed",
          error: { code: "lifecycle_busy", message: "another land in flight" },
        });
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  let thrown: unknown = null;
  try {
    await c.dispatchLand({ handoff_id: "h-1", commit_message: "feat: msg" });
  } catch (err) {
    thrown = err;
  }
  expect(postCount).toBe(1);
  expect(thrown).toBeInstanceOf(DaemonHttpError);
  const httpErr = thrown as DaemonHttpError;
  expect(httpErr.status).toBe(500);
  expect(httpErr.message).toContain("task-async-1");
  expect(httpErr.message).toContain("lifecycle_busy");
  expect(httpErr.body).toEqual({ code: "lifecycle_busy", message: "another land in flight" });
});

test("mcpCall POSTs to /long-lived/mcp/call with the request body", async () => {
  let received: unknown = null;
  mockFetch(
    mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      received = JSON.parse(String(init?.body));
      return Response.json({ action_status: "executed", result: { ok: true } });
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const result = await c.mcpCall({
    agent_id: "agent-1",
    tick_id: "tick-1",
    tool: "ha:state_get",
    args: { x: 1 },
  });
  expect(received).toEqual({
    agent_id: "agent-1",
    tick_id: "tick-1",
    tool: "ha:state_get",
    args: { x: 1 },
  });
  expect(result).toEqual({ action_status: "executed", result: { ok: true } });
});
