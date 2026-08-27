import {
  ChainStartRequestSchema as ApiChainStartRequestSchema,
  ChainsListResponseSchema,
  DispatchEventSchema,
  DispatchEventsListResponseSchema,
  HandoffRowSchema,
  HandoffsListResponseSchema,
  TasksListResponseSchema,
  UsageQuotaResponseSchema,
  UsageRecentResponseSchema,
  UsageSubscriptionPressureResponseSchema,
} from "@penumbra/api-contract";
import {
  buildServices,
  ChainStartRequestSchema as CoreChainStartRequestSchema,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDaemonFetchHandler } from "../src/serve.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore
}

interface TestHarness {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  services: Services;
  stop: () => void;
}

function startHarness(): TestHarness {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "api-contract-"));
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: root,
    worktreeRootDir: join(root, "worktrees"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-04-23T12:00:00.000Z"),
  });
  const handler = createDaemonFetchHandler({ services, token: "tok" });
  return {
    fetch: (path: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer tok");
      return handler(
        new Request(`http://x${path}`, {
          ...init,
          headers,
        }),
      );
    },
    services,
    stop: (): void => {
      try {
        services.supervisor.stopAll();
      } catch {
        // ignore
      }
      try {
        db.close();
      } catch {
        // ignore
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("GET /chains response shape matches ChainsListResponseSchema", async () => {
  const h = startHarness();
  try {
    h.services.handoffWriter.createApproved({
      handoff_id: "h-1",
      ts: "2026-04-23T11:00:00.000Z",
      project_id: null,
      conversation_id: "c-1",
      from: "user",
      to: "codex",
      to_role: null,
      message: "go",
      triggered_by_event_id: "e-1",
      resolved_by: "test",
      resolved_at: null,
      chain_max_hops: null,
      chain_trust_mode: null,
      chain_task_type: null,
      use_worktree: null,
      parent_handoff_id: null,
      branch_base: null,
    });
    const res = await h.fetch("/chains");
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = ChainsListResponseSchema.safeParse(body);
    if (!parsed.success) console.error("chains parse:", parsed.error.issues);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.chains).toHaveLength(1);
    expect(parsed.data?.chains[0]?.conversation_id).toBe("c-1");
  } finally {
    h.stop();
  }
});

test("chain-start request contracts expose the same typed tool_free field", () => {
  const input = {
    initial_agent: "executor",
    message: "summarize",
    tool_free: true,
  };

  expect(ApiChainStartRequestSchema.shape.tool_free.safeParse("true").success).toBe(false);
  expect(ApiChainStartRequestSchema.parse(input).tool_free).toBe(
    CoreChainStartRequestSchema.parse(input).tool_free,
  );
});

test("chain-start request contracts preserve explicit false tool_free", () => {
  const input = {
    initial_agent: "executor",
    message: "summarize",
    tool_free: false,
  };

  const apiParsed = ApiChainStartRequestSchema.parse(input);
  const coreParsed = CoreChainStartRequestSchema.parse(input);

  expect(apiParsed.tool_free).toBe(false);
  expect(coreParsed.tool_free).toBe(false);
});

test("chain-start request contracts leave absent tool_free absent", () => {
  const input = {
    initial_agent: "executor",
    message: "summarize",
  };

  const apiParsed = ApiChainStartRequestSchema.parse(input);
  const coreParsed = CoreChainStartRequestSchema.parse(input);

  expect(Object.prototype.hasOwnProperty.call(apiParsed, "tool_free")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(coreParsed, "tool_free")).toBe(false);
  expect(apiParsed.tool_free).toBeUndefined();
  expect(coreParsed.tool_free).toBeUndefined();
});

test("GET /handoffs?status=pending response shape matches HandoffsListResponseSchema", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/handoffs?status=pending");
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = HandoffsListResponseSchema.safeParse(body);
    if (!parsed.success) console.error("handoffs parse:", parsed.error.issues);
    expect(parsed.success).toBe(true);
  } finally {
    h.stop();
  }
});

test("handoffs row shape parses as HandoffRowSchema", () => {
  const h = startHarness();
  try {
    h.services.handoffWriter.createApproved({
      handoff_id: "h-2",
      ts: "2026-04-23T11:00:00.000Z",
      project_id: "p-1",
      conversation_id: "c-2",
      from: "user",
      to: "codex",
      to_role: null,
      message: "do",
      triggered_by_event_id: "e-2",
      resolved_by: "test",
      resolved_at: null,
      chain_max_hops: 8,
      chain_trust_mode: "all",
      chain_task_type: null,
      use_worktree: true,
      parent_handoff_id: null,
      branch_base: null,
    });
    const row = h.services.handoffReader.get("h-2");
    expect(row).not.toBeNull();
    const parsed = HandoffRowSchema.safeParse(row);
    if (!parsed.success) console.error("row parse:", parsed.error.issues);
    expect(parsed.success).toBe(true);
  } finally {
    h.stop();
  }
});

test("GET /tasks response shape matches TasksListResponseSchema", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/tasks");
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = TasksListResponseSchema.safeParse(body);
    if (!parsed.success) console.error("tasks parse:", parsed.error.issues);
    expect(parsed.success).toBe(true);
  } finally {
    h.stop();
  }
});

test("GET /dispatch/events?handoff_id matches DispatchEventsListResponseSchema", async () => {
  const h = startHarness();
  try {
    h.services.dispatchEventLog.record({
      handoff_id: "h-1",
      worker_id: "w-1",
      source: "worker",
      kind: "dispatch.start",
      ts: "2026-04-23T12:00:00.000Z",
      meta: { thing: 1 },
    });
    const res = await h.fetch("/dispatch/events?handoff_id=h-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = DispatchEventsListResponseSchema.safeParse(body);
    if (!parsed.success) console.error("dispatch list parse:", parsed.error.issues);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.events).toHaveLength(1);
    const event = DispatchEventSchema.safeParse(parsed.data?.events[0]);
    if (!event.success) console.error("dispatch event parse:", event.error.issues);
    expect(event.success).toBe(true);
  } finally {
    h.stop();
  }
});

test("GET /usage/recent matches UsageRecentResponseSchema (loose)", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/usage/recent");
    expect(res.status).toBe(200);
    const parsed = UsageRecentResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  } finally {
    h.stop();
  }
});

test("GET /usage/quota_status matches UsageQuotaResponseSchema", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/usage/quota_status");
    expect(res.status).toBe(200);
    const parsed = UsageQuotaResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  } finally {
    h.stop();
  }
});

test("GET /usage/subscription_pressure matches UsageSubscriptionPressureResponseSchema", async () => {
  const h = startHarness();
  try {
    const res = await h.fetch("/usage/subscription_pressure");
    expect(res.status).toBe(200);
    const parsed = UsageSubscriptionPressureResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
  } finally {
    h.stop();
  }
});
