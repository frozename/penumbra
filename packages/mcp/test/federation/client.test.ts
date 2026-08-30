import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonClient } from "@src/daemon-client.js";
import { registerFederatedTools } from "@src/federation/client.js";
import { HandleStore } from "@src/handle-store.js";
import * as registry from "@src/invocation-sink-registry.js";
import { openInvocationSink } from "@src/invocation-sink.js";
import { setLongLivedRuntimeContextFromEnv } from "@src/long-lived-context.js";
import { isEnvelopeResult } from "@src/responses/envelope.js";
import { readHandleHandler } from "@src/tools/read-handle.js";

type FederationDaemon = Pick<DaemonClient, "getFederationTools" | "mcpCall">;
type GetFederationTools = DaemonClient["getFederationTools"];
type McpCall = DaemonClient["mcpCall"];

const defaultGetFederationTools: GetFederationTools = () => Promise.resolve({ tools: [] });
const defaultMcpCall: McpCall = () =>
  Promise.resolve({ action_status: "executed", result: { ok: true } });

function makeDaemon(opts: {
  getFederationTools?: GetFederationTools;
  mcpCall?: McpCall;
}): FederationDaemon {
  return {
    getFederationTools: mock(opts.getFederationTools ?? defaultGetFederationTools),
    mcpCall: mock(opts.mcpCall ?? defaultMcpCall),
  };
}

function makeMcpServer(): McpServer {
  return new McpServer({ name: "probe", version: "0.0.0" });
}

interface RegisteredToolEntry {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
  inputSchema: { parse: (x: unknown) => unknown };
}

// The MCP SDK marks `_registeredTools` as private on McpServer; that's a real
// library type gap (the field exists at runtime and is the only way to access
// the stored handler/inputSchema in these regression tests). Cast through
// unknown once via this typed shim instead of sprinkling `as any` at every site.
interface RegisteredToolsView {
  _registeredTools: Record<string, RegisteredToolEntry>;
}

function getRegisteredTools(server: McpServer): Record<string, RegisteredToolEntry> {
  return (server as unknown as RegisteredToolsView)._registeredTools;
}

function getRegisteredTool(server: McpServer, name: string): RegisteredToolEntry {
  const entry = getRegisteredTools(server)[name];
  if (!entry) throw new Error(`registered tool not found: ${name}`);
  return entry;
}

afterEach(async () => {
  mock.restore();
  await registry.closeSink();
  delete process.env.PENUMBRA_LONG_LIVED_AGENT_ID;
  delete process.env.PENUMBRA_LONG_LIVED_TICK_ID;
  delete process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED;
  setLongLivedRuntimeContextFromEnv(process.env);
});

test("returns empty and registers no tools when no long-lived identity is available", async () => {
  setLongLivedRuntimeContextFromEnv({});
  const server = makeMcpServer();
  const registerSpy = spyOn(server, "registerTool");
  const daemon = makeDaemon({});
  const result = await registerFederatedTools({ server, daemon });
  expect(result).toEqual({ registered: [], skipped: [] });
  expect(registerSpy).not.toHaveBeenCalled();
});

test("bootstraps federated tools from daemon and registers one handler per tool", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const registerSpy = spyOn(server, "registerTool");
  const daemon = makeDaemon({
    getFederationTools: () =>
      Promise.resolve({
        tools: [
          { name: "ha.state_get", description: "get state" },
          { name: "ha.state_set", inputSchema: { type: "object" } },
        ],
      }),
  });
  const result = await registerFederatedTools({ server, daemon });
  expect(result.registered).toEqual([
    { name: "ha.state_get", description: "get state" },
    { name: "ha.state_set", inputSchema: { type: "object" } },
  ]);
  expect(result.skipped).toEqual([]);
  expect(registerSpy).toHaveBeenCalledTimes(2);
});

test("env allowlist filters federated tools before registration", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const registerSpy = spyOn(server, "registerTool");
  const daemon = makeDaemon({
    getFederationTools: () =>
      Promise.resolve({
        tools: [
          { name: "ha.ha_get_state", description: "get state" },
          { name: "ha.ha_call_service", description: "call service" },
        ],
      }),
  });
  const result = await registerFederatedTools({
    server,
    daemon,
    envAllowlist: new Set(["ha.ha_get_state"]),
  });
  expect(result.registered).toEqual([{ name: "ha.ha_get_state", description: "get state" }]);
  expect(result.skipped).toEqual([]);
  expect(registerSpy).toHaveBeenCalledTimes(1);
});

test("env allowlist accepts canonical federation tool ids", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const registerSpy = spyOn(server, "registerTool");
  const daemon = makeDaemon({
    getFederationTools: () =>
      Promise.resolve({
        tools: [
          { name: "ha.ha_get_state", description: "state" },
          { name: "ha.ha_call_service", description: "service" },
        ],
      }),
  });
  const result = await registerFederatedTools({
    server,
    daemon,
    envAllowlist: new Set(["ha.ha_get_state", "ha.ha_call_service"]),
  });
  expect(result.registered.map((t) => t.name)).toEqual(["ha.ha_get_state", "ha.ha_call_service"]);
  expect(registerSpy).toHaveBeenCalledTimes(2);
});

test("virtual tool handler posts to daemon and returns executed result verbatim", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.state_get" }] }),
    mcpCall: (req) => {
      expect(req).toEqual({
        agent_id: "agent-1",
        tick_id: "tick-1",
        tool: "ha:state_get",
        args: { entity_id: "light.kitchen" },
      });
      return Promise.resolve({ action_status: "executed", result: { ok: true } });
    },
  });
  await registerFederatedTools({ server, daemon });
  const entry = getRegisteredTool(server, "ha.state_get");
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });
  expect(await entry.handler(validated, {})).toEqual({ ok: true });
});

test("virtual tool handler canonicalizes dotted federation tool names before daemon calls", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const mcpCall = mock<McpCall>((req) => {
    expect(req).toEqual({
      agent_id: "agent-1",
      tick_id: "tick-1",
      tool: "ha:ha_get_state",
      args: { entity_id: "light.kitchen" },
    });
    return Promise.resolve({ action_status: "executed", result: { ok: true } });
  });
  const daemon: FederationDaemon = {
    getFederationTools: mock<GetFederationTools>(() =>
      Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
    ),
    mcpCall,
  };
  await registerFederatedTools({ server, daemon });
  const entry = getRegisteredTool(server, "ha.ha_get_state");
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });
  expect(await entry.handler(validated, {})).toEqual({ ok: true });
  expect(mcpCall).toHaveBeenCalledTimes(1);
});

test("queued results are normalized into text envelopes", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.state_get" }] }),
    mcpCall: () => Promise.resolve({ action_status: "queued", pending_action_id: "pa-1" }),
  });
  await registerFederatedTools({ server, daemon });
  const entry = getRegisteredTool(server, "ha.state_get");
  const validated = entry.inputSchema.parse({});
  expect(await entry.handler(validated, {})).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          action_status: "queued",
          pending_action_id: "pa-1",
        }),
      },
    ],
  });
});

test("rejected and unavailable results are wrapped with isError", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.state_get" }] }),
    mcpCall: () =>
      Promise.resolve({
        action_status: "rejected",
        error: "not_allowed",
        details: { reason: "x" },
      }),
  });
  await registerFederatedTools({ server, daemon });
  const entry = getRegisteredTool(server, "ha.state_get");
  const validated = entry.inputSchema.parse({});
  expect(await entry.handler(validated, {})).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          action_status: "rejected",
          error: "not_allowed",
          details: { reason: "x" },
        }),
      },
    ],
    isError: true,
  });

  const unavailableServer = makeMcpServer();
  const unavailableDaemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.state_get" }] }),
    mcpCall: () => Promise.reject(new Error("offline")),
  });
  await registerFederatedTools({ server: unavailableServer, daemon: unavailableDaemon });
  const unavailableEntry = getRegisteredTool(unavailableServer, "ha.state_get");
  const unavailableValidated = unavailableEntry.inputSchema.parse({});
  expect(await unavailableEntry.handler(unavailableValidated, {})).toEqual({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          action_status: "rejected",
          error: "mcp_unavailable",
          details: "offline",
        }),
      },
    ],
    isError: true,
  });
});

test("registers tools on a real McpServer when inputSchema is JSON Schema (regression for buildServer crash)", async () => {
  // Regression: federation/client.ts used to pass `tool.inputSchema` (JSON
  // Schema from upstream hosted MCP servers) straight into `server.registerTool`,
  // which the SDK rejects with "inputSchema must be a Zod schema or raw shape".
  // That throw bubbled out of buildServer (top-level await in bin/penumbra-mcp.ts
  // has no try/catch) and killed the penumbra-mcp subprocess before transport.connect.
  // From the agent's POV the entire MCP server vanished. This test exercises
  // a real McpServer to make sure it doesn't reproduce.
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () =>
      Promise.resolve({
        tools: [
          {
            name: "ha.ha_get_state",
            description: "get state",
            inputSchema: {
              type: "object",
              properties: { entity_id: { type: "string" } },
              required: ["entity_id"],
            },
          },
          { name: "ha.ha_call_service" },
        ],
      }),
  });
  const result = await registerFederatedTools({ server, daemon });
  expect(result.registered.map((t) => t.name)).toEqual(["ha.ha_get_state", "ha.ha_call_service"]);
  expect(result.skipped).toEqual([]);
});

test("preserves tool-call arguments end-to-end on a real McpServer (regression for inputSchema:{} stripping args)", async () => {
  // Regression: registering with `inputSchema: {}` (an empty Zod raw shape)
  // built a STRICT empty object schema, so the SDK silently dropped every
  // unknown key during input validation — including required tool arguments
  // like `entity_id`. Federated tool calls forwarded `{}` to the upstream
  // hosted MCP server regardless of what the agent sent. This test drives
  // the registered tool's stored callback with non-empty args through a
  // real McpServer and asserts the daemon receives them verbatim.
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const seen: unknown[] = [];
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
    mcpCall: (req) => {
      seen.push(req.args);
      return Promise.resolve({ action_status: "executed", result: { ok: true } });
    },
  });
  await registerFederatedTools({ server, daemon });
  const entry = getRegisteredTool(server, "ha.ha_get_state");
  // The SDK runs the registered Zod schema over incoming args before invoking
  // the handler. Replicate that path to assert keys survive validation.
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen", brightness: 50 });
  expect(validated).toEqual({ entity_id: "light.kitchen", brightness: 50 });
  await entry.handler(validated, {});
  expect(seen).toEqual([{ entity_id: "light.kitchen", brightness: 50 }]);
});

test("forwards extra._meta to daemon.mcpCall", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
  });
  await registerFederatedTools({ server, daemon });
  const entry = getRegisteredTool(server, "ha.ha_get_state");
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });
  await entry.handler(validated, { _meta: { origin: "claude-code", trace: "abc" } });

  expect(daemon.mcpCall).toHaveBeenCalledTimes(1);
  expect(daemon.mcpCall).toHaveBeenCalledWith({
    agent_id: "agent-1",
    tick_id: "tick-1",
    tool: "ha:ha_get_state",
    args: { entity_id: "light.kitchen" },
    _meta: { origin: "claude-code", trace: "abc" },
  });
});

test("client drops _meta when UTF-8 byte count > 2048 even if .length stays within budget", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
  });
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  await registerFederatedTools({ server, daemon });

  const entry = getRegisteredTool(server, "ha.ha_get_state");
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });
  await entry.handler(validated, { _meta: { origin: "claude-code", blob: "😀".repeat(600) } });

  expect(daemon.mcpCall).toHaveBeenCalledTimes(1);
  expect(daemon.mcpCall).toHaveBeenNthCalledWith(1, {
    agent_id: "agent-1",
    tick_id: "tick-1",
    tool: "ha:ha_get_state",
    args: { entity_id: "light.kitchen" },
  });
  expect(errorSpy).toHaveBeenCalledTimes(1);
});

test("oversized _meta drops are logged on every occurrence with running total", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
  });
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  await registerFederatedTools({ server, daemon });

  const entry = getRegisteredTool(server, "ha.ha_get_state");
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });
  await entry.handler(validated, { _meta: { origin: "claude-code", blob: "x".repeat(3000) } });
  await entry.handler(validated, { _meta: { origin: "claude-code", blob: "x".repeat(3000) } });

  expect(daemon.mcpCall).toHaveBeenNthCalledWith(1, {
    agent_id: "agent-1",
    tick_id: "tick-1",
    tool: "ha:ha_get_state",
    args: { entity_id: "light.kitchen" },
  });
  expect(daemon.mcpCall).toHaveBeenNthCalledWith(2, {
    agent_id: "agent-1",
    tick_id: "tick-1",
    tool: "ha:ha_get_state",
    args: { entity_id: "light.kitchen" },
  });
  // console.error is typed `(...args: any[]) => void` in Node's lib.dom — a
  // genuine library type gap. Narrow the spy's recorded calls once through
  // `unknown` to a typed shape so the per-call asserts below are typed-safe.
  const errorCalls = errorSpy.mock.calls as unknown as [
    string,
    { total_drops?: number } | undefined,
  ][];
  expect(errorSpy).toHaveBeenCalledTimes(2);
  expect(errorCalls[0]?.[0]).toBe("[federation] dropped oversized _meta");
  expect(errorCalls[0]?.[1]?.total_drops).toEqual(expect.any(Number) as unknown as number);
  expect(errorCalls[1]?.[0]).toBe("[federation] dropped oversized _meta");
  expect(errorCalls[1]?.[1]?.total_drops).toEqual(expect.any(Number) as unknown as number);
  const firstDropCount = errorCalls[0]?.[1]?.total_drops;
  const secondDropCount = errorCalls[1]?.[1]?.total_drops;
  expect(typeof firstDropCount).toBe("number");
  expect(typeof secondDropCount).toBe("number");
  expect(secondDropCount).toBe(firstDropCount! + 1);
});

test("omits _meta when extra is missing, _meta is missing, or _meta is not an object", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
  });
  await registerFederatedTools({ server, daemon });

  const entry = getRegisteredTool(server, "ha.ha_get_state");
  const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });

  await entry.handler(validated, undefined);
  await entry.handler(validated, {});
  await entry.handler(validated, { _meta: "x" });
  await entry.handler(validated, { _meta: ["x"] });
  await entry.handler(validated, { _meta: null });

  expect(daemon.mcpCall).toHaveBeenCalledTimes(5);
  const callList = (daemon.mcpCall as unknown as { mock: { calls: Parameters<McpCall>[] } }).mock
    .calls;
  for (const call of callList) {
    expect(call[0]).toEqual({
      agent_id: "agent-1",
      tick_id: "tick-1",
      tool: "ha:ha_get_state",
      args: { entity_id: "light.kitchen" },
    });
  }
});

test("skips a federated tool whose registration throws without killing the rest", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  let calls = 0;
  const registerSpy = spyOn(server, "registerTool").mockImplementation(((name: string) => {
    calls += 1;
    if (name === "ha.bad") throw new Error("boom");
    // Return value is unused by registerFederatedTools.
    return undefined;
  }) as unknown as McpServer["registerTool"]);
  const daemon = makeDaemon({
    getFederationTools: () =>
      Promise.resolve({
        tools: [{ name: "ha.ok_one" }, { name: "ha.bad" }, { name: "ha.ok_two" }],
      }),
  });
  const result = await registerFederatedTools({ server, daemon });
  expect(calls).toBe(3);
  expect(registerSpy).toHaveBeenCalledTimes(3);
  expect(result.registered.map((t) => t.name)).toEqual(["ha.ok_one", "ha.ok_two"]);
  expect(result.skipped).toEqual([{ name: "ha.bad", reason: "boom" }]);
});

test("bootstrap failure returns no federated tools and flags fetch_failed", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const registerSpy = spyOn(server, "registerTool");
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  const daemon = makeDaemon({
    getFederationTools: () => Promise.reject(new Error("boom")),
  });
  const result = await registerFederatedTools({ server, daemon });
  // fetch_failed must be truthy so assembleServer can log a distinct event.
  // A byte-identical `{ registered:[], skipped:[] }` collides with a genuinely
  // empty federation set and silently masks daemon-unreachable at MCP boot.
  expect(result.registered).toEqual([]);
  expect(result.skipped).toEqual([]);
  expect(result.fetch_failed).toBe(true);
  expect(registerSpy).not.toHaveBeenCalled();
  expect(warnSpy).toHaveBeenCalled();
});

test("legitimately-empty federation set does NOT flag fetch_failed", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);
  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [] }),
  });
  const result = await registerFederatedTools({ server, daemon });
  expect(result.registered).toEqual([]);
  expect(result.skipped).toEqual([]);
  expect(result.fetch_failed).toBeUndefined();
});

test("federated tool invocation writes exactly one log row (single wrap)", async () => {
  process.env.PENUMBRA_MCP_INVOCATION_LOG_ENABLED = "1";
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);

  const stateRoot = mkdtempSync(join(tmpdir(), "penumbra-mcp-fed-log-state-"));
  const logPath = join(stateRoot, "penumbra", "mcp-invocations.jsonl");
  const sink = openInvocationSink(logPath);
  spyOn(registry, "getSink").mockReturnValue(sink);

  const server = makeMcpServer();
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
  });

  try {
    await registerFederatedTools({ server, daemon });
    const entry = getRegisteredTool(server, "ha.ha_get_state");
    const validated = entry.inputSchema.parse({ entity_id: "light.kitchen" });
    await entry.handler(validated, { _meta: { origin: "federation-test" } });
    await sink.close();
    const text = readFileSync(logPath, "utf8").trim();
    const rows =
      text.length === 0 ? [] : text.split("\n").map((line) => JSON.parse(line) as { tool: string });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("ha.ha_get_state");
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("oversized federated result is truncated with a handle_id that read_handle resolves to the full payload", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);

  const server = makeMcpServer();
  const large = { blob: "x".repeat(256) };
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
    mcpCall: () => Promise.resolve({ action_status: "executed", result: large }),
  });
  const handleStore = new HandleStore();
  try {
    await registerFederatedTools({
      server,
      daemon,
      invocationLogEnabled: false,
      responseBudgetTokens: 1,
      handleStore,
    });
    const entry = getRegisteredTool(server, "ha.ha_get_state");
    const validated = entry.inputSchema.parse({});
    const out = await entry.handler(validated, {});
    expect(isEnvelopeResult(out)).toBe(true);
    const envelopeOut = out as {
      _meta: { token_budget: { truncated: boolean }; handle_id: string };
    };
    expect(envelopeOut._meta.token_budget.truncated).toBe(true);
    expect(envelopeOut._meta.handle_id).toBeTruthy();
    const readOut = (await readHandleHandler(handleStore)({
      handle_id: envelopeOut._meta.handle_id,
    })) as { isError?: unknown; content: { text: string }[] };
    expect(readOut.isError).toBeUndefined();
    expect(readOut.content[0]?.text).toBe(JSON.stringify(large));
  } finally {
    handleStore.close();
  }
});

test("budget set but no handle store: federated result passes through unbudgeted", async () => {
  process.env.PENUMBRA_LONG_LIVED_AGENT_ID = "agent-1";
  process.env.PENUMBRA_LONG_LIVED_TICK_ID = "tick-1";
  setLongLivedRuntimeContextFromEnv(process.env);

  const server = makeMcpServer();
  const large = { blob: "x".repeat(256) };
  const daemon = makeDaemon({
    getFederationTools: () => Promise.resolve({ tools: [{ name: "ha.ha_get_state" }] }),
    mcpCall: () => Promise.resolve({ action_status: "executed", result: large }),
  });
  await registerFederatedTools({
    server,
    daemon,
    invocationLogEnabled: false,
    responseBudgetTokens: 1,
  });
  const entry = getRegisteredTool(server, "ha.ha_get_state");
  const validated = entry.inputSchema.parse({});
  const out = await entry.handler(validated, {});
  expect(isEnvelopeResult(out)).toBe(false);
  expect(out).toEqual(large);
});
