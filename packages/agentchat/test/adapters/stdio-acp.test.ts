import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";
import { PassThrough } from "node:stream";

import type { McpServerStdio } from "../../src/adapters/acp-types.js";
import type { AcpWarmPoolDeposit } from "../../src/adapters/acp-warm-pool.js";
import type {
  StartStdioAcpServerOptions,
  StdioAcpHandle,
} from "../../src/adapters/stdio-acp-server.js";
import type { HostEnvPolicy, StdioAcpOptions } from "../../src/adapters/stdio-acp.js";
import type { DispatchInput, DispatchOutput } from "../../src/sdk/adapter.js";
import type { CapturePort } from "../../src/worker/capture-port.js";
import type { WriteToolsExecutor } from "../../src/worker/write-tools-executor.js";

import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import {
  detectStdioAcpClassifierDecline,
  isClaudeHostEnvKey,
  resolveHostEnvPolicy,
  shouldScrubHostEnvKey,
  StdioAcpAdapter,
} from "../../src/adapters/stdio-acp.js";
import { ThoughtCapture } from "../../src/worker/thought-capture.js";
import { expectRejection } from "../helpers/cli-spawn-fixtures.js";
import {
  type AcpRequestMock,
  asCapturedSessionParams,
  type CapturedSessionParams,
  flushMicrotasks,
  makeMockAcpClient,
  makeMockAcpHandle,
  makeMockCapturePort,
  makePenumbraMcpServer,
  makeStandardClientRequest,
  type MockAcpHandle,
  mutableRef,
  sleep,
} from "../helpers/stdio-acp-fixtures.js";

describe("detectStdioAcpClassifierDecline", () => {
  it("detects conservative provider safety refusals only in failed or empty-output turns", () => {
    expect(
      detectStdioAcpClassifierDecline({
        finalText: "",
        errorText: "I'm sorry, but I can't assist with that request.",
      }),
    ).toEqual({
      classifier_declined: true,
      decline_reason: "provider_safety_refusal",
    });

    expect(
      detectStdioAcpClassifierDecline({
        finalText: 'The phrase "I can\'t assist with that request" appears in the test fixture.',
        errorText: null,
      }),
    ).toBeNull();
  });
});

function dispatch(
  adapter: StdioAcpAdapter,
  input: Omit<DispatchInput, "conversation" | "config"> &
    Partial<Pick<DispatchInput, "conversation" | "config">>,
): Promise<DispatchOutput> {
  return adapter.dispatch({
    conversation: { id: "conv-1", project_id: null },
    config: {},
    ...input,
  });
}

type AcpStartServerMock = ReturnType<typeof vi.fn<typeof startStdioAcpServerStub>>;
function startStdioAcpServerStub(_opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> {
  return Promise.resolve(makeMockAcpHandle());
}

/** Build a startServer mock that captures the env passed by the adapter. */
function envCapturingStartServer(handle: MockAcpHandle): {
  startServer: AcpStartServerMock;
  getEnv: () => Record<string, string> | undefined;
} {
  let captured: Record<string, string> | undefined;
  const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
  startServer.mockImplementation((opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> => {
    captured = opts.env;
    return Promise.resolve(handle);
  });
  return { startServer, getEnv: (): Record<string, string> | undefined => captured };
}

/**
 * Create a client whose request method short-circuits the standard
 * initialize/session-new/session-prompt path. Used by env-capture tests that
 * only care about the spawn env, not the prompt-side behavior.
 */
function makeCreateClientWithStandardRequest(): (h: StdioAcpHandle) => StdioAcpClient {
  return (h: StdioAcpHandle): StdioAcpClient => {
    const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
    client.request = makeStandardClientRequest();
    return client;
  };
}

interface RequestPermissionPayload {
  toolCall: { title?: string; name?: string; rawInput: unknown };
  options: { kind: string; optionId: string }[];
}

type SessionPermissionHandler = (params: RequestPermissionPayload) => unknown;

interface WarmPoolHarness {
  adapter: StdioAcpAdapter;
  pool: {
    acquire: ReturnType<typeof vi.fn>;
    deposit: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    evict: ReturnType<typeof vi.fn>;
  };
  mockKill: MockAcpHandle["kill"];
  startServer: AcpStartServerMock;
  request: AcpRequestMock;
}

function createWarmPoolHarness(opts: {
  warmPool?: boolean;
  promptThrows?: boolean;
  sessionNewThrows?: boolean;
}): WarmPoolHarness {
  const handle = makeMockAcpHandle({
    pid: 123,
    exited: new Promise<number | null>(() => {
      // never resolves — tests assert kill behavior, not exit
    }),
  });
  const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
  startServer.mockResolvedValue(handle);
  const pool = {
    acquire: vi.fn().mockReturnValue(null),
    deposit: vi.fn((_key: string, entry: AcpWarmPoolDeposit) => ({
      ...entry,
      refs: new Set<string>(),
      sessionId: "session-123",
      spawnedAt: 0,
      lastReleaseAt: 0,
    })),
    release: vi.fn(),
    evict: vi.fn(),
  };
  const request = makeStandardClientRequest({
    authMethods: [],
    onSessionNew: (): void => {
      if (opts.sessionNewThrows) throw new Error("session-new-failed");
    },
    onSessionPrompt: (): unknown => {
      if (opts.promptThrows) throw new Error("prompt-failed");
      return { stopReason: "end_turn" };
    },
  });
  const adapter = new StdioAcpAdapter(
    { binary: "mock-acp", warmPool: opts.warmPool },
    {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({
          onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
          on: vi.fn<StdioAcpClient["on"]>(),
          request,
        }),
      pool: pool as unknown as NonNullable<
        ConstructorParameters<typeof StdioAcpAdapter>[1]
      >["pool"],
    },
  );
  return { adapter, pool, mockKill: handle.kill, startServer, request };
}

interface PermissionHarness {
  adapter: StdioAcpAdapter;
  mockClientRequest: AcpRequestMock;
  mockKill: MockAcpHandle["kill"];
  mockStdout: PassThrough;
  mockStdin: PassThrough;
  getOutcome: () => unknown;
}

function createPermissionHarness(
  adapterOptions: Partial<StdioAcpOptions> = {
    mcpServers: [makePenumbraMcpServer()],
  },
  permissionPayload: RequestPermissionPayload = {
    toolCall: {
      title: "mcp__penumbra__chain.list_agents",
      rawInput: { args: ["--all"] },
    },
    options: [
      { kind: "allow_always", optionId: "allow-always" },
      { kind: "allow_once", optionId: "allow-once" },
      { kind: "reject_once", optionId: "reject-once" },
    ],
  },
): PermissionHarness {
  const handle = makeMockAcpHandle();
  const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
  startServer.mockResolvedValue(handle);

  let requestHandler: SessionPermissionHandler | undefined;
  let lastOutcome: unknown = null;
  const mockClientRequest = makeStandardClientRequest({
    onSessionPrompt: async (): Promise<unknown> => {
      if (!requestHandler) throw new Error("missing request handler");
      const outcome: unknown = await requestHandler(permissionPayload);
      lastOutcome = outcome;
      return { stopReason: "end_turn" };
    },
  });

  const adapter = new StdioAcpAdapter(
    { binary: "mock-acp", ...adapterOptions },
    {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({
          onRequest: (method: string, handler: (params: unknown) => unknown): void => {
            if (method === "session/request_permission") {
              requestHandler = handler;
            }
          },
          on: vi.fn<StdioAcpClient["on"]>(),
          request: mockClientRequest,
        }),
    },
  );

  return {
    adapter,
    mockClientRequest,
    mockKill: handle.kill,
    mockStdout: handle.stdout,
    mockStdin: handle.stdin,
    getOutcome: (): unknown => lastOutcome,
  };
}

describe("StdioAcpAdapter", () => {
  it("kills a silent child when initialize exceeds bootTimeoutMs", async () => {
    const handle = makeMockAcpHandle({
      pid: 123,
      exited: new Promise<number | null>(() => {
        /* never resolves */
      }),
    });
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", bootTimeoutMs: 20 },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const result = dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });
    const guardedResult = Promise.race([
      result,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("test safety timeout"));
        }, 500);
      }),
    ]);

    await expectRejection(
      guardedResult,
      "stdio-acp: boot timed out after 20ms while waiting for initialize",
    );
    expect(handle.kill).toHaveBeenCalled();
  });

  it("allows normal boot requests that complete before bootTimeoutMs", async () => {
    const request = makeStandardClientRequest({
      authMethods: [],
      beforeInitialize: async (): Promise<void> => {
        await sleep(5);
      },
      beforeSessionNew: async (): Promise<void> => {
        await sleep(5);
      },
    });
    const handle = makeMockAcpHandle({
      pid: 123,
      exited: new Promise<number | null>(() => {
        /* never resolves */
      }),
    });
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", bootTimeoutMs: 100 },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
            on: vi.fn<StdioAcpClient["on"]>(),
            request,
          }),
      },
    );

    const result = await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    expect(result.text).toBe("");
    expect(request).toHaveBeenCalledWith("initialize", expect.any(Object));
    expect(request).toHaveBeenCalledWith("session/new", expect.any(Object));
    expect(handle.kill).toHaveBeenCalled();
  });

  it("keeps warm_pool disabled path cold and never calls the pool", async () => {
    for (const warmPool of [undefined, false]) {
      const { adapter, pool, mockKill } = createWarmPoolHarness({ warmPool });

      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });

      expect(pool.acquire).not.toHaveBeenCalled();
      expect(pool.deposit).not.toHaveBeenCalled();
      expect(pool.release).not.toHaveBeenCalled();
      expect(pool.evict).not.toHaveBeenCalled();
      expect(mockKill).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps warm_pool disabled path cold when session/new throws", async () => {
    const { adapter, pool, mockKill } = createWarmPoolHarness({
      warmPool: false,
      sessionNewThrows: true,
    });

    await expectRejection(
      dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      }),
      "session-new-failed",
    );

    expect(pool.acquire).not.toHaveBeenCalled();
    expect(pool.deposit).not.toHaveBeenCalled();
    expect(pool.release).not.toHaveBeenCalled();
    expect(pool.evict).not.toHaveBeenCalled();
    expect(mockKill).toHaveBeenCalledTimes(1);
  });

  it("warm_pool enabled deposits and releases a clean cold-started session without killing it", async () => {
    const { adapter, pool, mockKill } = createWarmPoolHarness({ warmPool: true });

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    expect(pool.acquire).toHaveBeenCalledTimes(1);
    expect(pool.deposit).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
    expect(pool.evict).not.toHaveBeenCalled();
    expect(mockKill).not.toHaveBeenCalled();
  });

  it("warm_pool enabled evicts and kills when session/prompt throws", async () => {
    const { adapter, pool, mockKill } = createWarmPoolHarness({
      warmPool: true,
      promptThrows: true,
    });

    await expectRejection(
      dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      }),
      "prompt-failed",
    );

    expect(pool.deposit).toHaveBeenCalledTimes(1);
    expect(pool.evict).toHaveBeenCalledTimes(1);
    expect(mockKill).toHaveBeenCalledTimes(1);
  });

  it("isClaudeHostEnvKey identifies host-Claude env keys", () => {
    expect(isClaudeHostEnvKey("CLAUDECODE")).toBe(true);
    expect(isClaudeHostEnvKey("CLAUDE_CODE_ENTRYPOINT")).toBe(true);
    expect(isClaudeHostEnvKey("CLAUDE_CODE_FOO_BAR_2")).toBe(true);
    expect(isClaudeHostEnvKey("CLAUDE_EFFORT")).toBe(true);
    expect(isClaudeHostEnvKey("CLAUDE_PLUGIN_DATA")).toBe(true);
    expect(isClaudeHostEnvKey("ANTHROPIC_MODEL")).toBe(false);
    expect(isClaudeHostEnvKey("CLAUDE_CONFIG_DIR")).toBe(false);
    expect(isClaudeHostEnvKey("CLAUDECODE_EXTRA")).toBe(false);
    expect(isClaudeHostEnvKey("CLAUDE")).toBe(false);
    expect(isClaudeHostEnvKey("")).toBe(false);
  });

  it("dispatchStream scrubs only claude host env keys when hostEnvPolicy enables claude", async () => {
    const previousEnv = {
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_FOO: process.env.CLAUDE_CODE_FOO,
      OPENCODE_BAR: process.env.OPENCODE_BAR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_FOO = "bar";
    process.env.OPENCODE_BAR = "keep";
    process.env.ANTHROPIC_API_KEY = "keep";

    try {
      const capturedEnv: Record<string, string> = {};
      const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
      startServer.mockImplementation(
        (opts: StartStdioAcpServerOptions): Promise<StdioAcpHandle> => {
          Object.assign(capturedEnv, opts.env);
          return Promise.resolve(makeMockAcpHandle());
        },
      );
      const adapter = new StdioAcpAdapter(
        {
          binary: "mock-acp",
          hostEnvPolicy: { claude: true },
        },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            makeMockAcpClient({
              onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
              on: vi.fn<StdioAcpClient["on"]>(),
              request: makeStandardClientRequest(),
            }),
        },
      );

      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });

      expect(capturedEnv.CLAUDECODE).toBeUndefined();
      expect(capturedEnv.CLAUDE_CODE_FOO).toBeUndefined();
      expect(capturedEnv.OPENCODE_BAR).toBe("keep");
      expect(capturedEnv.ANTHROPIC_API_KEY).toBe("keep");
    } finally {
      if (previousEnv.CLAUDECODE === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = previousEnv.CLAUDECODE;
      if (previousEnv.CLAUDE_CODE_FOO === undefined) delete process.env.CLAUDE_CODE_FOO;
      else process.env.CLAUDE_CODE_FOO = previousEnv.CLAUDE_CODE_FOO;
      if (previousEnv.OPENCODE_BAR === undefined) delete process.env.OPENCODE_BAR;
      else process.env.OPENCODE_BAR = previousEnv.OPENCODE_BAR;
      if (previousEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousEnv.ANTHROPIC_API_KEY;
    }
  });

  it("resolveHostEnvPolicy returns claude when only the legacy alias is set", () => {
    expect(resolveHostEnvPolicy({ sanitizeClaudeHostEnv: true })).toEqual({ claude: true });
  });

  it("resolveHostEnvPolicy merges the legacy alias when hostEnvPolicy is empty", () => {
    expect(resolveHostEnvPolicy({ hostEnvPolicy: {}, sanitizeClaudeHostEnv: true })).toEqual({
      claude: true,
    });
  });

  it("resolveHostEnvPolicy preserves explicit false over the legacy alias", () => {
    expect(
      resolveHostEnvPolicy({
        hostEnvPolicy: { claude: false },
        sanitizeClaudeHostEnv: true,
      }),
    ).toEqual({ claude: false });
  });

  it("resolveHostEnvPolicy throws on unknown enabled providers", () => {
    expect(() =>
      resolveHostEnvPolicy({
        hostEnvPolicy: { unknown: true } as unknown as HostEnvPolicy,
      }),
    ).toThrow(/unknown provider "unknown"/);
  });

  it("resolveHostEnvPolicy allows unknown disabled providers", () => {
    expect(
      resolveHostEnvPolicy({
        hostEnvPolicy: { unknown: false } as unknown as HostEnvPolicy,
      }),
    ).toEqual({ unknown: false } as unknown as HostEnvPolicy);
  });

  it("shouldScrubHostEnvKey returns false for an unregistered provider", () => {
    expect(
      shouldScrubHostEnvKey("OPENCODE_BAR", { opencode: true } as unknown as HostEnvPolicy),
    ).toBe(false);
  });

  function withClaudeCodeHostEnv<T>(run: () => Promise<T>): Promise<T> {
    const prev = {
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
      CLAUDE_CODE_EXECPATH: process.env.CLAUDE_CODE_EXECPATH,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      CLAUDE_CODE_ENABLE_TELEMETRY: process.env.CLAUDE_CODE_ENABLE_TELEMETRY,
      CLAUDE_EFFORT: process.env.CLAUDE_EFFORT,
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
    };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "test-claude_code_entrypoint";
    process.env.CLAUDE_CODE_EXECPATH = "test-claude_code_execpath";
    process.env.CLAUDE_CODE_SESSION_ID = "test-claude_code_session_id";
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = "test-claude_code_enable_telemetry";
    process.env.CLAUDE_EFFORT = "test-claude_effort";
    process.env.CLAUDE_PLUGIN_DATA = "test-claude_plugin_data";
    return run().finally(() => {
      restoreClaudeHostEnv(prev);
    });
  }

  interface ClaudeHostPrev {
    CLAUDECODE: string | undefined;
    CLAUDE_CODE_ENTRYPOINT: string | undefined;
    CLAUDE_CODE_EXECPATH: string | undefined;
    CLAUDE_CODE_SESSION_ID: string | undefined;
    CLAUDE_CODE_ENABLE_TELEMETRY: string | undefined;
    CLAUDE_EFFORT: string | undefined;
    CLAUDE_PLUGIN_DATA: string | undefined;
  }

  function restoreClaudeHostEnv(prev: ClaudeHostPrev): void {
    restoreEnvPair1(prev);
    restoreEnvPair2(prev);
    restoreEnvPair3(prev);
    restoreEnvPair4(prev);
  }

  function restoreEnvPair1(prev: ClaudeHostPrev): void {
    if (prev.CLAUDECODE !== undefined) process.env.CLAUDECODE = prev.CLAUDECODE;
    else delete process.env.CLAUDECODE;
    if (prev.CLAUDE_CODE_ENTRYPOINT !== undefined)
      process.env.CLAUDE_CODE_ENTRYPOINT = prev.CLAUDE_CODE_ENTRYPOINT;
    else delete process.env.CLAUDE_CODE_ENTRYPOINT;
  }

  function restoreEnvPair2(prev: ClaudeHostPrev): void {
    if (prev.CLAUDE_CODE_EXECPATH !== undefined)
      process.env.CLAUDE_CODE_EXECPATH = prev.CLAUDE_CODE_EXECPATH;
    else delete process.env.CLAUDE_CODE_EXECPATH;
    if (prev.CLAUDE_CODE_SESSION_ID !== undefined)
      process.env.CLAUDE_CODE_SESSION_ID = prev.CLAUDE_CODE_SESSION_ID;
    else delete process.env.CLAUDE_CODE_SESSION_ID;
  }

  function restoreEnvPair3(prev: ClaudeHostPrev): void {
    if (prev.CLAUDE_CODE_ENABLE_TELEMETRY !== undefined)
      process.env.CLAUDE_CODE_ENABLE_TELEMETRY = prev.CLAUDE_CODE_ENABLE_TELEMETRY;
    else delete process.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    if (prev.CLAUDE_EFFORT !== undefined) process.env.CLAUDE_EFFORT = prev.CLAUDE_EFFORT;
    else delete process.env.CLAUDE_EFFORT;
  }

  function restoreEnvPair4(prev: ClaudeHostPrev): void {
    if (prev.CLAUDE_PLUGIN_DATA !== undefined)
      process.env.CLAUDE_PLUGIN_DATA = prev.CLAUDE_PLUGIN_DATA;
    else delete process.env.CLAUDE_PLUGIN_DATA;
  }

  it("calls requestPermission with the tool call context and selects allow_always on approve", async () => {
    const requestPermission = vi.fn().mockResolvedValue("approve" as const);
    const { adapter, getOutcome } = createPermissionHarness();

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "mcp__penumbra__chain.list_agents",
      rawInput: { args: ["--all"] },
      dispatchId: expect.any(String) as unknown,
    });

    expect(getOutcome()).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("registers permission handling for standalone fs.write capability", async () => {
    const requestPermission = vi.fn().mockResolvedValue("approve" as const);
    const { adapter, getOutcome } = createPermissionHarness({ fsWriteTextFile: true });

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalled();
    expect(getOutcome()).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("registers permission handling for standalone terminal capability", async () => {
    const requestPermission = vi.fn().mockResolvedValue("approve" as const);
    const { adapter, getOutcome } = createPermissionHarness({ terminal: true });

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalled();
    expect(getOutcome()).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
  });

  it("without trust_mode 'all', absent requestPermission keeps the original allow_always tie-break", async () => {
    const devinOptions = [
      { kind: "allow_once", optionId: "allow_once" },
      { kind: "allow_always", optionId: "switch_accept_edits" },
      { kind: "allow_always", optionId: "switch_bypass" },
      { kind: "reject_once", optionId: "reject_once" },
    ];
    const harness = createPermissionHarness(
      { mcpServers: [makePenumbraMcpServer()] },
      {
        toolCall: { title: "Edit", rawInput: { args: ["touch", "file"] } },
        options: devinOptions,
      },
    );

    await dispatch(harness.adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    expect(harness.getOutcome()).toEqual({
      outcome: { outcome: "selected", optionId: "switch_accept_edits" },
    });
  });

  it("under trust_mode 'all', handlePermissionRequest prefers an exact bypass allow_always option over another allow_always option", async () => {
    const devinOptions = [
      { kind: "allow_once", optionId: "allow_once" },
      { kind: "allow_always", optionId: "switch_accept_edits" },
      { kind: "allow_always", optionId: "switch_bypass" },
      { kind: "reject_once", optionId: "reject_once" },
    ];
    const devinHarness = createPermissionHarness(
      { mcpServers: [makePenumbraMcpServer()] },
      {
        toolCall: { title: "Edit", rawInput: { args: ["touch", "file"] } },
        options: devinOptions,
      },
    );

    await dispatch(devinHarness.adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission: vi.fn().mockResolvedValue("approve" as const),
      trust_mode: "all",
    });

    expect(devinHarness.getOutcome()).toEqual({
      outcome: { outcome: "selected", optionId: "switch_bypass" },
    });

    const singleAllowHarness = createPermissionHarness(
      { mcpServers: [makePenumbraMcpServer()] },
      {
        toolCall: { title: "Edit", rawInput: { args: ["touch", "file"] } },
        options: [{ kind: "allow_always", optionId: "switch_accept_edits" }],
      },
    );

    await dispatch(singleAllowHarness.adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission: vi.fn().mockResolvedValue("approve" as const),
      trust_mode: "all",
    });

    expect(singleAllowHarness.getOutcome()).toEqual({
      outcome: { outcome: "selected", optionId: "switch_accept_edits" },
    });
  });

  it("under trust_mode 'all', handlePermissionRequest does not select bypass-looking disabled options", async () => {
    const harness = createPermissionHarness(
      { mcpServers: [makePenumbraMcpServer()] },
      {
        toolCall: { title: "Edit", rawInput: { args: ["touch", "file"] } },
        options: [
          { kind: "allow_always", optionId: "switch_bypass_disabled" },
          { kind: "allow_always", optionId: "switch_accept_edits" },
          { kind: "reject_once", optionId: "reject_once" },
        ],
      },
    );

    await dispatch(harness.adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission: vi.fn().mockResolvedValue("approve" as const),
      trust_mode: "all",
    });

    expect(harness.getOutcome()).toEqual({
      outcome: { outcome: "selected", optionId: "switch_accept_edits" },
    });
  });

  it("a terminal/create auto-approved under trust_mode 'all' logs cwd and program without command arguments", async () => {
    let terminalCreateHandler: ((params: unknown) => unknown) | undefined;
    const mockClientRequest = makeStandardClientRequest({
      onSessionPrompt: async (): Promise<unknown> => {
        if (!terminalCreateHandler) throw new Error("missing terminal/create handler");
        await terminalCreateHandler({
          command: "deploy.sh --token=SUPERSECRET123",
          args: ["deploy.sh", "--token=SUPERSECRET123"],
          cwd: "/tmp/project",
        });
        return { stopReason: "end_turn" };
      },
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", terminal: true },
      {
        startServer: vi.fn(startStdioAcpServerStub),
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: (method: string, handler: (params: unknown) => unknown): void => {
              if (method === "terminal/create") terminalCreateHandler = handler;
            },
            on: vi.fn<StdioAcpClient["on"]>(),
            request: mockClientRequest,
          }),
      },
    );

    let matchingLogCount = 0;
    let logLines: string[] = [];
    try {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
        trust_mode: "all",
        executor: {
          terminalCreate: (): Promise<unknown> => Promise.resolve({ terminal_id: "term-123" }),
        } as unknown as WriteToolsExecutor,
      });
      matchingLogCount = infoSpy.mock.calls.filter(([message]) =>
        String(message).includes("stdio-acp: terminal/create auto-approved"),
      ).length;
      logLines = infoSpy.mock.calls.map(([message]) => String(message));
    } finally {
      infoSpy.mockRestore();
    }

    expect(matchingLogCount).toBe(1);
    const matchingLog = logLines.find((message) =>
      message.includes("stdio-acp: terminal/create auto-approved"),
    );
    expect(matchingLog).toContain("program=deploy.sh");
    expect(matchingLog).toContain("cwd=/tmp/project");
    expect(matchingLog).toContain("commandLength=32");
    expect(matchingLog).not.toContain("SUPERSECRET123");
  });

  it("returns cancelled when requestPermission rejects the tool call", async () => {
    const requestPermission = vi.fn().mockResolvedValue("reject" as const);
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    let requestHandler: SessionPermissionHandler | undefined;
    let lastOutcome: unknown = null;
    const mockClientRequest = makeStandardClientRequest({
      onSessionPrompt: async (): Promise<unknown> => {
        if (!requestHandler) throw new Error("missing request handler");
        lastOutcome = await requestHandler({
          toolCall: {
            title: "mcp__penumbra__chain.list_agents",
            rawInput: { args: ["--all"] },
          },
          options: [{ kind: "allow_always", optionId: "allow-always" }],
        });
        return { stopReason: "end_turn" };
      },
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [makePenumbraMcpServer()],
      },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: (method: string, handler: (params: unknown) => unknown): void => {
              if (method === "session/request_permission") {
                requestHandler = handler;
              }
            },
            on: vi.fn<StdioAcpClient["on"]>(),
            request: mockClientRequest,
          }),
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalledWith({
      toolName: "mcp__penumbra__chain.list_agents",
      rawInput: { args: ["--all"] },
      dispatchId: expect.any(String) as unknown,
    });

    expect(lastOutcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(handle.kill).toHaveBeenCalled();
  });

  it("returns cancelled locally without invoking requestPermission when tool title and name are both missing", async () => {
    const requestPermission = vi.fn().mockResolvedValue("approve");
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    let requestHandler: SessionPermissionHandler | undefined;
    let lastOutcome: unknown = null;
    const mockClientRequest = makeStandardClientRequest({
      onSessionPrompt: async (): Promise<unknown> => {
        if (!requestHandler) throw new Error("missing request handler");
        lastOutcome = await requestHandler({
          toolCall: {
            rawInput: { whatever: 1 },
          },
          options: [
            { kind: "allow_always", optionId: "allow-always" },
            { kind: "allow_once", optionId: "allow-once" },
            { kind: "reject_once", optionId: "reject-once" },
          ],
        });
        return { stopReason: "end_turn" };
      },
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [makePenumbraMcpServer()],
      },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: (method: string, handler: (params: unknown) => unknown): void => {
              if (method === "session/request_permission") {
                requestHandler = handler;
              }
            },
            on: vi.fn<StdioAcpClient["on"]>(),
            request: mockClientRequest,
          }),
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(lastOutcome).toEqual({ outcome: { outcome: "cancelled" } });
    expect(handle.kill).toHaveBeenCalled();
  });

  it("keeps the Phase 1a auto-allow stub when requestPermission is absent", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    let requestHandler: SessionPermissionHandler | undefined;
    let lastOutcome: unknown = null;
    const mockClientRequest = makeStandardClientRequest({
      onSessionPrompt: async (): Promise<unknown> => {
        if (!requestHandler) throw new Error("missing request handler");
        lastOutcome = await requestHandler({
          toolCall: {
            title: "mcp__penumbra__chain.list_agents",
            rawInput: { args: ["--all"] },
          },
          options: [{ kind: "allow_always", optionId: "allow-always" }],
        });
        return { stopReason: "end_turn" };
      },
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [makePenumbraMcpServer()],
      },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: (method: string, handler: (params: unknown) => unknown): void => {
              if (method === "session/request_permission") {
                requestHandler = handler;
              }
            },
            on: vi.fn<StdioAcpClient["on"]>(),
            request: mockClientRequest,
          }),
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    expect(lastOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow-always" } });
    expect(handle.kill).toHaveBeenCalled();
  });

  it("happy path: accumulates text from session/update notifications", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    // 1. Server sends initialize response
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: 1 }, id: 1 }) + "\n",
    );

    // 2. Server sends session/new response
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { sessionId: "session-123" }, id: 2 }) + "\n",
    );

    // 3. Server streams agent_message_chunk session/update notifications carrying the text
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "wor" },
          },
        },
      }) + "\n",
    );
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ld" },
          },
        },
      }) + "\n",
    );

    // 4. Server sends prompt response with stopReason — signals turn complete (no text in response)
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { stopReason: "end_turn" }, id: 3 }) + "\n",
    );

    const result = await dispatchPromise;
    expect(result.text).toBe("world");
    expect(handle.kill).toHaveBeenCalled();
  });

  it("routes agent_thought_chunk notifications through ThoughtCapture", async () => {
    const recorded: DispatchEventInput[] = [];
    const thoughtCapture = new ThoughtCapture({
      config: {
        enabled: true,
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 1000,
          adapters: { "stdio-acp": true },
          perAgentOverrides: {},
        },
        analyze: {
          enabled: false,
          onlyWhen: [],
          digest: { enabled: false, pool: "x", maxInputChars: 50000, timeoutMs: 60000 },
          signals: {
            enabled: false,
            pool: "x",
            timeoutMs: 60000,
            maxInputChars: null,
            definitions: [],
          },
        },
      },
      enqueue: (event: DispatchEventInput): void => {
        recorded.push(event);
      },
    });

    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", model: "gemini-acp-pro" },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
        thoughtCapture,
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hello",
      conversation: { id: "c-1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "h-acp-1",
    });

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: 1, authMethods: [] }, id: 1 }) +
        "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { sessionId: "session-123" }, id: 2 }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking" },
            token_count: 3,
          },
        },
      }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { stopReason: "end_turn" }, id: 3 }) + "\n",
    );

    await dispatchPromise;

    const thoughtEvents = recorded.filter((event) => event.kind === "agent.thought");
    expect(thoughtEvents).toHaveLength(1);
    expect(thoughtEvents[0]).toMatchObject({
      handoff_id: "h-acp-1",
      meta: {
        adapter: "stdio-acp",
        text: "thinking",
        token_count: 3,
      },
    });
  });

  it("emits ACP lifecycle events when eventContext is present", async () => {
    const handle = makeMockAcpHandle();
    const events: DispatchEventInput[] = [];
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const mockClientRequest = makeStandardClientRequest({ authMethods: [] });

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      conversation: { id: "c-1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      eventContext: { handoffId: "h-acp", workerId: "w-acp" },
      onEvent: (event: DispatchEventInput): void => {
        events.push(event);
      },
    });

    expect(events.map((event) => event.kind)).toEqual([
      "acp.server.start",
      "acp.session.start",
      "acp.session.end",
    ]);
    expect(events[0]).toMatchObject({
      handoff_id: "h-acp",
      worker_id: "w-acp",
      source: "worker",
      meta: { adapter: "stdio-acp", binary: "mock-acp" },
    });
    expect(events[1]?.meta).toMatchObject({ session_id: "session-123" });
    expect(events[2]?.meta).toMatchObject({ stop_reason: "end_turn" });
  });

  it("uses the cached tool title when a failed tool_call_update omits title and kind", async () => {
    const handle = makeMockAcpHandle();
    const events: DispatchEventInput[] = [];
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [makePenumbraMcpServer()],
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hello",
      conversation: { id: "c-1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      eventContext: { handoffId: "h-acp", workerId: "w-acp" },
      onEvent: (event: DispatchEventInput): void => {
        events.push(event);
      },
    });

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: 1, authMethods: [] }, id: 1 }) +
        "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { sessionId: "session-123" }, id: 2 }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tu_123",
            title: "mcp__penumbra__chain_start_simple",
            status: "pending",
            input: {},
          },
        },
      }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tu_123",
            status: "failed",
            output: { is_error: true, content: "..." },
          },
        },
      }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { stopReason: "end_turn" }, id: 3 }) + "\n",
    );

    await dispatchPromise;

    const failedEvents = events.filter((event) => event.kind === "agent.tool_call.failed");
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]).toMatchObject({
      handoff_id: "h-acp",
      worker_id: "w-acp",
      source: "worker",
      meta: {
        adapter: "stdio-acp",
        tool_call_id: "tu_123",
        tool_name: "mcp__penumbra__chain_start_simple",
        output: { is_error: true, content: "..." },
      },
    });
  });

  it("rejects tool_call session/update notifications", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    // 1. Initialize
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: 1 }, id: 1 }) + "\n",
    );

    // 2. session/new
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { sessionId: "session-123" }, id: 2 }) + "\n",
    );

    // 3. Server emits a tool_call session/update — adapter should reject single-turn dispatch
    await sleep(10);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "read",
          },
        },
      }) + "\n",
    );

    await expectRejection(dispatchPromise, "stdio-acp: tool use not yet supported");
    expect(handle.kill).toHaveBeenCalled();
  });

  it("keeps tool_call session/update alive when only mcpServers are advertised", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        fsReadTextFile: false,
        fsWriteTextFile: false,
        terminal: false,
        mcpServers: [{ name: "test", command: "echo", args: [], env: [] }],
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: 1 }, id: 1 }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { sessionId: "session-123" }, id: 2 }) + "\n",
    );

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-123",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "read",
          },
        },
      }) + "\n",
    );

    expect(handle.kill).not.toHaveBeenCalled();

    await sleep(10);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { stopReason: "end_turn" }, id: 3 }) + "\n",
    );

    const settled = await dispatchPromise;
    expect(settled).toMatchObject({ text: "" });
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it("forwards session/update.usage_update to the capture port", async () => {
    const captureEmitSpy = vi.fn<CapturePort["emit"]>();
    const fakeCapturePort = makeMockCapturePort({ emit: captureEmitSpy });

    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "fake", capturePort: fakeCapturePort },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient =>
          new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hi",
      conversation: { id: "c-1", project_id: null },
      config: {},
      signal: new AbortController().signal,
    });

    // Fake the initialize -> newSession -> session/prompt sequence enough to receive a session/update
    await sleep(5);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { protocolVersion: 1, authMethods: [] }, id: 1 }) +
        "\n",
    );
    await sleep(5);
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { sessionId: "session-1" }, id: 2 }) + "\n",
    );
    await sleep(5);
    handle.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "usage_update",
            used: 1234,
            size: 200000,
            cost: { amount: 0.05, currency: "USD" },
          },
        },
      }) + "\n",
    );
    await sleep(10);

    expect(captureEmitSpy).toHaveBeenCalledWith({
      kind: "usage_update",
      used: 1234,
      size: 200000,
      cost: { amount: 0.05, currency: "USD" },
    });

    // Cleanup: complete the prompt so dispatch resolves
    handle.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", result: { stopReason: "end_turn" }, id: 3 }) + "\n",
    );
    await dispatchPromise.catch((): void => {
      // tolerate reject; we're only asserting the emit
    });
  });

  it("rejects when session/prompt hangs past requestTimeoutMs and kills the server", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const mockClientRequest = makeStandardClientRequest({
      onSessionPrompt: (): Promise<unknown> =>
        new Promise<unknown>(() => {
          /* hang forever */
        }),
    });

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", requestTimeoutMs: 200 },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    const dispatchPromise = dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    await expectRejection(dispatchPromise, /no wire activity .* for 200ms/);
    expect(handle.kill).toHaveBeenCalled();
  });

  it("keeps session/prompt alive when ACP session/update progress arrives", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const mockClientRequest = makeStandardClientRequest({
      onSessionPrompt: async (): Promise<unknown> => {
        setTimeout(() => {
          handle.stdout.write(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "session-123",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "still working" },
                },
              },
            }) + "\n",
          );
        }, 150);
        await sleep(300);
        return { stopReason: "end_turn" };
      },
    });

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", requestTimeoutMs: 200 },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    const settled = await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });
    expect(settled).toMatchObject({ text: "still working" });
    expect(handle.kill).toHaveBeenCalledTimes(1);
  });

  it("does not authenticate solely because an agent advertises auth methods", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const mockClientRequest = makeStandardClientRequest({
      authMethods: [
        { id: "openai-api-key", type: "env_var", vars: [{ name: "OPENAI_API_KEY" }] },
        { id: "chatgpt", type: "oauth" },
      ],
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        env: { FOO: "bar", OPENAI_API_KEY: "local-key" },
        unsetEnv: ["OPENAI_API_KEY"],
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    const firstCall = startServer.mock.calls[0];
    if (!firstCall) throw new Error("expected startServer to be called");
    const passedEnv = firstCall[0].env ?? {};
    expect(passedEnv.FOO).toBe("bar");
    expect(passedEnv.OPENAI_API_KEY).toBeUndefined();

    expect(mockClientRequest).not.toHaveBeenCalledWith("authenticate", { methodId: "chatgpt" });
    expect(handle.kill).toHaveBeenCalled();
  });

  it("authenticates once and retries session/new after the ACP auth-required error", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);
    let sessionNewAttempts = 0;
    const mockClientRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async (method) => {
        if (method === "initialize") {
          return {
            protocolVersion: 1,
            authMethods: [
              { id: "openai-api-key", type: "env_var", vars: [{ name: "OPENAI_API_KEY" }] },
            ],
          };
        }
        if (method === "session/new") {
          sessionNewAttempts += 1;
          if (sessionNewAttempts === 1) {
            throw new Error("stdio-acp-client: Authentication required (code: -32000)");
          }
          return { sessionId: "session-after-auth" };
        }
        if (method === "session/prompt") return { stopReason: "end_turn" };
        return {};
      },
    );
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", env: { OPENAI_API_KEY: "test-key" } },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
            on: vi.fn<StdioAcpClient["on"]>(),
            request: mockClientRequest,
          }),
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    expect(mockClientRequest).toHaveBeenCalledWith("authenticate", { methodId: "openai-api-key" });
    expect(
      mockClientRequest.mock.calls.filter(([method]) => method === "authenticate"),
    ).toHaveLength(1);
    expect(sessionNewAttempts).toBe(2);
  });

  it("propagates authenticate failure without retrying session/new again", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);
    let sessionNewAttempts = 0;
    const mockClientRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async (method) => {
        if (method === "initialize") {
          return { protocolVersion: 1, authMethods: [{ id: "chat-gpt", type: "agent" }] };
        }
        if (method === "session/new") {
          sessionNewAttempts += 1;
          throw new Error("stdio-acp-client: Authentication required (code: -32000)");
        }
        if (method === "authenticate") throw new Error("authentication rejected");
        return {};
      },
    );
    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (): StdioAcpClient =>
          makeMockAcpClient({
            onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
            on: vi.fn<StdioAcpClient["on"]>(),
            request: mockClientRequest,
          }),
      },
    );

    await expectRejection(
      dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      }),
      "authentication rejected",
    );

    expect(
      mockClientRequest.mock.calls.filter(([method]) => method === "authenticate"),
    ).toHaveLength(1);
    expect(sessionNewAttempts).toBe(1);
  });

  it("claude-agent-acp binary strips host env", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "claude-agent-acp", sanitizeClaudeHostEnv: true },
      { startServer, createClient: makeCreateClientWithStandardRequest() },
    );

    await withClaudeCodeHostEnv(async (): Promise<void> => {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "CLAUDE_EFFORT",
      "CLAUDE_PLUGIN_DATA",
    ]) {
      expect(capturedEnv).not.toHaveProperty(key);
    }
    expect(handle.kill).toHaveBeenCalled();
  });

  it("non-claude binary does not strip host env", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "opencode-acp" },
      { startServer, createClient: makeCreateClientWithStandardRequest() },
    );

    await withClaudeCodeHostEnv(async (): Promise<void> => {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).toHaveProperty("CLAUDECODE", "1");
    expect(capturedEnv).toHaveProperty("CLAUDE_CODE_EXECPATH", "test-claude_code_execpath");
    expect(handle.kill).toHaveBeenCalled();
  });

  it("sanitize flag plus opts.env override survives", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "claude-agent-acp", sanitizeClaudeHostEnv: true, env: { CLAUDE_EFFORT: "low" } },
      { startServer, createClient: makeCreateClientWithStandardRequest() },
    );

    await withClaudeCodeHostEnv(async (): Promise<void> => {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).toHaveProperty("CLAUDE_EFFORT", "low");
    expect(handle.kill).toHaveBeenCalled();
  });

  it("sanitize flag plus unsetEnv removes opts.env entry", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);

    const adapter = new StdioAcpAdapter(
      {
        binary: "claude-agent-acp",
        sanitizeClaudeHostEnv: true,
        env: { CLAUDE_EFFORT: "low" },
        unsetEnv: ["CLAUDE_EFFORT"],
      },
      { startServer, createClient: makeCreateClientWithStandardRequest() },
    );

    await withClaudeCodeHostEnv(async (): Promise<void> => {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });
    });

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("CLAUDE_EFFORT");
    expect(handle.kill).toHaveBeenCalled();
  });

  it("prefix match strips arbitrary CLAUDE_CODE_* key", async () => {
    const handle = makeMockAcpHandle();
    const { startServer, getEnv } = envCapturingStartServer(handle);

    const adapter = new StdioAcpAdapter(
      { binary: "claude-agent-acp", sanitizeClaudeHostEnv: true },
      { startServer, createClient: makeCreateClientWithStandardRequest() },
    );

    const previous = process.env.CLAUDE_CODE_FUTURE_FLAG;
    process.env.CLAUDE_CODE_FUTURE_FLAG = "1";
    try {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_FUTURE_FLAG;
      } else {
        process.env.CLAUDE_CODE_FUTURE_FLAG = previous;
      }
    }

    const capturedEnv = getEnv();
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("CLAUDE_CODE_FUTURE_FLAG");
    expect(handle.kill).toHaveBeenCalled();
  });

  it("does not use authMethodId until an operation requires authentication", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const mockClientRequest = makeStandardClientRequest({
      authMethods: [
        { id: "openai-api-key", type: "env_var", vars: [{ name: "OPENAI_API_KEY" }] },
        { id: "custom-auth", type: "custom" },
      ],
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        authMethodId: "custom-auth",
        env: { OPENAI_API_KEY: "present" }, // Heuristic would pick openai-api-key
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await dispatch(adapter, {
      prompt: "hello",
      signal: new AbortController().signal,
    });

    expect(mockClientRequest).not.toHaveBeenCalledWith("authenticate", { methodId: "custom-auth" });
  });

  it("sends prompt as ContentBlock array per ACP spec", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const mockClientRequest = makeStandardClientRequest();

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp" },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await dispatch(adapter, {
      prompt: "hello world",
      signal: new AbortController().signal,
    });

    const promptCall = mockClientRequest.mock.calls.find((c) => c[0] === "session/prompt");
    expect(promptCall).toBeDefined();
    expect(promptCall?.[1]).toEqual({
      sessionId: "session-123",
      prompt: [{ type: "text", text: "hello world" }],
    });
  });

  it("passes mcpServers from options into session/new params", async () => {
    const originalStorageRoot = process.env.PENUMBRA_STORAGE_ROOT;
    delete process.env.PENUMBRA_STORAGE_ROOT;
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const capturedRef = mutableRef<CapturedSessionParams | null>(null);
    const mockClientRequest = makeStandardClientRequest({
      onSessionNew: (params: unknown): void => {
        capturedRef.value = asCapturedSessionParams(params);
      },
    });

    const mcpServers: McpServerStdio[] = [
      {
        name: "penumbra",
        command: "bun",
        args: ["/tmp/penumbra-mcp.ts"],
        env: [{ name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-live" }],
      },
    ];

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", mcpServers },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    try {
      await dispatch(adapter, {
        prompt: "hello",
        signal: new AbortController().signal,
      });
    } finally {
      if (originalStorageRoot === undefined) {
        delete process.env.PENUMBRA_STORAGE_ROOT;
      } else {
        process.env.PENUMBRA_STORAGE_ROOT = originalStorageRoot;
      }
    }

    const captured = capturedRef.value;
    expect(captured).not.toBeNull();
    expect(captured?.mcpServers).toEqual(mcpServers);
  });

  it("injects PENUMBRA_HANDOFF_ID only for penumbra-mcp stdio servers, even when env is omitted", async () => {
    const originalStorageRoot = process.env.PENUMBRA_STORAGE_ROOT;
    process.env.PENUMBRA_STORAGE_ROOT = "/tmp/penumbra-test-storage";
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const capturedRef = mutableRef<CapturedSessionParams | null>(null);
    const mockClientRequest = makeStandardClientRequest({
      onSessionNew: (params: unknown): void => {
        capturedRef.value = asCapturedSessionParams(params);
      },
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [
          {
            name: "penumbra-mcp",
            command: "/bin/penumbra-mcp",
            args: [],
            env: [],
          },
          {
            name: "github-mcp",
            command: "/bin/github-mcp",
            args: [],
            env: [{ name: "TOKEN", value: "abc123" }],
          },
        ],
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    try {
      await dispatch(adapter, {
        prompt: "hi",
        conversation: { id: "c1", project_id: null },
        config: {},
        signal: new AbortController().signal,
        handoff_id: "HANDOFF_ABC",
      });
    } finally {
      if (originalStorageRoot === undefined) {
        delete process.env.PENUMBRA_STORAGE_ROOT;
      } else {
        process.env.PENUMBRA_STORAGE_ROOT = originalStorageRoot;
      }
    }

    const captured = capturedRef.value;
    expect(captured?.mcpServers).toBeDefined();
    expect(captured?.mcpServers?.[0]?.env).toEqual([
      { name: "PENUMBRA_HANDOFF_ID", value: "HANDOFF_ABC" },
      { name: "PENUMBRA_MCP_ORIGIN", value: "fleet-worker" },
      { name: "PENUMBRA_STORAGE_ROOT", value: "/tmp/penumbra-test-storage" },
    ]);
    expect(captured?.mcpServers?.[1]?.env).toEqual([{ name: "TOKEN", value: "abc123" }]);
  });

  it("injects long-lived identity + allowlist env for long_lived_tick dispatches", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const capturedRef = mutableRef<CapturedSessionParams | null>(null);
    const mockClientRequest = makeStandardClientRequest({
      onSessionNew: (params: unknown): void => {
        capturedRef.value = asCapturedSessionParams(params);
      },
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [
          {
            name: "penumbra-mcp",
            command: "/bin/penumbra-mcp",
            args: [],
            env: [{ name: "TOKEN", value: "abc123" }],
          },
          {
            name: "github-mcp",
            command: "/bin/github-mcp",
            args: [],
            env: [{ name: "GITHUB_TOKEN", value: "xyz" }],
          },
        ],
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await dispatch(adapter, {
      prompt: "hi",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: "HANDOFF_ABC",
      long_lived_session: {
        dispatch_kind: "long_lived_tick",
        agent_id: "agent-1",
        tick_id: "tick-1",
        mcp_tool_allowlist: [
          "penumbra:long_lived_self_state_get",
          "penumbra:memory_search",
          "ha:ha_pulse",
        ],
      },
    });

    const captured = capturedRef.value;
    expect(captured?.mcpServers).toBeDefined();
    const env = captured?.mcpServers?.[0]?.env ?? [];
    expect(env).toContainEqual({ name: "TOKEN", value: "abc123" });
    expect(env).toContainEqual({ name: "PENUMBRA_HANDOFF_ID", value: "HANDOFF_ABC" });
    expect(env).toContainEqual({ name: "PENUMBRA_MCP_ORIGIN", value: "fleet-worker" });
    expect(env).toContainEqual({ name: "PENUMBRA_LONG_LIVED_AGENT_ID", value: "agent-1" });
    expect(env).toContainEqual({ name: "PENUMBRA_LONG_LIVED_TICK_ID", value: "tick-1" });
    const allowlist =
      env.find((entry) => entry.name === "PENUMBRA_MCP_TOOL_ALLOWLIST")?.value ?? "";
    const allowlistNames = new Set(allowlist.split(",").filter((name) => name.length > 0));
    expect(allowlistNames.has("long_lived_self_state_get")).toBe(true);
    expect(allowlistNames.has("memory_search")).toBe(true);
    expect(allowlistNames.has("ha:ha_pulse")).toBe(true);
    expect(allowlistNames.has("long_lived_self_state_get")).toBe(true);
    expect(allowlistNames.has("long_lived_self_state_set")).toBe(true);
    expect(allowlistNames.has("long_lived_self_pending_actions")).toBe(true);
    expect(captured?.mcpServers?.[1]?.env).toEqual([{ name: "GITHUB_TOKEN", value: "xyz" }]);
  });

  it("injects long-lived env through proxy-wrapped penumbra MCP servers", async () => {
    const handle = makeMockAcpHandle();
    const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
    startServer.mockResolvedValue(handle);

    const capturedRef = mutableRef<CapturedSessionParams | null>(null);
    const mockClientRequest = makeStandardClientRequest({
      onSessionNew: (params: unknown): void => {
        capturedRef.value = asCapturedSessionParams(params);
      },
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: "mock-acp",
        mcpServers: [
          {
            name: "penumbra",
            command: "bun",
            args: ["mcp-allowlist-proxy.ts"],
            env: [
              { name: "MCP_PROXY_UPSTREAM", value: "bun /tmp/penumbra-mcp.ts" },
              { name: "TOKEN", value: "abc123" },
            ],
          },
          {
            name: "ha",
            command: "bun",
            args: ["mcp-allowlist-proxy.ts"],
            env: [{ name: "MCP_PROXY_UPSTREAM", value: "bun /tmp/ha-mcp.ts" }],
          },
        ],
      },
      {
        startServer,
        createClient: (h: StdioAcpHandle): StdioAcpClient => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await dispatch(adapter, {
      prompt: "hi",
      conversation: { id: "c1", project_id: null },
      config: {},
      signal: new AbortController().signal,
      long_lived_session: {
        dispatch_kind: "long_lived_tick",
        agent_id: "agent-1",
        tick_id: "tick-1",
        mcp_tool_allowlist: ["penumbra:memory_search"],
      },
    });

    const captured = capturedRef.value;
    expect(captured?.mcpServers).toBeDefined();
    const penumbraEnv = captured?.mcpServers?.[0]?.env ?? [];
    expect(penumbraEnv).toContainEqual({ name: "TOKEN", value: "abc123" });
    expect(penumbraEnv).toContainEqual({ name: "PENUMBRA_MCP_ORIGIN", value: "fleet-worker" });
    expect(penumbraEnv).toContainEqual({ name: "PENUMBRA_LONG_LIVED_AGENT_ID", value: "agent-1" });
    expect(penumbraEnv).toContainEqual({ name: "PENUMBRA_LONG_LIVED_TICK_ID", value: "tick-1" });
    expect(captured?.mcpServers?.[1]?.env).toEqual([
      { name: "MCP_PROXY_UPSTREAM", value: "bun /tmp/ha-mcp.ts" },
    ]);
  });

  it("emits agent.heartbeat when subprocess is alive and no session/update for >=45s", async () => {
    vi.useFakeTimers();
    try {
      const events: DispatchEventInput[] = [];
      let resolvePrompt!: (value: { stopReason: string }) => void;
      const promptHang = new Promise<{ stopReason: string }>((resolve) => {
        resolvePrompt = resolve;
      });

      const handle = makeMockAcpHandle({
        exited: new Promise<number | null>(() => {
          /* never resolves */
        }),
      });
      const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
      startServer.mockResolvedValue(handle);

      const adapter = new StdioAcpAdapter(
        { binary: "mock-acp" },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            makeMockAcpClient({
              onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
              on: vi.fn<StdioAcpClient["on"]>(),
              request: makeStandardClientRequest({
                sessionId: "hb-session",
                onSessionPrompt: (): Promise<unknown> => promptHang,
              }),
            }),
        },
      );

      const dispatchPromise = dispatch(adapter, {
        prompt: "heartbeat test",
        signal: new AbortController().signal,
        eventContext: { handoffId: "h-hb", workerId: "w-hb" },
        onEvent: (e: DispatchEventInput): void => {
          events.push(e);
        },
      });

      // Flush microtasks to let initialize → session/new → session/prompt execute
      await flushMicrotasks();
      // Advance 60s — no session/update has arrived, server is alive
      vi.advanceTimersByTime(60_000);

      const heartbeats = events.filter((e) => e.kind === "agent.heartbeat");
      expect(heartbeats).toHaveLength(1);
      expect(heartbeats[0]).toMatchObject({
        handoff_id: "h-hb",
        meta: { adapter: "stdio-acp", session_id: "hb-session" },
      });
      expect(heartbeats[0]?.meta?.idle_ms).toBeGreaterThanOrEqual(45_000);

      resolvePrompt({ stopReason: "end_turn" });
      await dispatchPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses agent.heartbeat when subprocess has already exited", async () => {
    vi.useFakeTimers();
    try {
      const events: DispatchEventInput[] = [];
      let resolvePrompt!: (value: { stopReason: string }) => void;
      const promptHang = new Promise<{ stopReason: string }>((resolve) => {
        resolvePrompt = resolve;
      });

      const handle = makeMockAcpHandle({ exited: Promise.resolve<number | null>(1) });
      const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
      startServer.mockResolvedValue(handle);

      const adapter = new StdioAcpAdapter(
        { binary: "mock-acp" },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            makeMockAcpClient({
              onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
              on: vi.fn<StdioAcpClient["on"]>(),
              request: makeStandardClientRequest({
                sessionId: "hb-session-dead",
                onSessionPrompt: (): Promise<unknown> => promptHang,
              }),
            }),
        },
      );

      const dispatchPromise = dispatch(adapter, {
        prompt: "heartbeat test",
        signal: new AbortController().signal,
        eventContext: { handoffId: "h-hb-dead", workerId: "w-hb" },
        onEvent: (e: DispatchEventInput): void => {
          events.push(e);
        },
      });

      // Flush microtasks — serverAlive becomes false via exited.then() during flush
      await flushMicrotasks();
      vi.advanceTimersByTime(60_000);

      expect(events.filter((e) => e.kind === "agent.heartbeat")).toHaveLength(0);

      resolvePrompt({ stopReason: "end_turn" });
      await dispatchPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses agent.heartbeat when session/update arrived within 45s", async () => {
    vi.useFakeTimers();
    try {
      const events: DispatchEventInput[] = [];
      const updateHandlerRef = mutableRef<((params: unknown) => void) | null>(null);
      let resolvePrompt!: (value: { stopReason: string }) => void;
      const promptHang = new Promise<{ stopReason: string }>((resolve) => {
        resolvePrompt = resolve;
      });

      const handle = makeMockAcpHandle({
        exited: new Promise<number | null>(() => {
          /* never resolves */
        }),
      });
      const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
      startServer.mockResolvedValue(handle);

      const adapter = new StdioAcpAdapter(
        { binary: "mock-acp" },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            makeMockAcpClient({
              onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
              on: (method: string, handler: (params: unknown) => void): void => {
                if (method === "session/update") updateHandlerRef.value = handler;
              },
              request: makeStandardClientRequest({
                sessionId: "hb-session-active",
                onSessionPrompt: (): Promise<unknown> => promptHang,
              }),
            }),
        },
      );

      const dispatchPromise = dispatch(adapter, {
        prompt: "heartbeat test",
        signal: new AbortController().signal,
        eventContext: { handoffId: "h-hb-active", workerId: "w-hb" },
        onEvent: (e: DispatchEventInput): void => {
          events.push(e);
        },
      });

      await flushMicrotasks();

      // Simulate a session/update at 30s — refreshes lastSessionUpdateTs
      vi.advanceTimersByTime(30_000);
      updateHandlerRef.value?.({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "still working" },
        },
      });

      // Advance to 60s — interval fires but activity was only 30s ago (<45s threshold)
      vi.advanceTimersByTime(30_000);

      expect(events.filter((e) => e.kind === "agent.heartbeat")).toHaveLength(0);

      resolvePrompt({ stopReason: "end_turn" });
      await dispatchPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits no agent.heartbeat after session/end clears the timer", async () => {
    vi.useFakeTimers();
    try {
      const events: DispatchEventInput[] = [];

      const handle = makeMockAcpHandle({
        exited: new Promise<number | null>(() => {
          /* never resolves */
        }),
      });
      const startServer: AcpStartServerMock = vi.fn(startStdioAcpServerStub);
      startServer.mockResolvedValue(handle);

      const adapter = new StdioAcpAdapter(
        { binary: "mock-acp" },
        {
          startServer,
          createClient: (): StdioAcpClient =>
            makeMockAcpClient({
              onRequest: vi.fn<StdioAcpClient["onRequest"]>(),
              on: vi.fn<StdioAcpClient["on"]>(),
              request: makeStandardClientRequest({
                sessionId: "hb-session-end",
                onSessionPrompt: (): Promise<unknown> =>
                  new Promise<{ stopReason: string }>((resolve) => {
                    setTimeout(() => {
                      resolve({ stopReason: "end_turn" });
                    }, 5_000);
                  }),
              }),
            }),
        },
      );

      const dispatchPromise = dispatch(adapter, {
        prompt: "heartbeat test",
        signal: new AbortController().signal,
        eventContext: { handoffId: "h-hb-end", workerId: "w-hb" },
        onEvent: (e: DispatchEventInput): void => {
          events.push(e);
        },
      });

      await flushMicrotasks();
      vi.advanceTimersByTime(5_000); // session/prompt resolves via its setTimeout

      // Flush microtasks so the Promise.race settles and the finally block clears heartbeatTimer
      await flushMicrotasks();
      await dispatchPromise;

      // Advance well past one full heartbeat interval — timer was cleared, no heartbeats
      vi.advanceTimersByTime(120_000);

      expect(events.filter((e) => e.kind === "agent.heartbeat")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
