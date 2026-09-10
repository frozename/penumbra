import { afterEach, expect, mock, test } from "bun:test";

import { DaemonClient, DaemonHttpError } from "../src/daemon-client.js";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: typeof fetch): void {
  globalThis.fetch = handler;
}

function readUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function readBody(init?: FetchInit): string {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string body in test fetch mock");
  }
  return body;
}

function readJsonBody(init?: FetchInit): unknown {
  return JSON.parse(readBody(init));
}

test("observe POSTs to /observations with bearer token", async () => {
  let received: { url: string; headers: HeadersInit; body: unknown } | null = null;
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      received = {
        url: readUrl(input),
        headers: init?.headers ?? {},
        body: readJsonBody(init),
      };
      return Promise.resolve(Response.json({ event_id: "x" }));
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
  expect(received).not.toBeNull();
  const captured = received as unknown as { url: string; headers: Record<string, string> };
  expect(captured.url).toBe("http://localhost:1234/observations");
  expect(captured.headers.authorization).toBe("Bearer tk");
});

test("recall POSTs to /recall and returns results", async () => {
  mockFetch(
    mock(() =>
      Promise.resolve(
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
    ),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.recall({ query: "q", project_id: null });
  expect(r.results[0]?.id).toBe("a");
});

test("recall throws on non-2xx", async () => {
  mockFetch(mock(() => Promise.resolve(new Response("boom", { status: 500 }))));
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  let thrown: unknown = null;
  try {
    await c.recall({ query: "q", project_id: null });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/HTTP 500/);
});

test("resolves baseUrl/token lazily so daemon restarts at a new port stay reachable", async () => {
  const seen: string[] = [];
  mockFetch(
    mock((input: FetchInput) => {
      seen.push(readUrl(input));
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
  let current = { baseUrl: "http://localhost:1234", token: "tk1" };
  const c = new DaemonClient({ resolve: (): { baseUrl: string; token: string } => current });
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
  let received: { url: string; body: { session_id: string } } | null = null;
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      received = {
        url: new URL(readUrl(input)).pathname,
        body: readJsonBody(init) as { session_id: string },
      };
      return Promise.resolve(Response.json({ ok: true }));
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.endSession("sess-123");
  expect(received).not.toBeNull();
  const captured = received as unknown as { url: string; body: { session_id: string } };
  expect(captured.url).toBe("/sessions/end");
  expect(captured.body.session_id).toBe("sess-123");
  expect(r.ok).toBe(true);
});

test("listChainAgents GETs /chains/agents and returns ordered names", async () => {
  let receivedPath: string | null = null;
  mockFetch(
    mock((input: FetchInput) => {
      receivedPath = new URL(readUrl(input)).pathname;
      return Promise.resolve(
        Response.json({ agents: [{ name: "planner" }, { name: "executor" }] }),
      );
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const r = await c.listChainAgents();
  expect(receivedPath).toBe("/chains/agents");
  expect(r).toEqual({ agents: [{ name: "planner" }, { name: "executor" }] });
});

test("workflowReport GETs /workflows/report with encoded filters", async () => {
  const received: { path: string; search: string }[] = [];
  mockFetch(((input: FetchInput) => {
    const url = new URL(readUrl(input));
    received.push({ path: url.pathname, search: url.search });
    return Promise.resolve(Response.json({ window: {}, rows: [] }));
  }) as typeof fetch);
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const result = await c.workflowReport({ window_hours: 24, project_id: "proj/a b" });

  expect(received).toEqual([
    { path: "/workflows/report", search: "?window_hours=24&project_id=proj%2Fa+b" },
  ]);
  expect(result).toEqual({ window: {}, rows: [] });
});

test("reconcilerSweepOrphanPrs POSTs to /reconciler/sweep-orphan-prs", async () => {
  let received: { path: string; body: unknown } | null = null;
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      received = { path: new URL(readUrl(input)).pathname, body: readJsonBody(init) };
      return Promise.resolve(
        Response.json({ scanned: 3, superseded: 1, stale: 1, errored: 0, actions: [] }),
      );
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
    mock((input: FetchInput) => {
      const url = new URL(readUrl(input));
      received = { path: url.pathname, search: url.search };
      return Promise.resolve(Response.json({ verdicts: [] }));
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
    mock((input: FetchInput, init?: FetchInit) => {
      received = { path: new URL(readUrl(input)).pathname, headers: new Headers(init?.headers) };
      return Promise.resolve(
        Response.json({ tools: [{ name: "ha:state_get", description: "x" }] }),
      );
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const result = await c.getFederationTools("agent-1");
  expect(received).not.toBeNull();
  const captured = received as unknown as { path: string; headers: Headers };
  expect(captured.path).toBe("/long-lived/agents/agent-1/federation-tools");
  expect(captured.headers.get("authorization")).toBe("Bearer tk");
  expect(result).toEqual({ tools: [{ name: "ha:state_get", description: "x" }] });
});

test("longLivedStateSet POSTs to /long-lived/<id>/state with body wrapped under partial", async () => {
  let received: { path: string; body: unknown } | null = null;
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      received = { path: new URL(readUrl(input)).pathname, body: readJsonBody(init) };
      return Promise.resolve(Response.json({ ok: true }));
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
    mock((input: FetchInput, init?: FetchInit) => {
      const url = new URL(readUrl(input));
      if (init?.method === "POST" && url.pathname === "/dispatch/land") {
        postCount += 1;
        return Promise.resolve(Response.json({ task_id: "task-async-1" }, { status: 202 }));
      }
      if (url.pathname === "/dispatch/land/task-async-1") {
        return Promise.resolve(
          Response.json({
            status: "failed",
            error: { code: "lifecycle_busy", message: "another land in flight" },
          }),
        );
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

test("dispatchLand surfaces the failing verdict check and compared head SHAs on HTTP 409", async () => {
  mockFetch(
    mock(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: "verdict_unverified",
              check: "typecheck",
              verdict_head_sha: "verified-head",
              branch_head_sha: "current-head",
            },
          },
          { status: 409 },
        ),
      ),
    ),
  );
  const client = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });

  let thrown: unknown = null;
  try {
    await client.dispatchLand({ handoff_id: "h-stale", commit_message: "fix: stale verdict" });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(DaemonHttpError);
  const httpErr = thrown as DaemonHttpError;
  expect(httpErr.status).toBe(409);
  expect(httpErr.message).toContain("verdict_unverified");
  expect(httpErr.message).toContain("check=typecheck");
  expect(httpErr.message).toContain("verdict_head_sha=verified-head");
  expect(httpErr.message).toContain("branch_head_sha=current-head");
});

test("dispatchLand resolves { status: 'still_running', task_id } instead of throwing on client-side poll timeout", async () => {
  let pollCount = 0;
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      const url = new URL(readUrl(input));
      if (init?.method === "POST" && url.pathname === "/dispatch/land") {
        return Promise.resolve(Response.json({ task_id: "task-slow-1" }, { status: 202 }));
      }
      if (url.pathname === "/dispatch/land/task-slow-1") {
        pollCount += 1;
        return Promise.resolve(Response.json({ status: "running" }));
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  const started = Date.now();
  const out = await c.dispatchLand({
    handoff_id: "h-slow",
    commit_message: "feat: slow",
    timeout_ms: 400,
  });
  const elapsed = Date.now() - started;
  expect(out).toEqual({
    status: "still_running",
    task_id: "task-slow-1",
    resume_url: "/dispatch/land/task-slow-1",
  });
  expect(pollCount).toBeGreaterThanOrEqual(2);
  expect(elapsed).toBeLessThan(5_000);
});

test("dispatchLand does not forward timeout_ms in the daemon POST body", async () => {
  let receivedBody: unknown = null;
  mockFetch(
    mock((input: FetchInput, init?: FetchInit) => {
      const url = new URL(readUrl(input));
      if (init?.method === "POST" && url.pathname === "/dispatch/land") {
        receivedBody = readJsonBody(init);
        return Promise.resolve(
          Response.json({ ok: true, commit_sha: "abc", branch_deleted: true, pr_closed: false }),
        );
      }
      throw new Error(`unexpected fetch: ${url.pathname}`);
    }),
  );
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  await c.dispatchLand({
    handoff_id: "h-fast",
    commit_message: "feat: fast",
    timeout_ms: 10_000,
  });
  expect(receivedBody).toEqual({
    handoff_id: "h-fast",
    commit_message: "feat: fast",
  });
});

test("mcpCall POSTs to /long-lived/mcp/call with the request body", async () => {
  let received: unknown = null;
  mockFetch(
    mock((_input: FetchInput, init?: FetchInit) => {
      received = readJsonBody(init);
      return Promise.resolve(Response.json({ action_status: "executed", result: { ok: true } }));
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

test("getLatestHandoff attaches an AbortSignal deadline when the caller passes timeoutMs", async () => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const controller = new AbortController();
  const timeoutCalls: number[] = [];
  AbortSignal.timeout = (ms: number): AbortSignal => {
    timeoutCalls.push(ms);
    return controller.signal;
  };
  let seenSignal: AbortSignal | undefined;
  try {
    mockFetch(((_input: FetchInput, init?: FetchInit) => {
      seenSignal = init?.signal ?? undefined;
      return Promise.resolve(
        Response.json({
          handoff: { handoff_id: "h1", status: "running", conversation_id: "c1" },
        }),
      );
    }) as typeof fetch);
    const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
    await c.getLatestHandoff("conv-1", { timeoutMs: 5000 });
    expect(seenSignal).toBe(controller.signal);
    expect(timeoutCalls).toEqual([5000]);
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
});

// Fail-closed tripwire: this one is GREEN before and after the change. POST
// /workflows/wait long-polls for up to 1_800_000 ms and owns its own budget;
// an unconditional default deadline on the shared `post()` would sever it.
test("workflowWait sends no AbortSignal so long-poll routes keep owning their own budget", async () => {
  let called = false;
  let seenSignal: AbortSignal | undefined;
  mockFetch(((_input: FetchInput, init?: FetchInit) => {
    called = true;
    seenSignal = init?.signal ?? undefined;
    return Promise.resolve(Response.json({ status: "completed" }));
  }) as typeof fetch);
  const c = new DaemonClient({ baseUrl: "http://localhost:1234", token: "tk" });
  await c.workflowWait({ workflow_run_id: "r1", timeout_ms: 1_800_000 });
  expect(called).toBe(true);
  expect(seenSignal).toBeUndefined();
});
