import type { PermissionRequestRow } from "@penumbra/api-contract";

import { describe, expect, test } from "bun:test";

import { permissionsSlice } from "@src/api/domains/permissions.js";
import { registrarSlice } from "@src/api/domains/registrar.js";
import { usageSlice } from "@src/api/domains/usage.js";
import { DaemonContractError } from "@src/api/errors.js";
import { DaemonTransport } from "@src/api/transport.js";

interface FetchCall {
  url: URL;
  init: RequestInit | undefined;
}

function makeApi(body: unknown): {
  calls: FetchCall[];
  usage: ReturnType<typeof usageSlice>;
  permissions: ReturnType<typeof permissionsSlice>;
  registrar: ReturnType<typeof registrarSlice>;
} {
  const calls: FetchCall[] = [];
  const transport = new DaemonTransport({
    getConfig: (): { baseUrl: string; token: string } => ({
      baseUrl: "http://127.0.0.1:51257",
      token: "tok-abc",
    }),
    fetch: ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        ),
        init,
      });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch,
  });
  return {
    calls,
    usage: usageSlice(transport),
    permissions: permissionsSlice(transport),
    registrar: registrarSlice(transport),
  };
}

const minimalPermissionRow: PermissionRequestRow = {
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

const registrarEntry = {
  registrar_id: "reg-1",
  slug: "reg-one",
  title: "T",
  home_project: "penumbra",
  source_doc_path: null,
  status: "active",
  created_at: 1,
  updated_at: 1,
};

const registrarDetail = {
  entry: registrarEntry,
  phases: [],
  events: [],
  rollup: { open_blockers: 0, open_follow_ups: 0 },
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("usage slice", () => {
  test("usage.recent sends projectId as the project_id query key", async () => {
    const { calls, usage } = makeApi({});
    await usage.recent({ projectId: "proj-a" });
    expect(calls[0]!.url.searchParams.get("project_id")).toBe("proj-a");
    expect(calls[0]!.url.searchParams.has("projectId")).toBe(false);
  });

  test("usage.recent forwards since unchanged", async () => {
    const { calls, usage } = makeApi({});
    await usage.recent({ since: "2026-11-01T00:00:00.000Z" });
    expect(calls[0]!.url.searchParams.get("since")).toBe("2026-11-01T00:00:00.000Z");
  });

  test("usage.recent with no options GETs /usage/recent with an empty query string", async () => {
    const { calls, usage } = makeApi({});
    await usage.recent();
    expect(calls[0]!.url.pathname).toBe("/usage/recent");
    expect(calls[0]!.url.search).toBe("");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  test("usage.quotaStatus forwards window", async () => {
    const { calls, usage } = makeApi({});
    await usage.quotaStatus({ window: "7d" });
    expect(calls[0]!.url.searchParams.get("window")).toBe("7d");
  });

  test("usage.subscriptionPressure sends staleAfterSeconds as stale_after_seconds", async () => {
    const { calls, usage } = makeApi({});
    await usage.subscriptionPressure({ staleAfterSeconds: 90 });
    expect(calls[0]!.url.searchParams.get("stale_after_seconds")).toBe("90");
    expect(calls[0]!.url.searchParams.has("staleAfterSeconds")).toBe(false);
  });

  test("usage.subscriptionPressure forwards provider", async () => {
    const { calls, usage } = makeApi({});
    await usage.subscriptionPressure({ provider: "anthropic" });
    expect(calls[0]!.url.searchParams.get("provider")).toBe("anthropic");
  });

  test("usage.subscriptionPressure with no options GETs /usage/subscription_pressure", async () => {
    const { calls, usage } = makeApi({});
    await usage.subscriptionPressure();
    expect(calls[0]!.url.pathname).toBe("/usage/subscription_pressure");
    expect(calls[0]!.url.search).toBe("");
  });
});

describe("permissions slice", () => {
  test("permissions.get returns the unwrapped permission row", async () => {
    const { permissions } = makeApi({ permission: minimalPermissionRow, server_note: "x" });
    const result = await permissions.get("p1");
    expect(result).toEqual(minimalPermissionRow);
  });

  test("permissions.get GETs /permissions/<encoded id>", async () => {
    const { calls, permissions } = makeApi({ permission: minimalPermissionRow });
    await permissions.get("p/1");
    expect(calls[0]!.url.pathname).toBe("/permissions/p%2F1");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  test("permissions.get rejects a bare row that lacks the permission envelope", async () => {
    const { permissions } = makeApi(minimalPermissionRow);
    const err = await rejection(permissions.get("p1"));
    expect(err).toBeInstanceOf(DaemonContractError);
  });
});

describe("registrar slice", () => {
  test("registrar.list GETs /registrar and returns its entries", async () => {
    const { calls, registrar } = makeApi({ entries: [registrarEntry] });
    const result = await registrar.list();
    expect(calls[0]!.url.pathname).toBe("/registrar");
    expect(result.entries[0]!.registrar_id).toBe("reg-1");
  });

  test("registrar.get GETs /registrar/<encoded id>", async () => {
    const { calls, registrar } = makeApi(registrarDetail);
    const result = await registrar.get("reg/1");
    expect(calls[0]!.url.pathname).toBe("/registrar/reg%2F1");
    expect(result.entry.registrar_id).toBe("reg-1");
  });

  test("registrar.events GETs /registrar/<encoded id>/events", async () => {
    const { calls, registrar } = makeApi({ events: [] });
    const result = await registrar.events("reg/1");
    expect(calls[0]!.url.pathname).toBe("/registrar/reg%2F1/events");
    expect(result.events).toEqual([]);
  });
});
