import type { ApprovePermissionRequest, RegistrarEventInput } from "@penumbra/api-contract";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DaemonClient, type UsageQuotaResponse } from "@src/api/client.js";
import { DaemonContractError, DaemonHttpError } from "@src/api/errors.js";

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

const minimalSessionEventRow = {
  id: 1,
  session_id: "session-1234567890",
  related_session_id: null,
  project_id: "penumbra",
  cwd: "/repo/penumbra",
  transcript_path: null,
  ref_path: "/notes/session-note.md",
  kind: "session.start",
  ts: "2026-09-01T10:00:00.000Z",
  meta: null,
};

const minimalSessionDraftRow = {
  draft_id: "draft-1",
  session_id: "session-1234567890",
  project_id: "penumbra",
  period_key: "2026-09-01-am",
  skeleton_path: "/notes/skeleton.md",
  draft_path: "/notes/draft.md",
  note_path: "/notes/note.md",
  handoff_id: null,
  status: "awaiting_approval",
  composed_at: "2026-09-01T10:00:00.000Z",
  reviewed_at: null,
  composed_event_id: 1,
  review_event_id: null,
};

const minimalPermissionRow = {
  permission_id: "p1",
  parent_handoff_id: "h-1",
  conversation_id: "c-1",
  agent_name: "a",
  tool_name: "t",
  raw_input_json: "{}",
  status: "pending",
  remember_scope: null,
  decision_reason: null,
  decided_by: null,
  ttl_at: "2026-09-01T10:05:00.000Z",
  created_at: "2026-09-01T10:00:00.000Z",
  decided_at: null,
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

  test("listSessionEvents forwards encoded filters and tolerates malformed rows", async () => {
    handler = (): Response =>
      jsonResponse({
        events: [
          minimalSessionEventRow,
          { ...minimalSessionEventRow, id: 2, kind: "continuity.future_kind" },
        ],
      });
    const client = makeClient();
    const result = await client.listSessionEvents({
      session_id: "session/one",
      kind_prefix: "continuity.",
      since: "2026-09-01T10:00:00.000Z",
      limit: 20,
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/session-events");
    expect(url.searchParams.get("session_id")).toBe("session/one");
    expect(url.searchParams.get("kind_prefix")).toBe("continuity.");
    expect(url.searchParams.get("since")).toBe("2026-09-01T10:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.ok).toBe(true);
    expect(result.events[1]!.ok).toBe(false);
  });

  test("listSessionNoteDrafts forwards status and limit filters", async () => {
    handler = (): Response => jsonResponse({ drafts: [minimalSessionDraftRow] });
    const client = makeClient();
    const result = await client.listSessionNoteDrafts({
      status: "awaiting_approval",
      limit: 20,
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/session-notes/drafts");
    expect(url.searchParams.get("status")).toBe("awaiting_approval");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(result.drafts[0]!.draft_id).toBe("draft-1");
  });

  test("permissions.list({status:'pending'}) GETs /permissions?status=pending", async () => {
    handler = (): Response => jsonResponse({ permissions: [minimalPermissionRow] });
    const client = makeClient();
    const result = await client.permissions.list({ status: "pending" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/permissions?status=pending");
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0]!.permission_id).toBe("p1");
  });

  test("permissions.decide(id,{decision:'approve'}) POSTs /permissions/<enc(id)>/decide and never sends resolved_by", async () => {
    const decidedAt = "2026-09-01T10:01:00.000Z";
    handler = (): Response =>
      jsonResponse({ permission_id: "p/1", status: "approved", decided_at: decidedAt });
    const client = makeClient();
    const result = await client.permissions.decide("p/1", { decision: "approve" });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/permissions/p%2F1/decide");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = parseBody(calls[0]!.init);
    expect(body).not.toHaveProperty("resolved_by");
    expect(body).toEqual({ decision: "approve" });
    expect(result).toEqual({ permission_id: "p/1", status: "approved", decided_at: decidedAt });
  });

  test("permissions.decide rejects a body carrying resolved_by before any fetch", async () => {
    const client = makeClient();
    const form: ApprovePermissionRequest = { decision: "approve", resolved_by: "someone" };
    let err: unknown;
    try {
      await client.permissions.decide("p1", { ...form });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonContractError);
    expect(calls.length).toBe(0);
  });

  test("sessionNotes.approve({draft_id, approve:true}) POSTs the validated body to /session-notes/approve exactly once", async () => {
    handler = (): Response => jsonResponse({ draft: minimalSessionDraftRow, event: null });
    const client = makeClient();
    const result = await client.sessionNotes.approve({ draft_id: "draft-1", approve: true });
    expect(calls.length).toBe(1);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.url).toMatch(/\/session-notes\/approve$/u);
    expect(parseBody(calls[0]!.init)).toEqual({ draft_id: "draft-1", approve: true });
    expect(result.draft.draft_id).toBe("draft-1");
  });

  test("sessionNotes.approve({draft_id, approve:true}) validates against SessionNoteApproveRequestSchema (strict, unknown key rejected)", async () => {
    handler = (): Response => jsonResponse({ draft: minimalSessionDraftRow, event: null });
    const client = makeClient();
    const badBody = {
      draft_id: "draft-1",
      approve: true,
      bogus: "nope",
    } as unknown as Parameters<typeof client.sessionNotes.approve>[0];
    let err: unknown;
    try {
      await client.sessionNotes.approve(badBody);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonContractError);
    expect(calls.length).toBe(0);
    const contractErr = err as DaemonContractError;
    expect(contractErr.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(JSON.stringify(contractErr.issues)).toContain('"bogus"');
  });

  test("registrar.appendEvent posts RegistrarEventInput with actor 'operator'", async () => {
    handler = (): Response =>
      jsonResponse({
        event: {
          event_id: 1,
          registrar_id: "reg-1",
          phase_no: null,
          kind: "progress",
          state: null,
          ref_event_id: null,
          link_kind: null,
          link_value: null,
          actor: "operator",
          body: "did stuff",
          created_at: Date.now(),
        },
      });
    const client = makeClient();
    await client.registrar.appendEvent("reg-1", {
      kind: "progress",
      actor: "operator",
      body: "did stuff",
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:51257/registrar/reg-1/events");
    expect(calls[0]!.init?.method).toBe("POST");
    const body = parseBody(calls[0]!.init);
    expect(body.actor).toBe("operator");
    expect(body.kind).toBe("progress");
  });

  test("registrar.appendEvent rejects an over-length body and an unknown key before any fetch", async () => {
    const client = makeClient();
    let errA: unknown;
    try {
      await client.registrar.appendEvent("reg-1", {
        kind: "progress",
        actor: "operator",
        body: "a".repeat(4097),
      });
    } catch (e) {
      errA = e;
    }
    expect(errA).toBeInstanceOf(DaemonContractError);
    expect(calls.length).toBe(0);

    let errB: unknown;
    try {
      await client.registrar.appendEvent("reg-1", {
        kind: "progress",
        actor: "operator",
        body: "x",
        bogus: "nope",
      } as unknown as RegistrarEventInput);
    } catch (e) {
      errB = e;
    }
    expect(errB).toBeInstanceOf(DaemonContractError);
    const contractErr = errB as DaemonContractError;
    expect(contractErr.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
    expect(calls.length).toBe(0);
  });
});
