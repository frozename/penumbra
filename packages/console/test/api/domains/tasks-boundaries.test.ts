import { describe, expect, test } from "bun:test";
import { ZodError } from "zod";

import { taskDraftsSlice } from "@src/api/domains/task-drafts.js";
import { tasksSlice } from "@src/api/domains/tasks.js";
import { DaemonContractError, DaemonHttpError } from "@src/api/errors.js";
import { DaemonTransport } from "@src/api/transport.js";

function fixture(
  response: unknown = {},
  status = 200,
): {
  calls: { url: URL; init: RequestInit | undefined }[];
  tasks: ReturnType<typeof tasksSlice>;
  drafts: ReturnType<typeof taskDraftsSlice>;
} {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const transport = new DaemonTransport({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: "http://127.0.0.1:51257",
      token: "tok-abc",
    }),
    fetch: ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  });
  return { calls, tasks: tasksSlice(transport), drafts: taskDraftsSlice(transport) };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

type Fixture = ReturnType<typeof fixture>;
const stableMethods: { name: string; invoke: (api: Fixture) => Promise<unknown> }[] = [
  { name: "list", invoke: (api): Promise<unknown> => api.tasks.list() },
  { name: "get", invoke: (api): Promise<unknown> => api.tasks.get("t/1") },
  {
    name: "create",
    invoke: (api): Promise<unknown> =>
      api.tasks.create({ prompt: "work", created_by_kind: "human", created_by_id: "cli" }),
  },
  { name: "cancel", invoke: (api): Promise<unknown> => api.tasks.cancel("t/1", {}) },
  {
    name: "fail",
    invoke: (api): Promise<unknown> => api.tasks.fail("t/1", { lease_id: "l1", reason: "failed" }),
  },
  {
    name: "pending",
    invoke: (api): Promise<unknown> =>
      api.drafts.pending({ project_id: "p1", latest_event_type: "task_draft" }),
  },
  {
    name: "pendingEscalations",
    invoke: (api): Promise<unknown> => api.drafts.pendingEscalations({ project_id: "p1" }),
  },
];

describe("task domain query boundaries", () => {
  test.each([
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { offset: -1 },
    { status: "bogus" },
    { unexpected: true },
  ])("list rejects invalid query %j before fetch", async (query) => {
    const api = fixture({ tasks: [] });
    expect(await rejection(api.tasks.list(query as never))).toBeInstanceOf(ZodError);
    expect(api.calls).toHaveLength(0);
  });

  test.each([
    undefined,
    {},
    { latest_event_type: "task_draft" },
    { project_id: "p1" },
    { project_id: "", latest_event_type: "task_draft" },
    { project_id: "p1", latest_event_type: "other" },
    { project_id: "p1", latest_event_type: "task_draft", limit: 0 },
    { project_id: "p1", latest_event_type: "task_draft", limit: 51 },
    { project_id: "p1", latest_event_type: "task_draft", limit: 1.5 },
    { project_id: "p1", latest_event_type: "task_draft", unexpected: true },
  ])("pending rejects invalid query %j before fetch", async (query) => {
    const api = fixture({ drafts: [] });
    expect(await rejection(api.drafts.pending(query as never))).toBeInstanceOf(ZodError);
    expect(api.calls).toHaveLength(0);
  });

  test.each([
    undefined,
    {},
    { project_id: "" },
    { project_id: "p1", limit: 0 },
    { project_id: "p1", limit: 51 },
    { project_id: "p1", limit: 1.5 },
    { project_id: "p1", unexpected: true },
  ])("pendingEscalations rejects invalid query %j before fetch", async (query) => {
    const api = fixture({ escalations: [] });
    expect(await rejection(api.drafts.pendingEscalations(query as never))).toBeInstanceOf(ZodError);
    expect(api.calls).toHaveLength(0);
  });

  test("query methods forward schema-normalized numeric limits", async () => {
    const list = fixture({ tasks: [] });
    await list.tasks.list({ limit: "005" } as never);
    const pending = fixture({ drafts: [] });
    await pending.drafts.pending({
      project_id: "p1",
      latest_event_type: "task_draft",
      limit: "005",
    } as never);
    const escalations = fixture({ escalations: [] });
    await escalations.drafts.pendingEscalations({ project_id: "p1", limit: "005" } as never);
    for (const api of [list, pending, escalations]) {
      expect(api.calls[0]!.url.searchParams.get("limit")).toBe("5");
    }
  });

  test("list accepts omitted and empty queries without adding defaults", async () => {
    const response = { tasks: [{ task_id: "t1", prompt: "work", extra: true }] };
    const api = fixture(response);
    expect(await api.tasks.list()).toEqual(response);
    expect(await api.tasks.list({})).toEqual(response);
    expect(api.calls.map(({ url }): string => url.href)).toEqual([
      "http://127.0.0.1:51257/tasks",
      "http://127.0.0.1:51257/tasks",
    ]);
    expect(api.calls.every(({ init }): boolean => init?.method === "GET")).toBe(true);
  });

  test("list forwards every supported filter and pagination value", async () => {
    const api = fixture({ tasks: [] });
    const query = {
      status: "pending" as const,
      kind: "work" as const,
      eligible_for: "agent & one",
      parent_task_id: "parent/1",
      origin: "console",
      limit: 500,
      offset: 0,
    };
    await api.tasks.list(query);
    expect(Object.fromEntries(api.calls[0]!.url.searchParams)).toEqual({
      ...query,
      limit: "500",
      offset: "0",
    });
  });

  test.each(["task_draft", "task_draft_escalation"] as const)(
    "pending forwards project, limit and event type %s",
    async (eventType) => {
      const response = { drafts: [{ draft_id: "d1", extra: true }] };
      const api = fixture(response);
      expect(
        await api.drafts.pending({
          project_id: "project/a & b",
          latest_event_type: eventType,
          limit: 50,
        }),
      ).toEqual(response);
      expect(api.calls[0]!.url.pathname).toBe("/task-drafts/pending");
      expect(Object.fromEntries(api.calls[0]!.url.searchParams)).toEqual({
        project_id: "project/a & b",
        latest_event_type: eventType,
        limit: "50",
      });
      expect(api.calls[0]!.init?.method).toBe("GET");
    },
  );

  test("draft methods omit an absent limit and escalations forwards an explicit limit", async () => {
    const pending = fixture({ drafts: [] });
    await pending.drafts.pending({ project_id: "p1", latest_event_type: "task_draft" });
    expect(pending.calls[0]!.url.searchParams.has("limit")).toBe(false);
    const response = { escalations: [{ draft_id: "d1" }] };
    const api = fixture(response);
    expect(await api.drafts.pendingEscalations({ project_id: "p/1" })).toEqual(response);
    expect(await api.drafts.pendingEscalations({ project_id: "p/1", limit: 50 })).toEqual(response);
    expect(api.calls[0]!.url.searchParams.has("limit")).toBe(false);
    expect(api.calls[1]!.url.pathname).toBe("/task-drafts/pending-escalations");
    expect(Object.fromEntries(api.calls[1]!.url.searchParams)).toEqual({
      project_id: "p/1",
      limit: "50",
    });
    expect(api.calls[1]!.init?.method).toBe("GET");
  });
});

describe("task domain transport contracts", () => {
  test("get encodes task ids and omits absent or empty include while joining multiple values", async () => {
    const response = { task_id: "t/1 ?#", status: "pending" as const, lease: null };
    const api = fixture(response);
    expect(await api.tasks.get(response.task_id)).toEqual(response);
    await api.tasks.get(response.task_id, {});
    await api.tasks.get(response.task_id, { include: [] });
    await api.tasks.get(response.task_id, { include: ["lease", "events", "descendants"] });
    expect(api.calls.every(({ url }): boolean => url.pathname === "/tasks/t%2F1%20%3F%23")).toBe(
      true,
    );
    expect(api.calls.slice(0, 3).every(({ url }): boolean => url.search === "")).toBe(true);
    expect(api.calls[3]!.url.searchParams.get("include")).toBe("lease,events,descendants");
    expect(api.calls.every(({ init }): boolean => init?.method === "GET")).toBe(true);
  });

  test("cancel and fail post only their supplied bodies to encoded task paths", async () => {
    const cancel = fixture({ status: "cancelled" });
    expect(await cancel.tasks.cancel("t/1", { reason: "stop" })).toEqual({ status: "cancelled" });
    const fail = fixture({ status: "failed" });
    const body = { lease_id: "lease/1", reason: "failed" };
    expect(await fail.tasks.fail("t/1", body)).toEqual({ status: "failed" });
    for (const [api, suffix, expected] of [
      [cancel, "cancel", { reason: "stop" }],
      [fail, "fail", body],
    ] as const) {
      expect(api.calls[0]!.url.pathname).toBe(`/tasks/t%2F1/${suffix}`);
      expect(api.calls[0]!.init?.method).toBe("POST");
      expect(JSON.parse(api.calls[0]!.init?.body as string) as unknown).toEqual(expected);
    }
  });

  test.each(stableMethods)("$name rejects malformed successful responses", async ({ invoke }) => {
    const api = fixture({ unexpected: true });
    expect(await rejection(invoke(api))).toBeInstanceOf(DaemonContractError);
    expect(api.calls).toHaveLength(1);
  });

  test.each(stableMethods)(
    "$name preserves HTTP status, error code and body",
    async ({ invoke }) => {
      const body = { error: { code: "conflict", message: "cannot proceed" } };
      const api = fixture(body, 409);
      const result = await invoke(api).catch((error: unknown): unknown => error);
      expect(result).toBeInstanceOf(DaemonHttpError);
      expect(result).toMatchObject({
        status: 409,
        code: "conflict",
        bodyText: JSON.stringify(body),
      });
      expect(api.calls).toHaveLength(1);
    },
  );
});
