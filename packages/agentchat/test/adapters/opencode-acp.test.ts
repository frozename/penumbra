import { expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AcpClient, AcpClientOptions } from "@src/adapters/acp-client.js";
import type { AcpServerHandle, StartAcpServerOptions } from "@src/adapters/acp-server.js";
import type {
  AcpCreateSessionRequest,
  AcpEvent,
  AcpTool,
  McpServer,
  McpServerStdio,
} from "@src/adapters/acp-types.js";
import { OpencodeAcpAdapter } from "@src/adapters/opencode-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

type AcpClientLike = Pick<AcpClient, "openSession" | "sendMessage">;
type ObservedDispatchEvent = Parameters<NonNullable<DispatchInput["onEvent"]>>[0];

interface SendMessageOpts {
  tools?: AcpTool[];
  model?: string;
  agent?: string;
  directory?: string;
  workspace?: string;
}

// SDK type gap: opencode's wire SSE events use a `{type, properties:{...}}`
// shape that does not match the strict AcpEvent union, but the adapter
// re-narrows internally with explicit guards. Cast at the mock boundary.
const asAcpEvent = (raw: unknown): AcpEvent => raw as AcpEvent;

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-home-"));
  const prevHome = process.env.HOME;
  const homedirSpy = spyOn(os, "homedir").mockReturnValue(dir);
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    homedirSpy.mockRestore();
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function createInput(prompt = "ping"): DispatchInput {
  return {
    prompt,
    conversation: { id: "conv-1", project_id: null },
    config: {},
    signal: new AbortController().signal,
  };
}

function createObservedInput(events: ObservedDispatchEvent[]): {
  input: DispatchInput;
  events: ObservedDispatchEvent[];
} {
  return {
    input: {
      ...createInput(),
      handoff_id: "handoff-1",
      eventContext: { handoffId: "handoff-1", workerId: "worker-1" },
      onEvent: (event): void => {
        events.push(event);
      },
    },
    events,
  };
}

type ServerHandleWithKill = AcpServerHandle & {
  kill: ReturnType<typeof mock<(timeoutMs?: number) => Promise<void>>>;
};

function createServerHandle(): ServerHandleWithKill {
  const kill = mock((_timeoutMs?: number) => Promise.resolve());
  return {
    port: 4312,
    baseUrl: "http://127.0.0.1:4312",
    pid: 999,
    kill,
    exited: Promise.resolve({ code: 0, signal: null }),
  };
}

async function* yieldEvents(events: readonly unknown[]): AsyncGenerator<AcpEvent, void, undefined> {
  // Satisfy @typescript-eslint/require-await on an async generator that has
  // no real awaited work — the events array is in-memory.
  await Promise.resolve();
  for (const event of events) {
    yield asAcpEvent(event);
  }
}

async function* neverYieldEvents(): AsyncGenerator<AcpEvent, void, undefined> {
  await new Promise<void>(() => {
    void 0;
  });
  yield* [] as AcpEvent[];
}

interface ClientMock extends AcpClientLike {
  openSession: ReturnType<
    typeof mock<
      (req?: AcpCreateSessionRequest) => Promise<{ sessionId: string; workspaceId?: string }>
    >
  >;
  sendMessage: ReturnType<
    typeof mock<
      (sessionId: string, content: string, opts?: SendMessageOpts) => AsyncIterable<AcpEvent>
    >
  >;
}

function createClient(events: readonly unknown[]): ClientMock {
  const openSession = mock(
    (_req?: AcpCreateSessionRequest): Promise<{ sessionId: string; workspaceId?: string }> =>
      Promise.resolve({ sessionId: "sess-123", workspaceId: "." }),
  );
  const sendMessage = mock(
    (_sessionId: string, _content: string, _opts?: SendMessageOpts): AsyncIterable<AcpEvent> =>
      yieldEvents(events),
  );
  return { openSession, sendMessage };
}

function createNeverStreamClient(): ClientMock {
  const client = createClient([]);
  client.sendMessage = mock(
    (_sessionId: string, _content: string, _opts?: SendMessageOpts): AsyncIterable<AcpEvent> =>
      neverYieldEvents(),
  );
  return client;
}

async function expectRejectionMatching(p: Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error)) {
    throw new Error("expected promise to reject with an Error");
  }
  expect(caught.message).toContain(expected);
}

const penumbraMcpServer: McpServerStdio = {
  name: "penumbra",
  command: "bun",
  args: ["/tmp/penumbra-mcp.ts"],
  env: [{ name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-live" }],
};

interface OpencodeMcpEnv {
  PENUMBRA_STORAGE_ROOT?: string;
  PENUMBRA_HANDOFF_ID?: string;
  PENUMBRA_MCP_ORIGIN?: string;
  PENUMBRA_LONG_LIVED_AGENT_ID?: string;
  PENUMBRA_LONG_LIVED_TICK_ID?: string;
  PENUMBRA_MCP_TOOL_ALLOWLIST?: string;
}

interface OpencodeMcpEntry {
  type: "local";
  command: string[];
  environment: OpencodeMcpEnv;
  enabled: boolean;
}

interface OpencodeConfigFile {
  $schema?: string;
  mcp: Record<string, OpencodeMcpEntry>;
}

test("opencode-acp concatenates SSE text deltas into a single response", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
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
  const createClientMock = mock((opts: AcpClientOptions): AcpClientLike => {
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
  const startOptions = startServer.mock.calls[0]?.[0];
  expect(startOptions).toEqual({
    cwd: "/tmp/opencode-acp",
    pure: true,
    signal: startOptions?.signal,
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

test("opencode-acp times out stalled session opens and emits lifecycle events", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([]);
  client.openSession = mock(
    (_req?: AcpCreateSessionRequest): Promise<{ sessionId: string; workspaceId?: string }> =>
      new Promise(() => {
        /* intentionally never resolves */
      }),
  );
  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      openSessionTimeoutMs: 20,
      requestTimeoutMs: 5_000,
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  await expectRejectionMatching(
    adapter.dispatch(input),
    "opencode-acp: session open timed out after 20ms",
  );

  expect(client.sendMessage).not.toHaveBeenCalled();
  expect(events.some((event) => event.kind === "http.session.open_timeout")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.kind === "http.dispatch.error" &&
        event.meta?.stage === "session_open" &&
        typeof event.meta.reason === "string" &&
        event.meta.reason.includes("session open timed out"),
    ),
  ).toBe(true);
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test("opencode-acp times out streams that emit no events", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createNeverStreamClient();
  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      firstEventTimeoutMs: 20,
      requestTimeoutMs: 5_000,
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  await expectRejectionMatching(
    adapter.dispatch(input),
    "opencode-acp: no stream events within 20ms",
  );

  expect(events.some((event) => event.kind === "http.stream.first_event_timeout")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.kind === "http.dispatch.error" &&
        event.meta?.stage === "stream" &&
        typeof event.meta.reason === "string" &&
        event.meta.reason.includes("no stream events within"),
    ),
  ).toBe(true);
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test("opencode-acp rejects empty streams that end without session idle", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "reasoning" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "hidden" },
    },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", firstEventTimeoutMs: 20 },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await expectRejectionMatching(
    adapter.dispatch(createInput()),
    "opencode-acp: stream ended without session.idle after message.part.delta",
  );
});

test("opencode-acp preserves accumulated text when a non-idle stream ends", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "partial" },
    },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", firstEventTimeoutMs: 20 },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  const out = await adapter.dispatch(createInput());

  expect(out).toEqual({ text: "partial" });
});

test("opencode-acp still surfaces session.error events", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    {
      type: "session.error",
      properties: { error: { data: { message: "provider policy denied" } } },
    },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", firstEventTimeoutMs: 20 },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await expectRejectionMatching(
    adapter.dispatch(createInput()),
    "opencode-acp: session.error — provider policy denied",
  );
});

test("opencode-acp rejects when ACP requests a tool call", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const rejectionMessage = "opencode-acp: tool calls not supported in Commit 3 (requested grep)";
  const client = createClient([
    {
      type: "message.part.updated",
      properties: {
        part: {
          get id(): string {
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
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await expectRejectionMatching(adapter.dispatch(createInput()), rejectionMessage);
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test("opencode-acp surfaces ACP server boot failures cleanly", async () => {
  const startServer = mock((_opts: StartAcpServerOptions): Promise<AcpServerHandle> => {
    throw new Error("ACP server did not report a port within 10ms");
  });
  const createClientMock = mock((_opts: AcpClientOptions): AcpClientLike => {
    throw new Error("client should not be created when boot fails");
  });

  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", bootTimeoutMs: 10 },
    { startServer, createClient: createClientMock },
  );

  await expectRejectionMatching(
    adapter.dispatch(createInput()),
    "ACP server did not report a port within 10ms",
  );
  expect(createClientMock).not.toHaveBeenCalled();
});

test("opencode-acp sets a per-dispatch XDG_CONFIG_HOME when mcpServers are provided", async () => {
  const captured: { config: OpencodeConfigFile | null; path: string | null } = {
    config: null,
    path: null,
  };
  const handle = createServerHandle();
  const startServer = mock(async (opts: StartAcpServerOptions) => {
    const xdgConfigHome = opts.env?.XDG_CONFIG_HOME;
    if (!xdgConfigHome) {
      throw new Error("missing XDG_CONFIG_HOME");
    }
    captured.path = `${xdgConfigHome}/opencode/config.json`;
    expect(await Bun.file(captured.path).exists()).toBe(true);
    captured.config = JSON.parse(await Bun.file(captured.path).text()) as OpencodeConfigFile;
    return handle;
  });
  const client = createClient([{ type: "session.idle" }]);

  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      mcpServers: [penumbraMcpServer],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await withTempHome(() => adapter.dispatch(createInput()));

  expect(captured.config).toEqual({
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
  const configPath = captured.path;
  if (configPath === null) {
    throw new Error("expected captured config path");
  }
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(startServer).toHaveBeenCalledTimes(1);
});

test("opencode-acp lets a user-supplied PENUMBRA_MCP_TOOL_ALLOWLIST pass through on non-long-lived dispatches", async () => {
  const captured: { config: OpencodeConfigFile | null } = { config: null };
  const handle = createServerHandle();
  const startServer = mock(async (opts: StartAcpServerOptions) => {
    const xdgConfigHome = opts.env?.XDG_CONFIG_HOME;
    if (!xdgConfigHome) {
      throw new Error("missing XDG_CONFIG_HOME");
    }
    const configPath = `${xdgConfigHome}/opencode/config.json`;
    captured.config = JSON.parse(await Bun.file(configPath).text()) as OpencodeConfigFile;
    return handle;
  });
  const client = createClient([{ type: "session.idle" }]);

  const penumbraWithAllowlist: McpServerStdio = {
    ...penumbraMcpServer,
    env: [
      ...penumbraMcpServer.env,
      { name: "PENUMBRA_MCP_TOOL_ALLOWLIST", value: "cost_recent,fs_read" },
    ],
  };

  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      mcpServers: [penumbraWithAllowlist],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await withTempHome(() => adapter.dispatch({ ...createInput(), handoff_id: "handoff-1" }));

  const mcp = captured.config?.mcp.penumbra;
  expect(mcp?.environment.PENUMBRA_MCP_TOOL_ALLOWLIST).toBe("cost_recent,fs_read");
  expect(mcp?.environment.PENUMBRA_HANDOFF_ID).toBe("handoff-1");
});

test("opencode-acp forwards options.agent to sendMessage and omits it when unset", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const events = [{ type: "session.idle" }];

  const withAgent = createClient(events);
  const adapterWithAgent = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", agent: "local-exec" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => withAgent),
    },
  );
  await adapterWithAgent.dispatch(createInput());
  expect(withAgent.sendMessage).toHaveBeenCalledWith("sess-123", "ping", {
    model: "deepseek-v4",
    tools: [],
    directory: "/tmp/opencode-acp",
    workspace: ".",
    agent: "local-exec",
  });

  const noAgent = createClient(events);
  const adapterNoAgent = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => noAgent),
    },
  );
  await adapterNoAgent.dispatch(createInput());
  const sentOpts = noAgent.sendMessage.mock.calls[0]?.[2];
  expect(sentOpts).toBeDefined();
  expect(sentOpts !== undefined && Object.hasOwn(sentOpts, "agent")).toBe(false);
});

test("opencode-acp injects long-lived env into penumbra mcp config for long_lived_tick dispatches", async () => {
  const captured: { config: OpencodeConfigFile | null } = { config: null };
  const handle = createServerHandle();
  const startServer = mock(async (opts: StartAcpServerOptions) => {
    const xdgConfigHome = opts.env?.XDG_CONFIG_HOME;
    if (!xdgConfigHome) {
      throw new Error("missing XDG_CONFIG_HOME");
    }
    const configPath = `${xdgConfigHome}/opencode/config.json`;
    captured.config = JSON.parse(await Bun.file(configPath).text()) as OpencodeConfigFile;
    return handle;
  });
  const client = createClient([{ type: "session.idle" }]);

  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      mcpServers: [penumbraMcpServer],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
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

  const mcp = captured.config?.mcp.penumbra;
  expect(mcp?.environment.PENUMBRA_STORAGE_ROOT).toBe("/tmp/penumbra-live");
  expect(mcp?.environment.PENUMBRA_HANDOFF_ID).toBe("HANDOFF_ABC");
  expect(mcp?.environment.PENUMBRA_MCP_ORIGIN).toBe("fleet-worker");
  expect(mcp?.environment.PENUMBRA_LONG_LIVED_AGENT_ID).toBe("agent-1");
  expect(mcp?.environment.PENUMBRA_LONG_LIVED_TICK_ID).toBe("tick-1");
  const allowlistRaw = mcp?.environment.PENUMBRA_MCP_TOOL_ALLOWLIST ?? "";
  const allowlist = new Set(allowlistRaw.split(","));
  expect(allowlist.has("cost_recent")).toBe(true);
  expect(allowlist.has("long_lived_self_state_get")).toBe(true);
  expect(allowlist.has("long_lived_self_state_set")).toBe(true);
  expect(allowlist.has("long_lived_self_pending_actions")).toBe(true);
});

test("opencode-acp preserves the original dispatch error when xdg cleanup also throws", async () => {
  const warns: string[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  try {
    const dispatchErrorMessage = "opencode-acp: primary-dispatch-error under test";
    const cleanupErrorMessage = "opencode-acp: cleanup-error under test";
    let cleanupCalled = 0;
    const prepareMcpConfig = mock(
      (_servers: McpServer[]): Promise<{ xdgConfigHome: string; cleanup: () => Promise<void> }> =>
        Promise.resolve({
          xdgConfigHome: "/tmp/opencode-acp-xdg-fixture",
          cleanup: (): Promise<void> => {
            cleanupCalled++;
            return Promise.reject(new Error(cleanupErrorMessage));
          },
        }),
    );
    const startServer = mock((_opts: StartAcpServerOptions): Promise<AcpServerHandle> => {
      throw new Error(dispatchErrorMessage);
    });
    const createClientMock = mock((_opts: AcpClientOptions): AcpClientLike => {
      throw new Error("client should not be created when boot fails");
    });

    const adapter = new OpencodeAcpAdapter(
      {
        model: "deepseek-v4",
        cwd: "/tmp/opencode-acp",
        mcpServers: [penumbraMcpServer],
      },
      { startServer, createClient: createClientMock, prepareMcpConfig },
    );

    await expectRejectionMatching(adapter.dispatch(createInput()), dispatchErrorMessage);
    expect(cleanupCalled).toBe(1);
    const joined = warns.join("\n");
    expect(joined).toContain(cleanupErrorMessage);
  } finally {
    warnSpy.mockRestore();
  }
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
