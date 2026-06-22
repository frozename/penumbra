import type { Logger } from "@penumbra/core";

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import type { StdioAcpHandle } from "../../src/adapters/stdio-acp-server.js";
import type { DispatchInput, PermissionDecision } from "../../src/sdk/adapter.js";

import { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "../../src/worker/sandbox-config.js";
import { WriteToolsExecutor } from "../../src/worker/write-tools-executor.js";

interface CapturedEvent {
  type: string;
  payload: unknown;
}

interface HarnessOptions {
  fsWriteTextFile?: boolean;
  terminal?: boolean;
  permissionDecision?: PermissionDecision;
  sandboxConfigOverrides?: Partial<SandboxConfig>;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponseEnvelope<T = unknown> {
  jsonrpc?: string;
  id?: number | string;
  result?: T;
  error?: JsonRpcError;
}

interface JsonRpcWireMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface TerminalCreateResult {
  terminal_id: string;
}

interface TerminalExitStatus {
  exitCode: number;
  signal: string | null;
}

interface TerminalWaitResult {
  exit_status: TerminalExitStatus;
}

interface TerminalOutputResult {
  output: string;
  truncated: boolean;
  exit_status?: TerminalExitStatus;
}

interface MockAcpServer {
  sendRequest: <T = unknown>(
    method: string,
    params?: unknown,
  ) => Promise<JsonRpcResponseEnvelope<T>>;
  initializeParams: unknown;
  sessionParams: unknown;
  promptParams: unknown;
}

type PromptHandler = (server: MockAcpServer, params: unknown) => Promise<unknown>;

interface IntegrationHarness {
  adapter: StdioAcpAdapter;
  executor: WriteToolsExecutor;
  worktreeRoot: string;
  events: CapturedEvent[];
  server: MockAcpServer;
  setPromptHandler: (handler: PromptHandler) => void;
  runDispatch: () => Promise<void>;
  cleanup: () => Promise<void>;
}

const silentLog = (): void => {
  /* test logger no-op */
};

const testLogger: Pick<Logger, "warn" | "info" | "debug" | "error"> = {
  warn: silentLog,
  info: silentLog,
  debug: silentLog,
  error: silentLog,
};

function requireResult<T>(envelope: JsonRpcResponseEnvelope<T>): T {
  if (envelope.result === undefined) {
    const detail = envelope.error ? envelope.error.message : "<none>";
    throw new Error(`expected JSON-RPC result, got error: ${detail}`);
  }
  return envelope.result;
}

function payloadHasReason(payload: unknown, reason: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const value = (payload as { reason?: unknown }).reason;
  return value === reason;
}

interface ServerSideHandlers {
  onInitialize: (params: unknown) => void;
  onSessionNew: (params: unknown) => void;
  onSessionPrompt: (params: unknown) => Promise<unknown>;
}

async function handleSessionPrompt(
  message: JsonRpcWireMessage & { id: number | string },
  handler: (params: unknown) => Promise<unknown>,
  sendLine: (msg: unknown) => void,
): Promise<void> {
  try {
    const result = await handler(message.params);
    sendLine({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const maybeCode = (err as Error & { code?: number }).code;
    const code = typeof maybeCode === "number" ? maybeCode : -32000;
    sendLine({
      jsonrpc: "2.0",
      id: message.id,
      error: { code, message: err.message },
    });
  }
}

async function handleRequestFrame(
  message: JsonRpcWireMessage & { method: string; id: number | string },
  handlers: ServerSideHandlers,
  sendLine: (msg: unknown) => void,
): Promise<void> {
  if (message.method === "initialize") {
    handlers.onInitialize(message.params);
    sendLine({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } });
    return;
  }
  if (message.method === "authenticate") {
    sendLine({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/new") {
    handlers.onSessionNew(message.params);
    sendLine({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-123" } });
    return;
  }
  if (message.method === "session/prompt") {
    await handleSessionPrompt(message, handlers.onSessionPrompt, sendLine);
    return;
  }
  sendLine({ jsonrpc: "2.0", id: message.id, result: {} });
}

function isRequestFrame(
  msg: JsonRpcWireMessage,
): msg is JsonRpcWireMessage & { method: string; id: number | string } {
  return typeof msg.method === "string" && msg.id !== undefined;
}

async function createIntegrationHarness(opts: HarnessOptions = {}): Promise<IntegrationHarness> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "phase1d-acp-"));
  const events: CapturedEvent[] = [];
  const serverToAdapter = new PassThrough();
  const adapterToServer = new PassThrough();
  const pendingRequests = new Map<number, (response: JsonRpcResponseEnvelope) => void>();
  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: (): Promise<PermissionDecision> =>
      Promise.resolve(opts.permissionDecision ?? "approve"),
    auditEmitter: {
      emit: (type, payload): Promise<void> => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG, ...(opts.sandboxConfigOverrides ?? {}) },
    logger: testLogger,
    handoffId: "h-int",
    dispatchId: "d-int",
  });

  let nextRequestId = 1;
  let initializeParams: unknown = null;
  let sessionParams: unknown = null;
  let promptParams: unknown = null;
  let promptHandler: PromptHandler | null = null;

  const sendLine = (message: unknown): void => {
    serverToAdapter.write(`${JSON.stringify(message)}\n`);
  };

  const server: MockAcpServer = {
    sendRequest<T = unknown>(
      method: string,
      params?: unknown,
    ): Promise<JsonRpcResponseEnvelope<T>> {
      const id = nextRequestId++;
      const responsePromise = new Promise<JsonRpcResponseEnvelope>((resolve) => {
        pendingRequests.set(id, resolve);
      });
      sendLine({ jsonrpc: "2.0", method, params, id });
      return responsePromise as Promise<JsonRpcResponseEnvelope<T>>;
    },
    initializeParams,
    sessionParams,
    promptParams,
  };

  const handlers: ServerSideHandlers = {
    onInitialize: (params): void => {
      initializeParams = params;
      server.initializeParams = initializeParams;
    },
    onSessionNew: (params): void => {
      sessionParams = params;
      server.sessionParams = sessionParams;
    },
    onSessionPrompt: async (params): Promise<unknown> => {
      promptParams = params;
      server.promptParams = promptParams;
      if (promptHandler) {
        return await promptHandler(server, params);
      }
      return { stopReason: "end_turn" };
    },
  };

  const stdinReader = createInterface({ input: adapterToServer, terminal: false });
  stdinReader.on("line", (line) => {
    void (async (): Promise<void> => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as JsonRpcWireMessage;

      if (isRequestFrame(message)) {
        await handleRequestFrame(message, handlers, sendLine);
        return;
      }

      if (message.id !== undefined) {
        const pending = pendingRequests.get(Number(message.id));
        if (pending) {
          pendingRequests.delete(Number(message.id));
          pending(message);
        }
      }
    })().catch(() => undefined);
  });

  const adapter = new StdioAcpAdapter(
    {
      binary: "mock-acp",
      cwd: worktreeRoot,
      fsWriteTextFile: !!opts.fsWriteTextFile,
      terminal: !!opts.terminal,
    },
    {
      startServer: (): Promise<StdioAcpHandle> =>
        Promise.resolve({
          stdin: adapterToServer,
          stdout: serverToAdapter,
          kill: (): void => {
            serverToAdapter.destroy();
            adapterToServer.destroy();
            stdinReader.close();
          },
          getStderrTail: (): string => "",
          exited: Promise.resolve(0),
        }),
      createClient: (handle): StdioAcpClient =>
        new StdioAcpClient({
          stdin: handle.stdin,
          stdout: handle.stdout,
        }),
    },
  );

  const dispatchInput: DispatchInput = {
    prompt: "hello",
    signal: new AbortController().signal,
    conversation: { id: "conv-1", project_id: null },
    config: {},
    handoff_id: "h-int",
    executor,
  };

  return {
    adapter,
    executor,
    worktreeRoot,
    events,
    server,
    setPromptHandler: (handler: PromptHandler): void => {
      promptHandler = handler;
    },
    runDispatch: async (): Promise<void> => {
      await adapter.dispatch(dispatchInput);
    },
    cleanup: async (): Promise<void> => {
      await executor.dispose();
      stdinReader.close();
      serverToAdapter.destroy();
      adapterToServer.destroy();
      await rm(worktreeRoot, { recursive: true, force: true });
    },
  };
}

describe("ACP write-tools integration", () => {
  test("fsWriteTextFile advertises clientCapabilities.fs.writeTextFile during initialize", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(() => Promise.resolve({ stopReason: "end_turn" }));
      await harness.runDispatch();

      expect(harness.server.initializeParams).toMatchObject({
        clientCapabilities: { fs: { writeTextFile: true } },
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file correctly extracts text from content block objects", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "notes-obj.txt",
          content: { type: "text", text: "hello world" },
        });
        expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
      const content = await readFile(join(harness.worktreeRoot, "notes-obj.txt"), "utf8");
      expect(content).toBe("hello world");
      expect(content).not.toContain("[object Object]");
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file correctly extracts text from content block arrays", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "notes-arr.txt",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        });
        expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
      const content = await readFile(join(harness.worktreeRoot, "notes-arr.txt"), "utf8");
      expect(content).toBe("ab");
      expect(content).not.toContain("[object Object]");
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file rejects bare objects without text", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "notes-bad-obj.txt",
          content: { foo: 1 },
        });
        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain("invalid content type: object");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
      let exists = true;
      try {
        await readFile(join(harness.worktreeRoot, "notes-bad-obj.txt"), "utf8");
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          exists = false;
        }
      }
      expect(exists).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file rejects primitives (null, number)", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "notes-prim.txt",
          content: null,
        });
        expect(response.error).toBeDefined();
        expect(response.error?.message).toContain("invalid content type: object");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file round-trip writes the file and returns an empty JSON-RPC result", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "notes.txt",
          content: "hello world",
        });
        expect(response).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();

      expect(harness.server.initializeParams).toMatchObject({
        clientCapabilities: { fs: { writeTextFile: true } },
      });
      expect(await readFile(join(harness.worktreeRoot, "notes.txt"), "utf8")).toBe("hello world");
      const writeEvent = harness.events.find((entry) => entry.type === "fs.write_applied");
      expect(writeEvent).toBeDefined();
      expect(writeEvent?.payload).toMatchObject({
        path: "notes.txt",
        bytes: 11,
        sha256: createHash("sha256").update("hello world").digest("hex"),
        prev_sha256: null,
        handoff_id: "h-int",
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file emits fs.write_applied with path, bytes, and sha256", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        await server.sendRequest("fs/write_text_file", {
          path: "audit.txt",
          content: "abc123",
        });
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();

      const event = harness.events.find((entry) => entry.type === "fs.write_applied");
      expect(event).toBeDefined();
      expect(event?.payload).toMatchObject({
        path: "audit.txt",
        bytes: 6,
        sha256: createHash("sha256").update("abc123").digest("hex"),
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file outside-worktree path maps to JSON-RPC code -32001", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "/etc/passwd",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32001);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file permission rejection maps to JSON-RPC code -32004", async () => {
    const harness = await createIntegrationHarness({
      fsWriteTextFile: true,
      permissionDecision: "reject",
    });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "denied.txt",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32004);
        expect(response.error?.message).toContain("permission denied");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal advertises clientCapabilities.terminal during initialize", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(() => Promise.resolve({ stopReason: "end_turn" }));
      await harness.runDispatch();

      expect(harness.server.initializeParams).toMatchObject({
        clientCapabilities: { terminal: true },
      });
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with command 'echo hi' can be waited on and returns output 'hi'", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          command: "echo hi",
        });
        expect(created.error).toBeUndefined();
        const { terminal_id: terminalId } = requireResult(created);

        const waited = await server.sendRequest<TerminalWaitResult>("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        expect(waited.error).toBeUndefined();
        expect(requireResult(waited).exit_status.exitCode).toBe(0);

        const output = await server.sendRequest<TerminalOutputResult>("terminal/output", {
          terminal_id: terminalId,
        });
        expect(output.error).toBeUndefined();
        expect(requireResult(output).output.trim()).toBe("hi");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/output round-trip returns the captured output snapshot", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          command: "echo output",
        });
        const { terminal_id: terminalId } = requireResult(created);
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest<TerminalOutputResult>("terminal/output", {
          terminal_id: terminalId,
        });
        expect(requireResult(output).output.trim()).toBe("output");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/release cleans up a running terminal and removes it from the registry", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          command: "sleep 5",
        });
        const { terminal_id: terminalId } = requireResult(created);

        const released = await server.sendRequest("terminal/release", {
          terminal_id: terminalId,
        });
        expect(released.result).toEqual({});

        const output = await server.sendRequest("terminal/output", {
          terminal_id: terminalId,
        });
        expect(output.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with args ['echo', 'X'] uses argv form and prints X", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          args: ["echo", "X"],
        });
        const { terminal_id: terminalId } = requireResult(created);
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest<TerminalOutputResult>("terminal/output", {
          terminal_id: terminalId,
        });
        expect(requireResult(output).output.trim()).toBe("X");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with command 'echo Y' uses shell command form and prints Y", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          command: "echo Y",
        });
        const { terminal_id: terminalId } = requireResult(created);
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest<TerminalOutputResult>("terminal/output", {
          terminal_id: terminalId,
        });
        expect(requireResult(output).output.trim()).toBe("Y");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create prefers argv over command when both are provided", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          args: ["echo", "preferred"],
          command: "echo ignored",
        });
        const { terminal_id: terminalId } = requireResult(created);
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest<TerminalOutputResult>("terminal/output", {
          terminal_id: terminalId,
        });
        expect(requireResult(output).output.trim()).toBe("preferred");
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal create cap rejects the 4th concurrent create when maxConcurrent is 3", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        for (let i = 0; i < 3; i += 1) {
          const created = await server.sendRequest("terminal/create", {
            args: ["sleep", "5"],
          });
          expect(created.error).toBeUndefined();
        }

        const capped = await server.sendRequest("terminal/create", {
          args: ["echo", "blocked"],
        });
        expect(capped.error?.code).toBe(-32006);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/kill on a running terminal emits terminal.killed with reason=operator", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          args: ["sleep", "10"],
        });
        const { terminal_id: terminalId } = requireResult(created);

        const killed = await server.sendRequest("terminal/kill", {
          terminal_id: terminalId,
        });
        expect(killed.result).toEqual({});

        expect(
          harness.events.some(
            (entry) =>
              entry.type === "terminal.killed" && payloadHasReason(entry.payload, "operator"),
          ),
        ).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/wait_for_exit after kill returns a terminating signal", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          args: ["sleep", "10"],
        });
        const { terminal_id: terminalId } = requireResult(created);

        await server.sendRequest("terminal/kill", {
          terminal_id: terminalId,
        });
        const waited = await server.sendRequest<TerminalWaitResult>("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });

        const signal = requireResult(waited).exit_status.signal;
        expect(signal === "SIGTERM" || signal === "SIGKILL").toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/kill on an unknown id maps to JSON-RPC code -32005", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/kill", {
          terminal_id: "missing",
        });
        expect(response.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/output on an unknown id maps to JSON-RPC code -32005", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/output", {
          terminal_id: "missing",
        });
        expect(response.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/wait_for_exit on an unknown id maps to JSON-RPC code -32005", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: "missing",
        });
        expect(response.error?.code).toBe(-32005);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/release on an unknown id is a no-op and returns an empty JSON-RPC result", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/release", {
          terminal_id: "missing",
        });
        expect(response.result).toEqual({});
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file to a directory path maps to JSON-RPC code -32002", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      await mkdir(join(harness.worktreeRoot, "adir"), { recursive: true });
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "adir",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32002);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("fs/write_text_file to a read-only parent path maps to JSON-RPC code -32003", async () => {
    const harness = await createIntegrationHarness({ fsWriteTextFile: true });
    try {
      const readonlyDir = join(harness.worktreeRoot, "readonly");
      await mkdir(readonlyDir, { recursive: true });
      await chmod(readonlyDir, 0o555);

      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("fs/write_text_file", {
          path: "readonly/file.txt",
          content: "blocked",
        });
        expect(response.error?.code).toBe(-32003);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create truncates output when output_byte_limit is small", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          command: "yes",
          output_byte_limit: 4096,
        });
        const { terminal_id: terminalId } = requireResult(created);
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });
        const output = await server.sendRequest<TerminalOutputResult>("terminal/output", {
          terminal_id: terminalId,
        });
        expect(requireResult(output).truncated).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("sandbox timeout kills a terminal with reason=timeout", async () => {
    const harness = await createIntegrationHarness({
      terminal: true,
      sandboxConfigOverrides: {
        timeoutMs: 200,
      },
    });
    try {
      harness.setPromptHandler(async (server) => {
        const created = await server.sendRequest<TerminalCreateResult>("terminal/create", {
          args: ["sleep", "5"],
        });
        const { terminal_id: terminalId } = requireResult(created);
        await server.sendRequest("terminal/wait_for_exit", {
          terminal_id: terminalId,
        });

        expect(
          harness.events.some(
            (entry) =>
              entry.type === "terminal.killed" && payloadHasReason(entry.payload, "timeout"),
          ),
        ).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("executor.dispose during a running terminal emits terminal.killed with reason=dispatch_end", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        await server.sendRequest("terminal/create", {
          args: ["sleep", "10"],
        });

        await harness.executor.dispose();
        expect(
          harness.events.some(
            (entry) =>
              entry.type === "terminal.killed" && payloadHasReason(entry.payload, "dispatch_end"),
          ),
        ).toBe(true);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });

  test("terminal/create with cwd outside the worktree fails before spawn with JSON-RPC code -32001", async () => {
    const harness = await createIntegrationHarness({ terminal: true });
    try {
      harness.setPromptHandler(async (server) => {
        const response = await server.sendRequest("terminal/create", {
          args: ["echo", "x"],
          cwd: "/etc",
        });
        expect(response.error?.code).toBe(-32001);
        return { stopReason: "end_turn" };
      });

      await harness.runDispatch();
    } finally {
      await harness.cleanup();
    }
  });
});
