import { describe, expect, test } from "bun:test";

import { handoffsSlice } from "@src/api/domains/handoffs.js";
import { DaemonContractError, DaemonHttpError } from "@src/api/errors.js";
import { DaemonTransport } from "@src/api/transport.js";

interface FetchCall {
  url: URL;
  init: RequestInit | undefined;
}

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeTransport(handler: FetchHandler): {
  calls: FetchCall[];
  handoffs: ReturnType<typeof handoffsSlice>;
} {
  const calls: FetchCall[] = [];
  const transport = new DaemonTransport({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: "http://127.0.0.1:51257",
      token: "tok-abc",
    }),
    fetch: ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = input instanceof Request ? input.url : input;
      const url = new URL(raw);
      calls.push({ url, init });
      return handler(input, init);
    }) as typeof fetch,
  });
  return { calls, handoffs: handoffsSlice(transport) };
}

function jsonResponse(body: unknown, status = 200): FetchHandler {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

const minimalHandoff = {
  handoff_id: "h1",
  ts: "2026-05-08T00:00:00Z",
  project_id: null,
  conversation_id: "c1",
  from_agent: "a",
  to_agent: "b",
  to_role: null,
  message: "hi",
  status: "dispatched",
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("handoffs slice", () => {
  test("latest encodes percent/slash/space conversation_id and parses detail", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoff: minimalHandoff }));
    const result = await handoffs.latest("c%2F a/b");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/handoffs/latest");
    expect(calls[0]!.url.searchParams.get("conversation_id")).toBe("c%2F a/b");
    expect(result.handoff.handoff_id).toBe("h1");
  });

  test("latest rejects empty conversation_id before fetch", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoff: minimalHandoff }));
    const err = await rejection(handoffs.latest(""));
    expect(err).toBeInstanceOf(DaemonContractError);
    expect(calls).toHaveLength(0);
  });

  test("latest forwards conversation_id and omits other query params", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoff: minimalHandoff }));
    await handoffs.latest("c1");
    expect([...calls[0]!.url.searchParams.keys()]).toEqual(["conversation_id"]);
  });

  test("latest rejects malformed successful envelope", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ wrong: "shape" }));
    const err = await rejection(handoffs.latest("c1"));
    expect(err).toBeInstanceOf(DaemonContractError);
    expect(calls).toHaveLength(1);
  });

  test("latest preserves HTTP 404 with not_found code", async () => {
    const { calls, handoffs } = makeTransport(
      jsonResponse({ error: { code: "not_found", message: "gone" } }, 404),
    );
    const err = await rejection(handoffs.latest("c1"));
    expect(err).toBeInstanceOf(DaemonHttpError);
    const httpErr = err as DaemonHttpError;
    expect(httpErr.status).toBe(404);
    expect(httpErr.code).toBe("not_found");
    expect(calls).toHaveLength(1);
  });

  test("list forwards conversation_id with existing filters", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoffs: [] }));
    await handoffs.list({
      status: "dispatched",
      agent: "claude",
      projectId: "p-1",
      conversationId: "c1",
    });
    expect(calls[0]!.url.pathname).toBe("/handoffs");
    expect(calls[0]!.url.searchParams.get("status")).toBe("dispatched");
    expect(calls[0]!.url.searchParams.get("agent")).toBe("claude");
    expect(calls[0]!.url.searchParams.get("project_id")).toBe("p-1");
    expect(calls[0]!.url.searchParams.get("conversation_id")).toBe("c1");
  });

  test("list omits conversation_id when not provided", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoffs: [] }));
    await handoffs.list({ status: "pending" });
    expect(calls[0]!.url.searchParams.has("conversation_id")).toBe(false);
    expect(calls[0]!.url.searchParams.get("status")).toBe("pending");
  });

  test("list rejects empty conversation_id before fetch", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoffs: [] }));
    const err = await rejection(handoffs.list({ conversationId: "" }));
    expect(err).toBeInstanceOf(DaemonContractError);
    expect(calls).toHaveLength(0);
  });

  test("list only validates conversation_id and preserves old filter contracts", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoffs: [] }));
    await handoffs.list({ status: "bogus" as never, conversationId: "c1" });
    expect(calls[0]!.url.searchParams.get("status")).toBe("bogus");
    expect(calls[0]!.url.searchParams.get("conversation_id")).toBe("c1");
  });

  test("list with no opts hits /handoffs without query", async () => {
    const { calls, handoffs } = makeTransport(jsonResponse({ handoffs: [minimalHandoff] }));
    const result = await handoffs.list();
    expect(calls[0]!.url.href).toBe("http://127.0.0.1:51257/handoffs");
    expect(result.handoffs).toHaveLength(1);
  });
});
