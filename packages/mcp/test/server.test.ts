import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { openInvocationSink } from "../src/invocation-sink.js";
import * as registry from "../src/invocation-sink-registry.js";
import { HandleStore } from "../src/handle-store.js";
import { isEnvelopeResult } from "../src/responses/envelope.js";
import { DEFAULT_BUDGET } from "../src/responses/budget.js";
import { buildServer } from "../src/server.js";
import { TOOL_REGISTRY } from "../src/tools/registry.js";
import { connectInMemory } from "./helpers.js";

const ENV_KEYS = [
  "PENUMBRA_MCP_TOOL_ALLOWLIST",
  "PENUMBRA_MCP_INVOCATION_LOG_ENABLED",
  "PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS",
  "PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID",
  "PENUMBRA_LONG_LIVED_AGENT_ID",
  "PENUMBRA_LONG_LIVED_TICK_ID",
  "PENUMBRA_STORAGE_ROOT",
  "XDG_STATE_HOME",
] as const;

const baselineEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
  for (const key of ENV_KEYS) {
    if (key === "PENUMBRA_MCP_INVOCATION_LOG_ENABLED") {
      delete process.env[key];
      continue;
    }
    const baseline = baselineEnv.get(key);
    if (baseline === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = baseline;
    }
  }
});

describe("buildServer tool registration", () => {
  it("registers only allowlisted tools when PENUMBRA_MCP_TOOL_ALLOWLIST is set", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "cost_recent,long_lived_self_state_get";
    const server = (await buildServer({ daemon: {} as any })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent", "long_lived_self_state_get"]);
  });

  it("registers all tools when allowlist env is unset", async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const server = (await buildServer({ daemon: {} as any })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual([...Object.keys(TOOL_REGISTRY), "read_handle"].sort());
  });

  it("shares one HandleStore between registry tools and read_handle", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__ctx_handle_store_probe,read_handle";
    const original = (TOOL_REGISTRY as any).__ctx_handle_store_probe;
    (TOOL_REGISTRY as any).__ctx_handle_store_probe = {
      descriptor: { description: "ctx handle store probe", inputSchema: {} },
      makeHandler: (_daemon: any, opts?: { handleStore?: HandleStore }) => async () => {
        const handleStore = opts?.handleStore;
        if (!handleStore) throw new Error("missing_handle_store");
        const handle_id = handleStore.put(JSON.stringify({ from: "ctx-probe", n: 1 }));
        return { handle_id };
      },
      handlerOpts: (ctx: { handleStore: HandleStore }) => ({ handleStore: ctx.handleStore }),
      readOnly: true,
    };
    try {
      const server = (await buildServer({ daemon: {} as any })) as any;
      const putOut = await server._registeredTools.__ctx_handle_store_probe.handler({});
      const handleId = (putOut as any)?.handle_id;
      expect(typeof handleId).toBe("string");

      const readOut = await server._registeredTools.read_handle.handler({ handle_id: handleId });
      expect((readOut as any)?.isError).toBeUndefined();
      expect((readOut as any)?.content?.[0]?.type).toBe("text");
      expect((readOut as any)?.content?.[0]?.text).toBe(
        JSON.stringify({ from: "ctx-probe", n: 1 }),
      );
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).__ctx_handle_store_probe;
      } else {
        (TOOL_REGISTRY as any).__ctx_handle_store_probe = original;
      }
    }
  });

  it("closes HandleStore on server close", async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const closeSpy = spyOn(HandleStore.prototype, "close");
    const server = await buildServer({ daemon: {} as any });
    await server.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("warns when workflow_wait is allowlisted without read_handle", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "workflow_wait";
    const lines: string[] = [];
    const original = console.error;
    console.error = ((msg: string) => {
      lines.push(msg);
    }) as any;
    try {
      await buildServer({ daemon: {} as any });
      const warning = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((row) => row?.event === "mcp_allowlist_read_handle_missing");
      expect(warning).toBeDefined();
      expect(warning.allowlisted_tools).toEqual(["workflow_wait"]);
    } finally {
      console.error = original;
    }
  });

  it("canonicalizes mcp__penumbra__ wire-form prefixed ids in allowlist entries", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST =
      "mcp__penumbra__cost_recent,mcp__penumbra__long_lived_self_state_get";
    const server = (await buildServer({ daemon: {} as any })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent", "long_lived_self_state_get"]);
  });

  it("canonicalizes penumbra: short-form allowlist entries", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST =
      "penumbra:cost_recent,penumbra:long_lived_self_state_get";
    const server = (await buildServer({ daemon: {} as any })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent", "long_lived_self_state_get"]);
  });

  it("passes through non-penumbra prefixed entries unchanged for federation matching", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "ha.ha_get_state,ha.ha_call_service";
    process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
    process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
    const server = (await buildServer({
      daemon: {
        getFederationTools: async () => ({
          tools: [{ name: "ha.ha_get_state" }, { name: "ha.ha_call_service" }],
        }),
        mcpCall: async () => ({ action_status: "executed", result: {} }),
      } as any,
    })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toContain("ha.ha_get_state");
    expect(names).toContain("ha.ha_call_service");
  });

  it("does not treat non-penumbra MCP-prefixed ids as valid allowlist entries", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "mcp__sirius__cost_recent";
    const server = (await buildServer({ daemon: {} as any })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual([]);
  });

  it("fails closed for malformed allowlist tool ids", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "mcp__penumbra_cost_recent,cost_recent";
    const server = (await buildServer({ daemon: {} as any })) as any;
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent"]);
  });

  it("emits federation registration health to stderr", async () => {
    let line = "";
    const error = mock((msg: string) => {
      line = msg;
    });
    const original = console.error;
    console.error = error as any;
    try {
      const daemon = {
        getFederationTools: async () => ({ tools: [{ name: "ha_get_state" }] }),
        mcpCall: async () => ({ action_status: "rejected", error: "unused" }),
      } as any;
      delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
      await buildServer({ daemon });
      expect(error).toHaveBeenCalledTimes(1);
      expect(JSON.parse(line)).toEqual({
        event: "federation.registered",
        registered_count: 0,
        skipped_count: 0,
        skipped: [],
      });
    } finally {
      console.error = original;
    }
  });

  it("long_lived_self_state_get resolves running agent from env context when called without args", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "penumbra-mcp-server-test-"));
    try {
      process.env.PENUMBRA_STORAGE_ROOT = storageRoot;
      process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "a1";
      process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
      delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;

      const db = new Database(join(storageRoot, "db.sqlite"));
      try {
        loadSqliteVec(db);
        applySchema(db, { embeddingDim: 384 });
        reconcileLongLivedAgents(
          db,
          [
            {
              name: "a1",
              long_lived: true,
              long_lived_config: {
                schedule_cron: "*/15 * * * *",
                subscriptions: [],
                mcp_allowlist: [],
                bounds: { wall_clock_ms: 1, cost_cents: 1, max_sub_dispatches: 0 },
                circuit_breaker_threshold: 3,
                standing_brief: "x",
              },
            } as any,
          ],
          { now: 1 },
        );
        db.query(
          "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'a1', 'manual', 1)",
        ).run();
      } finally {
        db.close();
      }

      const daemon = {
        getFederationTools: async () => ({ tools: [] }),
        mcpCall: async () => ({ action_status: "rejected", error: "unused" }),
      } as any;
      await buildServer({ daemon });
      const handler = TOOL_REGISTRY.long_lived_self_state_get.makeHandler({} as any);
      const result = await handler({});
      const payload = JSON.parse((result as any).content[0].text);
      expect(payload.working_memory.version).toBe(1);
      expect(payload.working_memory.pending_goals).toEqual([]);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  it("with invocation logging enabled, a registered tool produces exactly one JSONL row", async () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = "1";
    const stateRoot = mkdtempSync(join(tmpdir(), "penumbra-mcp-log-state-"));
    process.env.XDG_STATE_HOME = stateRoot;
    const logPath = join(stateRoot, "penumbra", "mcp-invocations.jsonl");
    // Stub initSink so buildServer's real init doesn't open a second fd to logPath.
    // The test owns the real sink fixture and feeds it via the getSink spy.
    spyOn(registry, "initSink").mockResolvedValue({} as any);
    const sink = openInvocationSink(logPath);
    spyOn(registry, "getSink").mockReturnValue(sink);
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__invocation_log_smoke_tool";
    const original = (TOOL_REGISTRY as any).__invocation_log_smoke_tool;
    (TOOL_REGISTRY as any).__invocation_log_smoke_tool = {
      descriptor: { description: "invocation-log smoke fixture", inputSchema: {} },
      makeHandler: () => async () => ({ ok: true }),
      readOnly: true,
    };
    try {
      // server._registeredTools is a private SDK field; tightly coupled to
      // @modelcontextprotocol/sdk internals. Acceptable for an integration smoke
      // until the SDK exposes a programmatic handler-invocation surface.
      const server = (await buildServer({ daemon: {} as any })) as any;
      await server._registeredTools.__invocation_log_smoke_tool.handler(
        {},
        { _meta: { origin: "test-suite" } },
      );
      await sink.close();
      const text = readFileSync(logPath, "utf8").trim();
      const rows = text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0].tool).toBe("__invocation_log_smoke_tool");
      expect(rows[0].ok).toBe(true);
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).__invocation_log_smoke_tool;
      } else {
        (TOOL_REGISTRY as any).__invocation_log_smoke_tool = original;
      }
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("with invocation logging disabled, no sink interaction occurs", async () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__invocation_log_disabled_smoke_tool";
    const initSinkSpy = spyOn(registry, "initSink");
    const getSinkSpy = spyOn(registry, "getSink");
    const original = (TOOL_REGISTRY as any).__invocation_log_disabled_smoke_tool;
    (TOOL_REGISTRY as any).__invocation_log_disabled_smoke_tool = {
      descriptor: { description: "invocation-log disabled-smoke fixture", inputSchema: {} },
      makeHandler: () => async () => ({ ok: true }),
      readOnly: true,
    };
    try {
      const server = (await buildServer({ daemon: {} as any })) as any;
      await server._registeredTools.__invocation_log_disabled_smoke_tool.handler(
        {},
        { _meta: { origin: "test-suite" } },
      );
      expect(initSinkSpy).not.toHaveBeenCalled();
      expect(getSinkSpy).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).__invocation_log_disabled_smoke_tool;
      } else {
        (TOOL_REGISTRY as any).__invocation_log_disabled_smoke_tool = original;
      }
    }
  });

  it("wraps oversized tool results with a handle that read_handle resolves", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__response_budget_smoke_tool,read_handle";
    const large = { blob: "x".repeat(128) };
    const original = (TOOL_REGISTRY as any).__response_budget_smoke_tool;
    (TOOL_REGISTRY as any).__response_budget_smoke_tool = {
      descriptor: { description: "response budget smoke fixture", inputSchema: {} },
      makeHandler: () => async () => large,
      readOnly: true,
    };
    try {
      const server = (await buildServer({ daemon: {} as any })) as any;
      const out = await server._registeredTools.__response_budget_smoke_tool.handler({}, {});
      expect(isEnvelopeResult(out)).toBe(true);
      expect(out._meta.handle_id).toBeTruthy();
      expect(out._meta.token_budget.truncated).toBe(true);
      expect(out.content[0].type).toBe("text");
      expect(out.content[0].text.length).toBeGreaterThan(0);
      const readOut = await server._registeredTools.read_handle.handler({
        handle_id: out._meta.handle_id,
      });
      expect(readOut.isError).toBeUndefined();
      expect(readOut.content[0].text).toBe(JSON.stringify(large));
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).__response_budget_smoke_tool;
      } else {
        (TOOL_REGISTRY as any).__response_budget_smoke_tool = original;
      }
      delete process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS;
    }
  });

  it("applies response budget to federated tools through the real MCP client path", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "ha.ha_get_state,read_handle";
    process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
    process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
    const large = { blob: "x".repeat(256) };
    const daemon = {
      getFederationTools: async () => ({
        tools: [{ name: "ha.ha_get_state", description: "get state" }],
      }),
      mcpCall: async () => ({ action_status: "executed", result: large }),
    } as any;
    const client = await connectInMemory(daemon);
    try {
      const out = (await client.callTool({
        name: "ha.ha_get_state",
        arguments: {},
      })) as any;
      expect(isEnvelopeResult(out)).toBe(true);
      expect(out._meta.token_budget.truncated).toBe(true);
      expect(out._meta.handle_id).toBeTruthy();
      expect(out.content[0].type).toBe("text");
      expect(out.content[0].text).toContain(`read_handle ${out._meta.handle_id}`);

      const readOut = (await client.callTool({
        name: "read_handle",
        arguments: { handle_id: out._meta.handle_id },
      })) as any;
      expect(readOut.isError).toBeUndefined();
      expect(readOut.content[0].text).toBe(JSON.stringify(large));
    } finally {
      await client.close();
    }
  });

  it("fails fast when PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS is invalid", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "not-a-number";
    await expect(buildServer({ daemon: {} as any })).rejects.toThrow(
      /PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS/,
    );

    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "-1";
    await expect(buildServer({ daemon: {} as any })).rejects.toThrow(
      /PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS/,
    );
  });

  it("buildServer is reentrant — second call with logging enabled does not throw", async () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = "1";
    spyOn(registry, "initSink").mockResolvedValue({} as any);
    spyOn(registry, "closeSink").mockResolvedValue(undefined);
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__invocation_log_reentrant_tool";
    const original = (TOOL_REGISTRY as any).__invocation_log_reentrant_tool;
    (TOOL_REGISTRY as any).__invocation_log_reentrant_tool = {
      descriptor: { description: "reentrant smoke fixture", inputSchema: {} },
      makeHandler: () => async () => ({ ok: true }),
      readOnly: true,
    };
    try {
      await buildServer({ daemon: {} as any });
      await expect(buildServer({ daemon: {} as any })).resolves.toBeDefined();
    } finally {
      if (original === undefined) {
        delete (TOOL_REGISTRY as any).__invocation_log_reentrant_tool;
      } else {
        (TOOL_REGISTRY as any).__invocation_log_reentrant_tool = original;
      }
    }
  });

  it("workflow_wait receives handleStore from the wrapped registry path", async () => {
    const huge = { payload: "x".repeat(DEFAULT_BUDGET * 6) };
    const store = new HandleStore();
    try {
      const handler = TOOL_REGISTRY.workflow_wait.makeHandler(
        {
          workflowWait: async () => ({
            status: "completed",
            started_at: 1,
            finished_at: 2,
            result: huge,
          }),
        } as any,
        { handleStore: store },
      );
      const out: any = await handler({ workflow_run_id: "run-1", timeout_ms: 1_000 });
      const body = JSON.parse(out.content[0].text);
      expect(typeof body.result_handle_id).toBe("string");
      expect(store.get(body.result_handle_id)).toBe(JSON.stringify(huge));
    } finally {
      store.close();
    }
  });

  it("workflow_run still applies handler opts when makeHandler is called with one arg", async () => {
    delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    const daemon = {
      workflowRun: mock(async (payload: Record<string, unknown>) => payload),
    };
    const handler = TOOL_REGISTRY.workflow_run.makeHandler(daemon as any);
    const out: any = await handler({ name: "test-workflow" });
    const body = JSON.parse(out.content[0].text) as Record<string, unknown>;
    expect(body.cwd).toBe(process.cwd());
    expect(body.resolution_warning).toBe("workflow_cwd_inferred_from_mcp_cwd");
    expect(daemon.workflowRun).toHaveBeenCalledTimes(1);
  });
});
