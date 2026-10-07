import { expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AcpClient, type AcpClientOptions } from "@src/adapters/acp-client.js";
import type { AcpServerHandle, StartAcpServerOptions } from "@src/adapters/acp-server.js";
import type {
  AcpCreateSessionRequest,
  AcpEvent,
  AcpPermissionReply,
  AcpPermissionResponse,
  AcpTool,
  McpServer,
  McpServerStdio,
} from "@src/adapters/acp-types.js";
import { OpencodeAcpAdapter } from "@src/adapters/opencode-acp.js";
import { dispatchHandoff } from "@src/cli/dispatch-handoff.js";
import { runChatTurn as realRunChatTurn } from "@src/cli/loop.js";
import type { DispatchInput } from "@src/sdk/adapter.js";

type AcpClientLike = Pick<
  AcpClient,
  "openSession" | "sendMessage" | "replyPermission" | "respondPermission" | "replySessionPermission"
>;
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
  replyPermission: ReturnType<
    typeof mock<(requestID: string, reply: AcpPermissionReply) => Promise<void>>
  >;
  respondPermission: ReturnType<
    typeof mock<
      (sessionId: string, permissionID: string, response: AcpPermissionResponse) => Promise<void>
    >
  >;
  replySessionPermission: ReturnType<
    typeof mock<(sessionId: string, requestID: string, reply: AcpPermissionReply) => Promise<void>>
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
  const replyPermission = mock(
    (_requestID: string, _reply: AcpPermissionReply): Promise<void> => Promise.resolve(),
  );
  const respondPermission = mock(
    (_sessionId: string, _permissionID: string, _response: AcpPermissionResponse): Promise<void> =>
      Promise.resolve(),
  );
  const replySessionPermission = mock(
    (_sessionId: string, _requestID: string, _reply: AcpPermissionReply): Promise<void> =>
      Promise.resolve(),
  );
  return { openSession, sendMessage, replyPermission, respondPermission, replySessionPermission };
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

test("opencode-acp forwards unsetEnv to startServer and omits it when unset", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([{ type: "session.idle" }]);

  const withUnset = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      unsetEnv: ["PENUMBRA_SIRIUS_TOKEN"],
    },
    { startServer, createClient: mock((_opts: AcpClientOptions): AcpClientLike => client) },
  );
  await withUnset.dispatch(createInput());
  const withOpts = startServer.mock.calls[0]?.[0];
  expect(withOpts).toBeDefined();
  expect(withOpts?.unsetEnv).toEqual(["PENUMBRA_SIRIUS_TOKEN"]);

  startServer.mockClear();
  const noUnset = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    { startServer, createClient: mock((_opts: AcpClientOptions): AcpClientLike => client) },
  );
  await noUnset.dispatch(createInput());
  const noOpts = startServer.mock.calls[0]?.[0];
  expect(noOpts).toBeDefined();
  expect(noOpts !== undefined && Object.hasOwn(noOpts, "unsetEnv")).toBe(false);
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

function permissionAskedEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "permission.asked",
    properties: {
      id: "per_abc123",
      sessionID: "sess-123",
      permission: "doom_loop",
      patterns: ["read"],
      metadata: {},
      always: ["read"],
      tool: { messageID: "msg_1", callID: "call_1" },
      ...overrides,
    },
  };
}

test("opencode-acp rejects a permission ask by default and answers exactly once", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    permissionAskedEvent(),
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "answered-once" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  const out = await adapter.dispatch(input);

  expect(out).toEqual({ text: "answered-once" });
  expect(client.replyPermission).toHaveBeenCalledTimes(1);
  expect(client.replyPermission).toHaveBeenCalledWith(
    "per_abc123",
    expect.objectContaining({ reply: "reject", message: expect.any(String) as string }),
  );
  expect(client.respondPermission).not.toHaveBeenCalled();
  expect(client.replySessionPermission).not.toHaveBeenCalled();
  const permissionEvents = events.filter((event) => event.kind === "http.session.permission");
  expect(permissionEvents).toHaveLength(1);
  expect(permissionEvents[0]?.meta).toMatchObject({
    outcome: "answered",
    reply: "reject",
    permission: "doom_loop",
    permission_id: "per_abc123",
    session_id: "sess-123",
  });
});

test("opencode-acp falls back to the session-scoped respond route when the request reply route fails", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    permissionAskedEvent(),
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "fallback-ok" },
    },
    { type: "session.idle" },
  ]);
  client.replyPermission = mock(
    (_requestID: string, _reply: AcpPermissionReply): Promise<void> =>
      Promise.reject(new Error("HTTP 404")),
  );
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  await adapter.dispatch(input);

  expect(client.replyPermission).toHaveBeenCalledTimes(1);
  expect(client.respondPermission).toHaveBeenCalledTimes(1);
  expect(client.respondPermission).toHaveBeenCalledWith("sess-123", "per_abc123", {
    response: "reject",
  });
  expect(
    events.some(
      (event) => event.kind === "http.session.permission" && event.meta?.outcome === "answered",
    ),
  ).toBe(true);
});

test("opencode-acp auto-approves permission kinds in autoApprovePermissions", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    permissionAskedEvent(),
    permissionAskedEvent({ id: "per_def456", permission: "bash" }),
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "mixed" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      autoApprovePermissions: ["doom_loop"],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await adapter.dispatch(createInput());

  expect(client.replyPermission).toHaveBeenCalledTimes(2);
  expect(client.replyPermission).toHaveBeenNthCalledWith(
    1,
    "per_abc123",
    expect.objectContaining({ reply: "always" }),
  );
  expect(client.replyPermission).toHaveBeenNthCalledWith(
    2,
    "per_def456",
    expect.objectContaining({ reply: "reject" }),
  );
});

test("opencode-acp rejects a permission kind that is not in autoApprovePermissions", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    permissionAskedEvent({ id: "per_bash001", permission: "bash" }),
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "bash-rejected" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      autoApprovePermissions: ["doom_loop"],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  const out = await adapter.dispatch(input);

  expect(out).toEqual({ text: "bash-rejected" });
  expect(client.replyPermission).toHaveBeenCalledTimes(1);
  expect(client.replyPermission).toHaveBeenCalledWith(
    "per_bash001",
    expect.objectContaining({
      reply: "reject",
      message: "penumbra: permission 'bash' auto-rejected",
    }),
  );
  expect(client.respondPermission).not.toHaveBeenCalled();
  expect(client.replySessionPermission).not.toHaveBeenCalled();
  const permissionEvents = events.filter((event) => event.kind === "http.session.permission");
  expect(permissionEvents).toHaveLength(1);
  expect(permissionEvents[0]?.meta).toMatchObject({
    outcome: "answered",
    reply: "reject",
    permission: "bash",
    permission_id: "per_bash001",
    session_id: "sess-123",
    wire_event: "permission.asked",
    adapter: "opencode-acp",
  });
});

test("opencode-acp continues the stream after answering a permission and terminates on session.idle", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    permissionAskedEvent(),
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "recovered" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  const out = await adapter.dispatch(createInput());

  expect(out).toEqual({ text: "recovered" });
  expect(client.replyPermission).toHaveBeenCalledTimes(1);
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test("opencode-acp answers permission.v2.asked via the session permission reply route", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    {
      type: "permission.v2.asked",
      properties: {
        id: "per_v2x",
        sessionID: "sess-123",
        action: "edit",
        resources: ["src/**"],
        save: [],
        metadata: {},
      },
    },
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "v2-answered" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );

  await adapter.dispatch(createInput());

  expect(client.replySessionPermission).toHaveBeenCalledTimes(1);
  expect(client.replySessionPermission).toHaveBeenCalledWith(
    "sess-123",
    "per_v2x",
    expect.objectContaining({ reply: "reject" }),
  );
  expect(client.replyPermission).not.toHaveBeenCalled();
  expect(client.respondPermission).not.toHaveBeenCalled();
});

test("opencode-acp rejects a v2 permission kind that is not in autoApprovePermissions", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    {
      type: "permission.v2.asked",
      properties: {
        id: "per_v2_bash001",
        sessionID: "sess-123",
        action: "bash",
        resources: ["src/**"],
        save: [],
        metadata: {},
      },
    },
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "v2-rejected" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      autoApprovePermissions: ["doom_loop"],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  const out = await adapter.dispatch(input);

  expect(out).toEqual({ text: "v2-rejected" });
  expect(client.replySessionPermission).toHaveBeenCalledTimes(1);
  expect(client.replySessionPermission).toHaveBeenCalledWith(
    "sess-123",
    "per_v2_bash001",
    expect.objectContaining({
      reply: "reject",
      message: "penumbra: permission 'bash' auto-rejected",
    }),
  );
  expect(client.replyPermission).not.toHaveBeenCalled();
  expect(client.respondPermission).not.toHaveBeenCalled();
  const permissionEvents = events.filter((event) => event.kind === "http.session.permission");
  expect(permissionEvents).toHaveLength(1);
  expect(permissionEvents[0]?.meta).toMatchObject({
    outcome: "answered",
    reply: "reject",
    permission: "bash",
    permission_id: "per_v2_bash001",
    session_id: "sess-123",
    wire_event: "permission.v2.asked",
    adapter: "opencode-acp",
  });
});

test("opencode-acp auto-approves a v2 permission kind that is in autoApprovePermissions", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    {
      type: "permission.v2.asked",
      properties: {
        id: "per_v2_doom",
        sessionID: "sess-123",
        action: "doom_loop",
        resources: ["src/**"],
        save: [],
        metadata: {},
      },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    {
      model: "deepseek-v4",
      cwd: "/tmp/opencode-acp",
      autoApprovePermissions: ["doom_loop"],
    },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  const out = await adapter.dispatch(input);

  expect(out).toEqual({ text: "" });
  expect(client.replySessionPermission).toHaveBeenCalledTimes(1);
  expect(client.replySessionPermission).toHaveBeenCalledWith(
    "sess-123",
    "per_v2_doom",
    expect.objectContaining({ reply: "always" }),
  );
  expect(client.replyPermission).not.toHaveBeenCalled();
  expect(client.respondPermission).not.toHaveBeenCalled();
  const permissionEvents = events.filter((event) => event.kind === "http.session.permission");
  expect(permissionEvents).toHaveLength(1);
  expect(permissionEvents[0]?.meta).toMatchObject({
    outcome: "answered",
    reply: "always",
    permission: "doom_loop",
    permission_id: "per_v2_doom",
    session_id: "sess-123",
    wire_event: "permission.v2.asked",
    adapter: "opencode-acp",
  });
});

test("opencode-acp does not throw or wedge on a malformed permission event", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([
    { type: "permission.asked" },
    { type: "permission.asked", properties: { sessionID: "sess-123", permission: "bash" } },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  const out = await adapter.dispatch(input);

  expect(out).toEqual({ text: "" });
  expect(client.replyPermission).not.toHaveBeenCalled();
  expect(client.respondPermission).not.toHaveBeenCalled();
  expect(client.replySessionPermission).not.toHaveBeenCalled();
  expect(
    events.filter(
      (event) => event.kind === "http.session.permission" && event.meta?.outcome === "unanswerable",
    ),
  ).toHaveLength(2);
});

test("opencode-acp emits reply_failed telemetry when every reply route fails and the empty idle turn fails", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const client = createClient([permissionAskedEvent(), { type: "session.idle" }]);
  client.replyPermission = mock(
    (_requestID: string, _reply: AcpPermissionReply): Promise<void> =>
      Promise.reject(new Error("HTTP 404")),
  );
  client.respondPermission = mock(
    (_sessionId: string, _permissionID: string, _response: AcpPermissionResponse): Promise<void> =>
      Promise.reject(new Error("HTTP 404")),
  );
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  await expectRejectionMatching(
    adapter.dispatch(input),
    "opencode-acp: turn ended idle with empty text after 1 rejected permission ask(s) [doom_loop] (1 reply_failed); opencode halts the turn on a plain permission reject",
  );

  expect(client.replyPermission).toHaveBeenCalledTimes(1);
  expect(client.respondPermission).toHaveBeenCalledTimes(1);
  expect(
    events.some(
      (event) => event.kind === "http.session.permission" && event.meta?.outcome === "reply_failed",
    ),
  ).toBe(true);
});

test("opencode-acp permission events carry the reply route and the asked patterns", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const textThenIdle = [
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "done" },
    },
    { type: "session.idle" },
  ];

  const replyClient = createClient([permissionAskedEvent(), ...textThenIdle]);
  const replyAdapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => replyClient),
    },
  );
  const replyObserved = createObservedInput([]);
  await replyAdapter.dispatch(replyObserved.input);
  const replyEvent = replyObserved.events.find((e) => e.kind === "http.session.permission");
  expect(replyEvent?.meta).toMatchObject({
    outcome: "answered",
    route: "reply",
    patterns: ["read"],
  });

  const respondClient = createClient([permissionAskedEvent(), ...textThenIdle]);
  respondClient.replyPermission = mock(
    (_requestID: string, _reply: AcpPermissionReply): Promise<void> =>
      Promise.reject(new Error("HTTP 404")),
  );
  const respondAdapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => respondClient),
    },
  );
  const respondObserved = createObservedInput([]);
  await respondAdapter.dispatch(respondObserved.input);
  const respondEvent = respondObserved.events.find((e) => e.kind === "http.session.permission");
  expect(respondEvent?.meta).toMatchObject({
    outcome: "answered",
    route: "respond",
    patterns: ["read"],
  });

  const v2Client = createClient([
    {
      type: "permission.v2.asked",
      properties: {
        id: "per_v2_meta",
        sessionID: "sess-123",
        action: "edit",
        resources: ["src/**", "docs/*.md"],
        save: [],
        metadata: {},
      },
    },
    ...textThenIdle,
  ]);
  const v2Adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => v2Client),
    },
  );
  const v2Observed = createObservedInput([]);
  await v2Adapter.dispatch(v2Observed.input);
  const v2Event = v2Observed.events.find((e) => e.kind === "http.session.permission");
  expect(v2Event?.meta).toMatchObject({
    outcome: "answered",
    route: "v2",
    patterns: ["src/**", "docs/*.md"],
  });
});

test("opencode-acp truncates oversized permission patterns inside the meta_json cap", async () => {
  const handle = createServerHandle();
  const startServer = mock((_opts: StartAcpServerOptions) => Promise.resolve(handle));
  const hugePatterns = [
    "g".repeat(10_000),
    ...Array.from({ length: 300 }, (_, i) => `src/${"x".repeat(80)}-${String(i)}`),
  ];
  const client = createClient([
    permissionAskedEvent({ patterns: hugePatterns }),
    {
      type: "message.part.updated",
      properties: { part: { id: "p-1", type: "text" } },
    },
    {
      type: "message.part.delta",
      properties: { partID: "p-1", field: "text", delta: "done" },
    },
    { type: "session.idle" },
  ]);
  const adapter = new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp" },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions): AcpClientLike => client),
    },
  );
  const { input, events } = createObservedInput([]);

  await adapter.dispatch(input);

  const permissionEvent = events.find((e) => e.kind === "http.session.permission");
  const meta = permissionEvent?.meta;
  expect(meta).toBeDefined();
  expect(JSON.stringify(meta).length).toBeLessThanOrEqual(4096);
  expect(meta?.patterns_truncated).toBe(true);
  const kept = meta?.patterns;
  expect(Array.isArray(kept)).toBe(true);
  expect((kept as string[]).length).toBeLessThan(hugePatterns.length);
  expect((kept as string[]).every((pattern) => pattern.length <= 513)).toBe(true);
  // An empty list would satisfy every() vacuously: pin that the oversized
  // first pattern is cut to the per-entry cap rather than dropped.
  const keptList = kept as string[];
  expect(keptList.length).toBeGreaterThan(0);
  expect(keptList[0]?.length).toBe(513);
  expect(keptList[0]?.endsWith("…")).toBe(true);
});

function sseBody(events: readonly unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function isRejectBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const parsed = JSON.parse(body) as { reply?: unknown; response?: unknown };
    return parsed.reply === "reject" || parsed.response === "reject";
  } catch {
    return false;
  }
}

// Emulates opencode 1.18.26's permission surface over the real AcpClient HTTP
// parsing path: pending asks are tracked per POST /message (each retry gets a
// fresh turn), and a plain "reject" reply cascades a RejectedError to every
// sibling pending ask, so their reply routes then 404.
function installOpencode11826FetchFake(script: { events: unknown[]; askIds: string[] }): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  let pending = new Set<string>();
  const originalFetch = globalThis.fetch;

  const answerAsk = (path: string, pattern: RegExp, body: unknown): Response | null => {
    const match = pattern.exec(path);
    if (!match) return null;
    const id = decodeURIComponent(match[1] ?? "");
    if (!pending.has(id)) return new Response("not found", { status: 404 });
    pending.delete(id);
    if (isRejectBody(body)) pending.clear();
    return jsonResponse({});
  };

  const route = (path: string, method: string, body: unknown): Response => {
    if (method === "POST" && path === "/session") {
      return jsonResponse({ sessionID: "sess_fake" });
    }
    if (method === "GET" && path === "/event") {
      return new Response(sseBody(script.events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (method === "POST" && path.endsWith("/message")) {
      pending = new Set(script.askIds);
      return jsonResponse({});
    }
    return (
      answerAsk(path, /^\/permission\/([^/]+)\/reply$/, body) ??
      answerAsk(path, /^\/session\/[^/]+\/permissions\/([^/]+)$/, body) ??
      new Response(`unhandled ${method} ${path}`, { status: 500 })
    );
  };

  globalThis.fetch = mock(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      return Promise.resolve(route(new URL(url).pathname, method, init?.body));
    },
  ) as unknown as typeof fetch;
  return {
    calls,
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

function createHttpBackedAdapter(): OpencodeAcpAdapter {
  const handle = createServerHandle();
  return new OpencodeAcpAdapter(
    { model: "deepseek-v4", cwd: "/tmp/opencode-acp", requestTimeoutMs: 5_000 },
    {
      startServer: mock((_opts: StartAcpServerOptions) => Promise.resolve(handle)),
      createClient: (opts: AcpClientOptions): AcpClientLike => new AcpClient(opts),
    },
  );
}

const cascadeAskScript = {
  askIds: ["per_abc123", "per_def456"],
  events: [
    permissionAskedEvent(),
    permissionAskedEvent({ id: "per_def456", permission: "edit", patterns: ["src/**"] }),
    { type: "session.idle" },
  ],
};

test("opencode-acp fails an idle empty-text turn after a rejected permission ask (opencode 1.18.26 cascade)", async () => {
  const fake = installOpencode11826FetchFake(cascadeAskScript);
  try {
    const adapter = createHttpBackedAdapter();
    const { input, events } = createObservedInput([]);

    let caught: unknown;
    try {
      await adapter.dispatch(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "opencode-acp: turn ended idle with empty text after 2 rejected permission ask(s) [doom_loop,edit] (1 reply_failed); opencode halts the turn on a plain permission reject",
    );

    const permissionEvents = events.filter((e) => e.kind === "http.session.permission");
    expect(permissionEvents.map((e) => e.meta?.outcome)).toEqual(["answered", "reply_failed"]);
    expect(permissionEvents.map((e) => e.meta?.permission)).toEqual(["doom_loop", "edit"]);
    const failedReason = permissionEvents[1]?.meta?.reason;
    expect(typeof failedReason === "string" && failedReason.includes("HTTP 404")).toBe(true);
    // reply_failed reports the last route attempted, which says which route 404'd.
    expect(permissionEvents.map((e) => e.meta?.route)).toEqual(["reply", "respond"]);

    expect(fake.calls).toContain("POST http://127.0.0.1:4312/permission/per_def456/reply");
    expect(fake.calls).toContain(
      "POST http://127.0.0.1:4312/session/sess-123/permissions/per_def456",
    );
  } finally {
    fake.restore();
  }
});

test("opencode-acp keeps a rejected-ask turn alive when real text arrives before idle", async () => {
  const fake = installOpencode11826FetchFake({
    askIds: cascadeAskScript.askIds,
    events: [
      permissionAskedEvent(),
      permissionAskedEvent({ id: "per_def456", permission: "edit", patterns: ["src/**"] }),
      {
        type: "message.part.updated",
        properties: { part: { id: "p-1", type: "text" } },
      },
      {
        type: "message.part.delta",
        properties: { partID: "p-1", field: "text", delta: "verdict" },
      },
      { type: "session.idle" },
    ],
  });
  try {
    const { input, events } = createObservedInput([]);
    const out = await createHttpBackedAdapter().dispatch(input);
    expect(out).toEqual({ text: "verdict" });
    const permissionEvents = events.filter((e) => e.kind === "http.session.permission");
    expect(permissionEvents.map((e) => e.meta?.outcome)).toEqual(["answered", "reply_failed"]);
  } finally {
    fake.restore();
  }
});

test("opencode-acp still resolves an empty idle turn that saw no rejected permission asks", async () => {
  const fake = installOpencode11826FetchFake({
    askIds: [],
    events: [{ type: "session.idle" }],
  });
  try {
    const out = await createHttpBackedAdapter().dispatch(createInput());
    expect(out).toEqual({ text: "" });
  } finally {
    fake.restore();
  }
});

test("opencode-acp reject-idle-empty turn exhausts retries and fails the handoff via markFailed", async () => {
  const fake = installOpencode11826FetchFake(cascadeAskScript);
  try {
    const adapter = createHttpBackedAdapter();
    const markFailed = mock(
      (_id: string, _reason: string): Promise<{ handoff_id: string; status: string }> =>
        Promise.resolve({ handoff_id: "h-reject", status: "failed" }),
    );
    const delay = mock((_ms: number): Promise<void> => Promise.resolve());

    const res = await dispatchHandoff({
      handoff: {
        handoff_id: "h-reject",
        from_agent: "user",
        to_agent: "reviewer",
        message: "review this",
      },
      config: {
        agents: [
          {
            name: "reviewer",
            adapter: "opencode-acp",
            options: { model: "deepseek-v4" },
            roles: [],
            auto_approve_to: [],
          },
        ],
        default_roles: {},
      },
      conversation: { id: "conv-reject", project_id: null },
      transcript: [],
      transcriptBudget: 1000,
      hopsSoFar: 0,
      maxHops: 5,
      trustMode: "all",
      observe: () => Promise.resolve({ event_id: "e" }),
      createHandoff: mock(),
      approve: mock(),
      markFailed,
      delay,
      runChatTurn: (input) => realRunChatTurn({ ...input, buildAdapterOverride: () => adapter }),
    });

    expect(res.terminatedReason).toBe("error");
    expect(res.cappedHandoffId).toBe("h-reject");
    expect(markFailed).toHaveBeenCalledTimes(1);
    const reason: unknown = markFailed.mock.calls[0]?.[1];
    expect(typeof reason).toBe("string");
    expect(reason).toMatch(/empty text after .* rejected permission/);
    const messagePosts = fake.calls.filter(
      (call) => call.startsWith("POST") && call.endsWith("/message"),
    );
    expect(messagePosts).toHaveLength(4);
  } finally {
    fake.restore();
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
