import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonClient } from "../../src/api/client";
import { DaemonContractError, DaemonHttpError } from "../../src/api/errors";

type FetchCall = { url: string; init?: RequestInit };
type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const calls: FetchCall[] = [];
let handler: FetchHandler = () =>
  new Response("not configured", { status: 500 });
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  handler = () => new Response("not configured", { status: 500 });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeClient(overrides?: Partial<{ baseUrl: string; token: string }>) {
  return new DaemonClient({
    getConfig: () => ({
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
  test("health() returns { status: 'ok' } and sends Authorization header", async () => {
    handler = () => jsonResponse({ status: "ok" });
    const client = makeClient();
    const result = await client.health();
    expect(result).toEqual({ status: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/health");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-abc");
    expect(headers.get("accept")).toBe("application/json");
  });

  test("listHandoffs() with no opts hits /handoffs without query", async () => {
    handler = () => jsonResponse({ handoffs: [minimalHandoffRow] });
    const client = makeClient();
    const result = await client.listHandoffs();
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/handoffs");
    expect(result.handoffs).toHaveLength(1);
    expect(result.handoffs[0]!.handoff_id).toBe("h1");
  });

  test("listHandoffs({ status: 'pending' }) appends ?status=pending", async () => {
    handler = () => jsonResponse({ handoffs: [] });
    const client = makeClient();
    await client.listHandoffs({ status: "pending" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/handoffs?status=pending");
  });

  test("listHandoffs() throws DaemonHttpError on 401", async () => {
    handler = () => new Response("nope", { status: 401, statusText: "Unauthorized" });
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
    handler = () => jsonResponse({ wrong: "shape" });
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
    handler = () => jsonResponse({ handoffs: [minimalHandoffRow, minimalHandoffRow] });
    const client = makeClient();
    const result = await client.listHandoffs();
    expect(result.handoffs).toHaveLength(2);
  });

  test("approveHandoff(id, { reject: true, reason }) POSTs JSON body", async () => {
    handler = () =>
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
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(calls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ reject: true, reason: "looks bad" });
  });

  test("listChains forwards status, limit, offset as query params", async () => {
    handler = () => jsonResponse({ chains: [], limit: 10, offset: 20 });
    const client = makeClient();
    await client.listChains({ status: "pending", limit: 10, offset: 20 });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/chains");
    expect(url.searchParams.get("status")).toBe("pending");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("20");
  });

  test("getQuotaStatus() hits /usage/quota_status and accepts loose body", async () => {
    handler = () => jsonResponse({ arbitrary: { shape: 1 } });
    const client = makeClient();
    const result = (await client.getQuotaStatus()) as { arbitrary?: { shape?: number } };
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/usage/quota_status");
    expect(result.arbitrary?.shape).toBe(1);
  });
});
