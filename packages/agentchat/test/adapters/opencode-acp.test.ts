import { expect, mock, test } from "bun:test";
import { OpencodeAcpAdapter } from "../../src/adapters/opencode-acp.js";
import type { AcpServerHandle } from "../../src/adapters/acp-server.js";
import type { AcpClientOptions } from "../../src/adapters/acp-client.js";
import type { DispatchInput } from "../../src/sdk/adapter.js";

function createInput(prompt = "ping"): DispatchInput {
  return {
    prompt,
    conversation: { id: "conv-1", project_id: null },
    config: {},
    signal: new AbortController().signal,
  };
}

function createServerHandle(): AcpServerHandle & { kill: ReturnType<typeof mock> } {
  const kill = mock(async () => {});
  return {
    port: 4312,
    baseUrl: "http://127.0.0.1:4312",
    pid: 999,
    kill,
    exited: Promise.resolve({ code: 0, signal: null }),
  };
}

function createClient(events: readonly unknown[]) {
  return {
    openSession: mock(async (_req?: { cwd?: string }) => ({
      sessionId: "sess-123",
      workspaceId: ".",
    })),
    sendMessage: mock(async function* (
      _sessionId: string,
      _content: string,
      _opts?: {
        tools?: unknown[];
        model?: string;
        agent?: string;
        directory?: string;
        workspace?: string;
      },
    ) {
      for (const event of events) {
        yield event as never;
      }
    }),
  };
}

test("opencode-acp concatenates SSE text deltas into a single response", async () => {
  const handle = createServerHandle();
  const startServer = mock(async () => handle);
  const client = createClient([
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "po" },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "ng" },
    },
    { type: "session.idle" },
  ]);
  const createClientMock = mock((opts: AcpClientOptions) => {
    expect(opts.baseUrl).toBe(handle.baseUrl);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    return client;
  });

  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      opencodeBinary: "custom-opencode",
      bootTimeoutMs: 1_234,
      requestTimeoutMs: 5_000,
    },
    { startServer, createClient: createClientMock },
  );

  const out = await adapter.dispatch(createInput());

  expect(out).toEqual({ text: "pong" });
  expect(startServer).toHaveBeenCalledTimes(1);
  expect(startServer.mock.calls[0]?.[0]).toEqual({
    cwd: "/tmp/opencode-acp",
    pure: true,
    signal: startServer.mock.calls[0]?.[0].signal,
    opencodeBinary: "custom-opencode",
    bootTimeoutMs: 1_234,
  });
  expect(client.openSession).toHaveBeenCalledWith({ cwd: "/tmp/opencode-acp" });
  expect(client.sendMessage).toHaveBeenCalledWith("sess-123", "ping", {
    model: "deepseek-v4",
    tools: [],
    directory: "/tmp/opencode-acp",
    workspace: ".",
  });
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test("opencode-acp rejects when ACP requests a tool call", async () => {
  const handle = createServerHandle();
  const startServer = mock(async () => handle);
  const rejectionMessage = "opencode-acp: tool calls not supported in Commit 3 (requested grep)";
  const client = createClient([
    {
      type: "message.part.updated",
      properties: {
        part: {
          get id() {
            throw new Error(rejectionMessage);
          },
          type: "tool_call",
        },
      },
    },
  ]);

  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions) => client),
    },
  );

  await expect(adapter.dispatch(createInput())).rejects.toThrow(rejectionMessage);
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test("opencode-acp surfaces ACP server boot failures cleanly", async () => {
  const startServer = mock(async () => {
    throw new Error("ACP server did not report a port within 10ms");
  });
  const createClientMock = mock((_opts: AcpClientOptions) => {
    throw new Error("client should not be created when boot fails");
  });

  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", bootTimeoutMs: 10 },
    { startServer, createClient: createClientMock },
  );

  await expect(adapter.dispatch(createInput())).rejects.toThrow(
    "ACP server did not report a port within 10ms",
  );
  expect(createClientMock).not.toHaveBeenCalled();
});

test("opencode-acp sets a per-dispatch XDG_CONFIG_HOME when mcpServers are provided", async () => {
  let capturedConfig: Record<string, unknown> | null = null;
  let capturedConfigPath: string | null = null;
  const handle = createServerHandle();
  const startServer = mock(async (opts: { env?: Record<string, string> }) => {
    const xdgConfigHome = opts.env?.XDG_CONFIG_HOME;
    if (!xdgConfigHome) {
      throw new Error("missing XDG_CONFIG_HOME");
    }
    capturedConfigPath = `${xdgConfigHome}/opencode/config.json`;
    expect(await Bun.file(capturedConfigPath).exists()).toBe(true);
    capturedConfig = JSON.parse(await Bun.file(capturedConfigPath).text());
    return handle;
  });
  const client = createClient([{ type: "session.idle" }]);

  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      mcpServers: [
        {
          name: "penumbra",
          command: "bun",
          args: ["/tmp/penumbra-mcp.ts"],
          env: [{ name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-live" }],
        } as any,
      ],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions) => client),
    },
  );

  await adapter.dispatch(createInput());

  expect(capturedConfig).toEqual({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      penumbra: {
        type: "local",
        command: ["bun", "/tmp/penumbra-mcp.ts"],
        environment: { PENUMBRA_STORAGE_ROOT: "/tmp/penumbra-live" },
        enabled: true,
      },
    },
  });
  expect(capturedConfigPath).toBeDefined();
  expect(capturedConfigPath && (await Bun.file(capturedConfigPath).exists())).toBe(false);
  expect(startServer).toHaveBeenCalledTimes(1);
});

test("opencode-acp injects long-lived env into penumbra mcp config for long_lived_tick dispatches", async () => {
  let capturedConfig: Record<string, unknown> | null = null;
  const handle = createServerHandle();
  const startServer = mock(async (opts: { env?: Record<string, string> }) => {
    const xdgConfigHome = opts.env?.XDG_CONFIG_HOME;
    if (!xdgConfigHome) throw new Error("missing XDG_CONFIG_HOME");
    const configPath = `${xdgConfigHome}/opencode/config.json`;
    capturedConfig = JSON.parse(await Bun.file(configPath).text());
    return handle;
  });
  const client = createClient([{ type: "session.idle" }]);

  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      mcpServers: [
        {
          name: "penumbra",
          command: "bun",
          args: ["/tmp/penumbra-mcp.ts"],
          env: [{ name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-live" }],
        } as any,
      ],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions) => client),
    },
  );

  await adapter.dispatch({
    ...createInput(),
    handoff_id: "HANDOFF_ABC",
    long_lived_session: {
      dispatch_kind: "long_lived_tick",
      agent_id: "agent-1",
      tick_id: "tick-1",
      mcp_tool_allowlist: ["cost_recent"],
    },
  });

  const mcp = (capturedConfig as any).mcp.penumbra;
  expect(mcp.environment.PENUMBRA_STORAGE_ROOT).toBe("/tmp/penumbra-live");
  expect(mcp.environment.PENUMBRA_HANDOFF_ID).toBe("HANDOFF_ABC");
  expect(mcp.environment.PENUMBRA_LONG_LIVED_AGENT_ID).toBe("agent-1");
  expect(mcp.environment.PENUMBRA_LONG_LIVED_TICK_ID).toBe("tick-1");
  const allowlist = new Set(String(mcp.environment.PENUMBRA_MCP_TOOL_ALLOWLIST).split(","));
  expect(allowlist.has("cost_recent")).toBe(true);
  expect(allowlist.has("long_lived_self_state_get")).toBe(true);
  expect(allowlist.has("long_lived_self_state_set")).toBe(true);
  expect(allowlist.has("long_lived_self_pending_actions")).toBe(true);
});

const integrationEnabled =
  process.env.PENUMBRA_RUN_OPENCODE_INTEGRATION === "1" && Boolean(Bun.which("opencode"));

test.if(integrationEnabled)(
  "opencode-acp can dispatch a real ping against opencode ACP",
  async () => {
    const adapter = new OpencodeAcpAdapter({
      model: process.env.PENUMBRA_OPENCODE_MODEL ?? "gpt-5",
      cwd: process.cwd(),
      bootTimeoutMs: 10_000,
      requestTimeoutMs: 45_000,
    });

    const out = await adapter.dispatch(
      createInput("Reply with the single word pong. Do not use tools."),
    );

    expect(out.text.trim().length).toBeGreaterThan(0);
  },
);
