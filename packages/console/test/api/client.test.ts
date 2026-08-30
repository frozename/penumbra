import { DaemonClient, type UsageQuotaResponse } from "@src/api/client.js";
import { DaemonContractError, DaemonHttpError } from "@src/api/errors.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const calls: FetchCall[] = [];
const notConfigured: FetchHandler = (): Response => new Response("not configured", { status: 500 });
let handler: FetchHandler = notConfigured;
const originalFetch = globalThis.fetch;

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

beforeEach(() => {
  calls.length = 0;
  handler = notConfigured;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeClient(overrides?: Partial<{ baseUrl: string; token: string }>): DaemonClient {
  return new DaemonClient({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: overrides?.baseUrl ?? "http://127.0.0.1:51257",
      token: overrides?.token ?? "tok-abc",
    }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

const minimalHandoffRow = {
  handoff_id: "h1",
  ts: "2026-05-08T00:00:00Z",
  project_id: null,
  conversation_id: "c1",
  from_agent: "a",
  to_agent: "b",
  to_role: null,
  message: "hi",
  status: "pending",
  resolved_by: null,
  resolved_at: null,
  redirected_to: null,
  resolution_reason: null,
  triggered_by_event_id: null,
  chain_max_hops: null,
  chain_trust_mode: null,
  chain_task_type: null,
  use_worktree: null,
  error_message: null,
  cancel_requested_at: null,
  worker_id: null,
  parent_handoff_id: null,
};

describe("DaemonClient", () => {
  test("health() includes credentials: 'include' and Authorization header", async () => {
    handler = (): Response => jsonResponse({ status: "ok" });
    const client = makeClient();
    const result = await client.health();
    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/health");
    expect(calls[0]!.init?.credentials).toBe("include");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-abc");
    expect(headers.get("accept")).toBe("application/json");
  });

  test("health() with empty token omits Authorization header", async () => {
    handler = (): Response => jsonResponse({ status: "ok" });
    const client = makeClient({ token: "" });
    const result = await client.health();
    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/health");
    expect(calls[0]!.init?.credentials).toBe("include");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
  });

  test("health() with relative /api baseUrl concatenates correctly", async () => {
    handler = (): Response => jsonResponse({ status: "ok" });
    const client = makeClient({ baseUrl: "/api", token: "" });
    const result = await client.health();
    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/health");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  test("listHandoffs() with relative baseUrl builds correct URL with query", async () => {
    handler = (): Response => jsonResponse({ handoffs: [] });
    const client = makeClient({ baseUrl: "/api" });
    await client.listHandoffs({ status: "pending" });
    expect(calls[0]!.url).toBe("/api/handoffs?status=pending");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  test("listHandoffs() with relative trailing-slash baseUrl avoids double slash", async () => {
    handler = (): Response => jsonResponse({ handoffs: [] });
    const client = makeClient({ baseUrl: "/api/" });
    await client.listHandoffs({ status: "pending" });
    expect(calls[0]!.url).toBe("/api/handoffs?status=pending");
  });

  test("approveHandoff() with relative baseUrl builds correct POST URL", async () => {
    handler = (): Response =>
      jsonResponse({ handoff_id: "h1", status: "rejected", redirected_to: null });
    const client = makeClient({ baseUrl: "/api" });
    await client.approveHandoff("h1", { reject: true });
    expect(calls[0]!.url).toBe("/api/handoffs/h1/approve");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  test("listHandoffs() with no opts hits /handoffs without query", async () => {
    handler = (): Response => jsonResponse({ handoffs: [minimalHandoffRow] });
    const client = makeClient();
    const result = await client.listHandoffs();
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/handoffs");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(result.handoffs).toHaveLength(1);
    expect(result.handoffs[0]!.handoff_id).toBe("h1");
  });

  test("listHandoffs({ status: 'pending' }) appends ?status=pending", async () => {
    handler = (): Response => jsonResponse({ handoffs: [] });
    const client = makeClient();
    await client.listHandoffs({ status: "pending" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/handoffs?status=pending");
  });

  test("listHandoffs() throws DaemonHttpError on 401", async () => {
    handler = (): Response => new Response("nope", { status: 401, statusText: "Unauthorized" });
    const client = makeClient();
    let err: unknown;
    try {
      await client.listHandoffs();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonHttpError);
    const httpErr = err as DaemonHttpError;
    expect(httpErr.status).toBe(401);
    expect(httpErr.bodyText).toBe("nope");
    expect(httpErr.url).toBe("http://127.0.0.1:51257/handoffs");
  });

  test("listHandoffs() throws DaemonContractError when body fails schema", async () => {
    handler = (): Response => jsonResponse({ wrong: "shape" });
    const client = makeClient();
    let err: unknown;
    try {
      await client.listHandoffs();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonContractError);
    const contractErr = err as DaemonContractError;
    expect(contractErr.url).toBe("http://127.0.0.1:51257/handoffs");
    expect(Array.isArray(contractErr.issues)).toBe(true);
    expect(contractErr.issues.length).toBeGreaterThan(0);
  });

  test("listHandoffs() parses well-formed response cleanly", async () => {
    handler = (): Response => jsonResponse({ handoffs: [minimalHandoffRow, minimalHandoffRow] });
    const client = makeClient();
    const result = await client.listHandoffs();
    expect(result.handoffs).toHaveLength(2);
  });

  test("approveHandoff(id, { reject: true, reason }) POSTs JSON body", async () => {
    handler = (): Response =>
      jsonResponse({ handoff_id: "h1", status: "rejected", redirected_to: null });
    const client = makeClient();
    const result = await client.approveHandoff("h1", {
      reject: true,
      reason: "looks bad",
    });
    expect(result).toEqual({
      handoff_id: "h1",
      status: "rejected",
      redirected_to: null,
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/handoffs/h1/approve");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(parseBody(calls[0]!.init)).toEqual({ reject: true, reason: "looks bad" });
  });

  test("listChains forwards status, limit, offset, projectId as query params", async () => {
    handler = (): Response => jsonResponse({ chains: [], limit: 10, offset: 20 });
    const client = makeClient();
    await client.listChains({
      status: "pending",
      limit: 10,
      offset: 20,
      projectId: "p-1",
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/chains");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("20");
    expect(url.searchParams.get("project_id")).toBe("p-1");
  });

  test("approveHandoff maps camelCase opts to snake_case wire body", async () => {
    handler = (): Response =>
      jsonResponse({ handoff_id: "h1", status: "redirected", redirected_to: "x" });
    const client = makeClient();
    await client.approveHandoff("h1", {
      redirectTo: "x",
      resolvedBy: "operator",
    });
    expect(parseBody(calls[0]!.init)).toEqual({ redirect_to: "x", resolved_by: "operator" });
  });

  test("getQuotaStatus() hits /usage/quota_status and returns UsageQuotaResponse", async () => {
    handler = (): Response => jsonResponse({ arbitrary: { shape: 1 } });
    const client = makeClient();
    const result: UsageQuotaResponse = await client.getQuotaStatus();
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/usage/quota_status");
    expect((result as { arbitrary?: { shape?: number } }).arbitrary?.shape).toBe(1);
  });
});
