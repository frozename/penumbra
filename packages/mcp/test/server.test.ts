import { loadSqliteVec } from "@penumbra/core";
import { applySchema } from "@penumbra/core/db/schema";
import { reconcileLongLivedAgents } from "@penumbra/daemon/long-lived/reconciler";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "../src/daemon-client.js";

import { HandleStore } from "../src/handle-store.js";
import * as registry from "../src/invocation-sink-registry.js";
import { type InvocationSink, openInvocationSink } from "../src/invocation-sink.js";
import { DEFAULT_BUDGET } from "../src/responses/budget.js";
import { type EnvelopeResult, isEnvelopeResult } from "../src/responses/envelope.js";
import { buildServer } from "../src/server.js";
import { TOOL_REGISTRY, type ToolDef } from "../src/tools/registry.js";
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

const envDeleters: Record<(typeof ENV_KEYS)[number], () => void> = {
  PENUMBRA_MCP_TOOL_ALLOWLIST: () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
  },
  PENUMBRA_MCP_INVOCATION_LOG_ENABLED: () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  },
  PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS: () => {
    delete process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS;
  },
  PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID: () => {
    delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  },
  PENUMBRA_LONG_LIVED_AGENT_ID: () => {
    delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  },
  PENUMBRA_LONG_LIVED_TICK_ID: () => {
    delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  },
  PENUMBRA_STORAGE_ROOT: () => {
    delete process.env.PENUMBRA_STORAGE_ROOT;
  },
  XDG_STATE_HOME: () => {
    delete process.env.XDG_STATE_HOME;
  },
};

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
  for (const key of ENV_KEYS) {
    if (key === "PENUMBRA_MCP_INVOCATION_LOG_ENABLED") {
      envDeleters[key]();
      continue;
    }
    const baseline = baselineEnv.get(key);
    if (baseline === undefined) {
      envDeleters[key]();
    } else {
      process.env[key] = baseline;
    }
  }
});

type ToolHandler = (args: unknown, extra?: unknown) => Promise<unknown>;
interface RegisteredTool {
  handler: ToolHandler;
}
interface RegisteredServer {
  _registeredTools: Record<string, RegisteredTool>;
  close: () => Promise<void>;
}

interface ToolContent {
  type: string;
  text?: string;
}
interface ToolCallResult {
  content?: ToolContent[];
  isError?: boolean;
  _meta?: { handle_id?: string; token_budget?: { truncated?: boolean } };
}

function asRegisteredServer(s: unknown): RegisteredServer {
  return s as RegisteredServer;
}
function fakeDaemon(partial: Partial<DaemonClient> = {}): DaemonClient {
  // Test-only boundary: synthesize a structurally minimal DaemonClient. The
  // server only touches the methods overridden by each test, never the
  // private fields, so this cast is safe across the test boundary.
  return partial as unknown as DaemonClient;
}
function asToolResult(v: unknown): ToolCallResult {
  return v as ToolCallResult;
}
function asEnvelope(v: unknown): EnvelopeResult {
  if (!isEnvelopeResult(v)) throw new Error("expected envelope result");
  return v;
}
function constantMakeHandler(value: unknown): ToolDef["makeHandler"] {
  return (): ((args: unknown) => Promise<unknown>) =>
    (_args: unknown): Promise<unknown> =>
      Promise.resolve(value);
}

describe("buildServer tool registration", () => {
  it("registers only allowlisted tools when PENUMBRA_MCP_TOOL_ALLOWLIST is set", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "cost_recent,long_lived_self_state_get";
    const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent", "long_lived_self_state_get"]);
  });

  it("registers all tools when allowlist env is unset", async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual([...Object.keys(TOOL_REGISTRY), "read_handle"].sort());
  });

  it("shares one HandleStore between registry tools and read_handle", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__ctx_handle_store_probe,read_handle";
    const original: ToolDef | undefined = TOOL_REGISTRY.__ctx_handle_store_probe;
    TOOL_REGISTRY.__ctx_handle_store_probe = {
      descriptor: { description: "ctx handle store probe", inputSchema: {} },
      makeHandler:
        (_daemon, opts?: unknown): ((args: unknown) => Promise<unknown>) =>
        (_args: unknown): Promise<unknown> => {
          const handleStore = (opts as { handleStore?: HandleStore } | undefined)?.handleStore;
          if (!handleStore) throw new Error("missing_handle_store");
          const handle_id = handleStore.put(JSON.stringify({ from: "ctx-probe", n: 1 }));
          return Promise.resolve({ handle_id });
        },
      handlerOpts: (ctx): { handleStore: HandleStore } => ({ handleStore: ctx.handleStore }),
      readOnly: true,
    };
    try {
      const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
      const putOut = (await server._registeredTools.__ctx_handle_store_probe.handler({})) as {
        handle_id?: string;
      };
      const handleId = putOut.handle_id;
      expect(typeof handleId).toBe("string");

      const readOut = asToolResult(
        await server._registeredTools.read_handle.handler({ handle_id: handleId }),
      );
      expect(readOut.isError).toBeUndefined();
      expect(readOut.content?.[0]?.type).toBe("text");
      expect(readOut.content?.[0]?.text).toBe(JSON.stringify({ from: "ctx-probe", n: 1 }));
    } finally {
      if (original === undefined) {
        delete TOOL_REGISTRY.__ctx_handle_store_probe;
      } else {
        TOOL_REGISTRY.__ctx_handle_store_probe = original;
      }
    }
  });

  it("closes HandleStore on server close", async () => {
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const closeSpy = spyOn(HandleStore.prototype, "close");
    const server = await buildServer({ daemon: fakeDaemon() });
    await server.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes invocation sink on server close when logging is enabled", async () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = "1";
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const sinkStub: InvocationSink = {
      write: () => undefined,
      close: () => Promise.resolve(),
    };
    spyOn(registry, "initSink").mockResolvedValue(sinkStub);
    const closeSinkSpy = spyOn(registry, "closeSink").mockResolvedValue(undefined);
    const server = await buildServer({ daemon: fakeDaemon() });
    const preCloseCount = closeSinkSpy.mock.calls.length;
    await server.close();
    expect(closeSinkSpy.mock.calls.length).toBeGreaterThan(preCloseCount);
  });

  it("does NOT close invocation sink on server close when logging is disabled", async () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
    const closeSinkSpy = spyOn(registry, "closeSink").mockResolvedValue(undefined);
    const server = await buildServer({ daemon: fakeDaemon() });
    const preCloseCount = closeSinkSpy.mock.calls.length;
    await server.close();
    expect(closeSinkSpy.mock.calls.length).toBe(preCloseCount);
  });

  it("warns when workflow_wait is allowlisted without read_handle", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "workflow_wait";
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    }) as typeof console.error;
    try {
      await buildServer({ daemon: fakeDaemon() });
      const warning = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (row): row is Record<string, unknown> =>
            row !== null && row.event === "mcp_allowlist_read_handle_missing",
        );
      expect(warning).toBeDefined();
      expect(warning?.allowlisted_tools).toEqual(["workflow_wait"]);
      expect(warning?.handle_producing_allowlisted).toEqual(["workflow_wait"]);
    } finally {
      console.error = original;
    }
  });

  it("warns for any handle-producing tool (not just workflow_wait) when read_handle excluded", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "fs_read,fs_write";
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    }) as typeof console.error;
    try {
      await buildServer({ daemon: fakeDaemon() });
      const warning = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (row): row is Record<string, unknown> =>
            row !== null && row.event === "mcp_allowlist_read_handle_missing",
        );
      expect(warning).toBeDefined();
      expect(warning?.handle_producing_allowlisted).toEqual(["fs_read", "fs_write"]);
    } finally {
      console.error = original;
    }
  });

  it("warns when env budget is set but read_handle is excluded", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "cost_recent";
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1024";
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    }) as typeof console.error;
    try {
      await buildServer({ daemon: fakeDaemon() });
      const warning = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (row): row is Record<string, unknown> =>
            row !== null && row.event === "mcp_allowlist_read_handle_missing",
        );
      expect(warning).toBeDefined();
      expect(warning?.central_budget_disabled).toBe(true);
      expect(warning?.handle_producing_allowlisted).toEqual([]);
    } finally {
      console.error = original;
    }
  });

  it("does NOT warn when read_handle is excluded but no budget and no handle-producing tools are allowlisted", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "cost_recent";
    delete process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS;
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    }) as typeof console.error;
    try {
      await buildServer({ daemon: fakeDaemon() });
      const warning = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (row): row is Record<string, unknown> =>
            row !== null && row.event === "mcp_allowlist_read_handle_missing",
        );
      expect(warning).toBeUndefined();
    } finally {
      console.error = original;
    }
  });

  it("disables central response budgeting (no envelope/handle) when read_handle is excluded", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__no_read_handle_budget_smoke_tool";
    const large = { blob: "x".repeat(512) };
    const original: ToolDef | undefined = TOOL_REGISTRY.__no_read_handle_budget_smoke_tool;
    TOOL_REGISTRY.__no_read_handle_budget_smoke_tool = {
      descriptor: { description: "no-read-handle budget smoke fixture", inputSchema: {} },
      makeHandler: constantMakeHandler(large),
      readOnly: true,
    };
    try {
      const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
      const out = await server._registeredTools.__no_read_handle_budget_smoke_tool.handler({}, {});
      // Budget should be disabled — result passes through untruncated, not wrapped.
      expect(isEnvelopeResult(out)).toBe(false);
      expect(out).toEqual(large);
    } finally {
      if (original === undefined) {
        delete TOOL_REGISTRY.__no_read_handle_budget_smoke_tool;
      } else {
        TOOL_REGISTRY.__no_read_handle_budget_smoke_tool = original;
      }
      delete process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS;
    }
  });

  it("canonicalizes mcp__penumbra__ wire-form prefixed ids in allowlist entries", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST =
      "mcp__penumbra__cost_recent,mcp__penumbra__long_lived_self_state_get";
    const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent", "long_lived_self_state_get"]);
  });

  it("canonicalizes penumbra: short-form allowlist entries", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST =
      "penumbra:cost_recent,penumbra:long_lived_self_state_get";
    const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent", "long_lived_self_state_get"]);
  });

  it("passes through non-penumbra prefixed entries unchanged for federation matching", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "ha.ha_get_state,ha.ha_call_service";
    process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
    process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
    const server = asRegisteredServer(
      await buildServer({
        daemon: fakeDaemon({
          getFederationTools: () =>
            Promise.resolve({
              tools: [{ name: "ha.ha_get_state" }, { name: "ha.ha_call_service" }],
            }),
          mcpCall: () => Promise.resolve({ action_status: "executed", result: {} }),
        }),
      }),
    );
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toContain("ha.ha_get_state");
    expect(names).toContain("ha.ha_call_service");
  });

  it("does not treat non-penumbra MCP-prefixed ids as valid allowlist entries", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "mcp__sirius__cost_recent";
    const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual([]);
  });

  it("fails closed for malformed allowlist tool ids", async () => {
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "mcp__penumbra_cost_recent,cost_recent";
    const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
    const names = Object.keys(server._registeredTools).sort();
    expect(names).toEqual(["cost_recent"]);
  });

  it("emits federation registration health to stderr", async () => {
    let line = "";
    const error = mock((msg: unknown): void => {
      if (typeof msg === "string") line = msg;
    });
    const original = console.error;
    console.error = error as typeof console.error;
    try {
      const daemon = fakeDaemon({
        getFederationTools: () => Promise.resolve({ tools: [{ name: "ha_get_state" }] }),
        mcpCall: () => Promise.resolve({ action_status: "rejected", error: "unused" }),
      });
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

  it("emits a distinct fetch_failed event when the daemon federation fetch throws", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = ((...args: unknown[]) => {
      if (typeof args[0] === "string") lines.push(args[0]);
    }) as typeof console.error;
    const warnOriginal = console.warn;
    console.warn = ((): void => undefined) as typeof console.warn;
    try {
      process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
      process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
      delete process.env.PENUMBRA_MCP_TOOL_ALLOWLIST;
      const daemon = fakeDaemon({
        getFederationTools: () => Promise.reject(new Error("boom")),
      });
      await buildServer({ daemon });
      const events = lines
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((row): row is Record<string, unknown> => row !== null);
      const fetchFailed = events.find((row) => row.event === "federation.fetch_failed");
      const registered = events.find((row) => row.event === "federation.registered");
      expect(fetchFailed).toBeDefined();
      expect(registered).toBeDefined();
      // The registered event must also carry fetch_failed so a single-line grep
      // catches both a total failure AND a legitimately-empty registration.
      expect(registered?.fetch_failed).toBe(true);
    } finally {
      console.error = original;
      console.warn = warnOriginal;
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
            } as unknown as Parameters<typeof reconcileLongLivedAgents>[1][number],
          ],
          { now: 1 },
        );
        db.query(
          "INSERT INTO long_lived_ticks (id, agent_id, trigger_kind, started_at) VALUES ('tick-1', 'a1', 'manual', 1)",
        ).run();
      } finally {
        db.close();
      }

      const daemon = fakeDaemon({
        getFederationTools: () => Promise.resolve({ tools: [] }),
        mcpCall: () => Promise.resolve({ action_status: "rejected", error: "unused" }),
      });
      await buildServer({ daemon });
      const handler = TOOL_REGISTRY.long_lived_self_state_get.makeHandler(fakeDaemon());
      const result = asToolResult(await handler({}));
      const text = result.content?.[0]?.text ?? "";
      const payload = JSON.parse(text) as {
        working_memory: { version: number; pending_goals: unknown[] };
      };
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
    const sinkStub: InvocationSink = {
      write: () => undefined,
      close: () => Promise.resolve(),
    };
    // Stub initSink so buildServer's real init doesn't open a second fd to logPath.
    // The test owns the real sink fixture and feeds it via the getSink spy.
    spyOn(registry, "initSink").mockResolvedValue(sinkStub);
    const sink = openInvocationSink(logPath);
    spyOn(registry, "getSink").mockReturnValue(sink);
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__invocation_log_smoke_tool";
    const original: ToolDef | undefined = TOOL_REGISTRY.__invocation_log_smoke_tool;
    TOOL_REGISTRY.__invocation_log_smoke_tool = {
      descriptor: { description: "invocation-log smoke fixture", inputSchema: {} },
      makeHandler: constantMakeHandler({ ok: true }),
      readOnly: true,
    };
    try {
      // server._registeredTools is a private SDK field; tightly coupled to
      // @modelcontextprotocol/sdk internals. Acceptable for an integration smoke
      // until the SDK exposes a programmatic handler-invocation surface.
      const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
      await server._registeredTools.__invocation_log_smoke_tool.handler(
        {},
        { _meta: { origin: "test-suite" } },
      );
      await sink.close();
      const text = readFileSync(logPath, "utf8").trim();
      const rows =
        text.length === 0
          ? []
          : text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tool).toBe("__invocation_log_smoke_tool");
      expect(rows[0]?.ok).toBe(true);
    } finally {
      if (original === undefined) {
        delete TOOL_REGISTRY.__invocation_log_smoke_tool;
      } else {
        TOOL_REGISTRY.__invocation_log_smoke_tool = original;
      }
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("with invocation logging disabled, no sink interaction occurs", async () => {
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__invocation_log_disabled_smoke_tool";
    const initSinkSpy = spyOn(registry, "initSink");
    const getSinkSpy = spyOn(registry, "getSink");
    const original: ToolDef | undefined = TOOL_REGISTRY.__invocation_log_disabled_smoke_tool;
    TOOL_REGISTRY.__invocation_log_disabled_smoke_tool = {
      descriptor: { description: "invocation-log disabled-smoke fixture", inputSchema: {} },
      makeHandler: constantMakeHandler({ ok: true }),
      readOnly: true,
    };
    try {
      const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
      await server._registeredTools.__invocation_log_disabled_smoke_tool.handler(
        {},
        { _meta: { origin: "test-suite" } },
      );
      expect(initSinkSpy).not.toHaveBeenCalled();
      expect(getSinkSpy).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete TOOL_REGISTRY.__invocation_log_disabled_smoke_tool;
      } else {
        TOOL_REGISTRY.__invocation_log_disabled_smoke_tool = original;
      }
    }
  });

  it("wraps oversized tool results with a handle that read_handle resolves", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__response_budget_smoke_tool,read_handle";
    const large = { blob: "x".repeat(128) };
    const original: ToolDef | undefined = TOOL_REGISTRY.__response_budget_smoke_tool;
    TOOL_REGISTRY.__response_budget_smoke_tool = {
      descriptor: { description: "response budget smoke fixture", inputSchema: {} },
      makeHandler: constantMakeHandler(large),
      readOnly: true,
    };
    try {
      const server = asRegisteredServer(await buildServer({ daemon: fakeDaemon() }));
      const out = await server._registeredTools.__response_budget_smoke_tool.handler({}, {});
      expect(isEnvelopeResult(out)).toBe(true);
      const env = asEnvelope(out);
      expect(env._meta.handle_id).toBeTruthy();
      expect(env._meta.token_budget?.truncated).toBe(true);
      expect(env.content[0]?.type).toBe("text");
      expect((env.content[0]?.text ?? "").length).toBeGreaterThan(0);
      const readOut = asToolResult(
        await server._registeredTools.read_handle.handler({
          handle_id: env._meta.handle_id,
        }),
      );
      expect(readOut.isError).toBeUndefined();
      expect(readOut.content?.[0]?.text).toBe(JSON.stringify(large));
    } finally {
      if (original === undefined) {
        delete TOOL_REGISTRY.__response_budget_smoke_tool;
      } else {
        TOOL_REGISTRY.__response_budget_smoke_tool = original;
      }
      delete process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS;
    }
  });

  it("uses the global response-budget wrapper for retired envelope tools", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "memory_search,read_handle";
    const large = { hits: [{ body: "x".repeat(256) }], total: 1 };
    const daemon = fakeDaemon({
      memorySearch: () => Promise.resolve(large),
    });

    const server = asRegisteredServer(await buildServer({ daemon }));
    const out = await server._registeredTools.memory_search.handler({ query: "budget" }, {});

    const memorySearchInputSchema = TOOL_REGISTRY.memory_search.descriptor.inputSchema as Record<
      string,
      unknown
    >;
    expect("envelope" in memorySearchInputSchema).toBe(false);
    expect(isEnvelopeResult(out)).toBe(true);
    const env = asEnvelope(out);
    expect(env._meta.handle_id).toBeTruthy();
    expect(env._meta.token_budget?.truncated).toBe(true);
    expect(env.content[0]?.text).toContain(`read_handle ${env._meta.handle_id ?? ""}`);

    const readOut = asToolResult(
      await server._registeredTools.read_handle.handler({
        handle_id: env._meta.handle_id,
      }),
    );
    expect(readOut.isError).toBeUndefined();
    expect(readOut.content?.[0]?.text).toBe(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(large, null, 2) }] }),
    );
  });

  it("applies response budget to federated tools through the real MCP client path", async () => {
    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "1";
    delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "ha.ha_get_state,read_handle";
    process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
    process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
    const large = { blob: "x".repeat(256) };
    const daemon = fakeDaemon({
      getFederationTools: () =>
        Promise.resolve({
          tools: [{ name: "ha.ha_get_state", description: "get state" }],
        }),
      mcpCall: () => Promise.resolve({ action_status: "executed", result: large }),
    });
    const client = await connectInMemory(daemon);
    try {
      const out = await client.callTool({
        name: "ha.ha_get_state",
        arguments: {},
      });
      expect(isEnvelopeResult(out)).toBe(true);
      const env = asEnvelope(out);
      expect(env._meta.token_budget?.truncated).toBe(true);
      expect(env._meta.handle_id).toBeTruthy();
      expect(env.content[0]?.type).toBe("text");
      expect(env.content[0]?.text).toContain(`read_handle ${env._meta.handle_id ?? ""}`);

      const readOut = asToolResult(
        await client.callTool({
          name: "read_handle",
          arguments: { handle_id: env._meta.handle_id },
        }),
      );
      expect(readOut.isError).toBeUndefined();
      expect(readOut.content?.[0]?.text).toBe(JSON.stringify(large));
    } finally {
      await client.close();
    }
  });

  it("fails fast when PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS is invalid", async () => {
    const captureBuildError = async (): Promise<string> => {
      try {
        await buildServer({ daemon: fakeDaemon() });
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error("buildServer unexpectedly resolved");
    };

    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "not-a-number";
    expect(await captureBuildError()).toMatch(/PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS/);

    process.env.PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS = "-1";
    expect(await captureBuildError()).toMatch(/PENUMBRA_MCP_RESPONSE_BUDGET_TOKENS/);
  });

  it("buildServer is reentrant — second call with logging enabled does not throw", async () => {
    process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = "1";
    const sinkStub: InvocationSink = {
      write: () => undefined,
      close: () => Promise.resolve(),
    };
    spyOn(registry, "initSink").mockResolvedValue(sinkStub);
    spyOn(registry, "closeSink").mockResolvedValue(undefined);
    process.env.PENUMBRA_MCP_TOOL_ALLOWLIST = "__invocation_log_reentrant_tool";
    const original: ToolDef | undefined = TOOL_REGISTRY.__invocation_log_reentrant_tool;
    TOOL_REGISTRY.__invocation_log_reentrant_tool = {
      descriptor: { description: "reentrant smoke fixture", inputSchema: {} },
      makeHandler: constantMakeHandler({ ok: true }),
      readOnly: true,
    };
    try {
      await buildServer({ daemon: fakeDaemon() });
      const second = await buildServer({ daemon: fakeDaemon() });
      expect(second).toBeDefined();
    } finally {
      if (original === undefined) {
        delete TOOL_REGISTRY.__invocation_log_reentrant_tool;
      } else {
        TOOL_REGISTRY.__invocation_log_reentrant_tool = original;
      }
    }
  });

  it("workflow_wait receives handleStore from the wrapped registry path", async () => {
    const huge = { payload: "x".repeat(DEFAULT_BUDGET * 6) };
    const store = new HandleStore();
    try {
      const handler = TOOL_REGISTRY.workflow_wait.makeHandler(
        fakeDaemon({
          workflowWait: () =>
            Promise.resolve({
              status: "completed",
              started_at: 1,
              finished_at: 2,
              result: huge,
            }),
        }),
        { handleStore: store },
      );
      const out = asToolResult(await handler({ workflow_run_id: "run-1", timeout_ms: 1_000 }));
      const body = JSON.parse(out.content?.[0]?.text ?? "") as { result_handle_id?: string };
      expect(typeof body.result_handle_id).toBe("string");
      expect(store.get(body.result_handle_id ?? "")).toBe(JSON.stringify(huge));
    } finally {
      store.close();
    }
  });

  it("workflow_run still applies handler opts when makeHandler is called with one arg", async () => {
    delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
    const workflowRunMock = mock((payload: Record<string, unknown>) => Promise.resolve(payload));
    const daemon = fakeDaemon({
      workflowRun: workflowRunMock as unknown as DaemonClient["workflowRun"],
    });
    const handler = TOOL_REGISTRY.workflow_run.makeHandler(daemon);
    const out = asToolResult(await handler({ name: "test-workflow" }));
    const body = JSON.parse(out.content?.[0]?.text ?? "") as Record<string, unknown>;
    expect(body.cwd).toBe(process.cwd());
    expect(body.resolution_warning).toBe("workflow_cwd_inferred_from_mcp_cwd");
    expect(workflowRunMock).toHaveBeenCalledTimes(1);
  });
});
