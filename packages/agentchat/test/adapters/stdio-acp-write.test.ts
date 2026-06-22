import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import type { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "../../src/adapters/stdio-acp-server.js";
import type { StdioAcpOptions } from "../../src/adapters/stdio-acp.js";
import type { WriteToolsExecutor } from "../../src/worker/write-tools-executor.js";

import { StdioAcpAdapter } from "../../src/adapters/stdio-acp.js";
import {
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalNotFoundError,
} from "../../src/worker/write-tools-errors.js";

type AcpRequestHandler = (params: unknown) => unknown;

interface MockExecutor {
  writeTextFile?: (args: unknown, ctx: unknown) => unknown;
  editTextFile?: (args: unknown, ctx: unknown) => unknown;
  terminalCreate?: (args: unknown, ctx: unknown) => unknown;
  terminalOutput?: (args: unknown, ctx?: unknown) => unknown;
  terminalWaitForExit?: (args: unknown) => unknown;
  terminalRelease?: (args: unknown) => unknown;
  terminalKill?: (args: unknown) => unknown;
}

// Single documented launder: WriteToolsExecutor is a nominal class with private
// state, so structurally-shaped test doubles need one `as unknown as` to be
// accepted by DispatchInput.executor.
function asExecutor(mock: MockExecutor): WriteToolsExecutor {
  return mock as unknown as WriteToolsExecutor;
}

interface MockClient {
  onRequest: (method: string, handler: AcpRequestHandler) => void;
  on: (method: string, handler: (params: unknown) => void) => void;
  request: (method: string, params?: unknown) => Promise<unknown>;
}

// Single documented launder: StdioAcpClient is a nominal class with private
// fields; structural mocks pass through here once.
function asAcpClient(client: MockClient): StdioAcpClient {
  return client as unknown as StdioAcpClient;
}

interface InitializeParams {
  clientCapabilities?: { fs?: { writeTextFile?: boolean }; terminal?: boolean };
}

interface Harness {
  runDispatch: () => Promise<void>;
  registeredMethods: string[];
  getInitializeParams: () => InitializeParams;
  getHandler: (method: string) => AcpRequestHandler | undefined;
}

function createHarness(
  options: Partial<StdioAcpOptions> = {},
  executor: MockExecutor = {},
): Harness {
  const registeredMethods: string[] = [];
  const handlers = new Map<string, AcpRequestHandler>();
  const initializeRef: { value: unknown } = { value: null };

  const startServer = (): Promise<StdioAcpHandle> =>
    Promise.resolve({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: (): void => undefined,
      exited: Promise.resolve(0),
      getStderrTail: (): string => "",
    });

  const client: MockClient = {
    onRequest: (method, handler): void => {
      registeredMethods.push(method);
      handlers.set(method, handler);
    },
    on: (): void => undefined,
    request: (method, params): Promise<unknown> => {
      if (method === "initialize") {
        initializeRef.value = params;
        return Promise.resolve({ protocolVersion: 1 });
      }
      if (method === "session/new") return Promise.resolve({ sessionId: "session-123" });
      if (method === "session/prompt") return Promise.resolve({ stopReason: "end_turn" });
      return Promise.resolve({});
    },
  };

  const adapter = new StdioAcpAdapter(
    { binary: "mock-acp", cwd: "/tmp", ...options },
    {
      startServer,
      createClient: (): StdioAcpClient => asAcpClient(client),
    },
  );

  return {
    runDispatch: async (): Promise<void> => {
      await adapter.dispatch({
        prompt: "hello",
        signal: new AbortController().signal,
        conversation: { id: "conv-1", project_id: null },
        config: {},
        handoff_id: "handoff-1",
        executor: asExecutor(executor),
      });
    },
    registeredMethods,
    getInitializeParams: (): InitializeParams => {
      const value = initializeRef.value;
      if (value === null || typeof value !== "object") return {};
      return value;
    },
    getHandler: (method): AcpRequestHandler | undefined => handlers.get(method),
  };
}

async function captureError(promise: unknown): Promise<{ value: unknown; error: Error | null }> {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function errorCode(error: Error | null): number | undefined {
  if (error === null) return undefined;
  const code = (error as unknown as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}

describe("StdioAcpAdapter write-tool ACP handlers", () => {
  test("fsWriteTextFile=true registers fs/write_text_file", async () => {
    const harness = createHarness({ fsWriteTextFile: true });

    await harness.runDispatch();

    expect(harness.registeredMethods).toContain("fs/write_text_file");
  });

  test("fsWriteTextFile=true advertises clientCapabilities.fs.writeTextFile", async () => {
    const harness = createHarness({ fsWriteTextFile: true });

    await harness.runDispatch();

    expect(harness.getInitializeParams().clientCapabilities?.fs).toEqual({ writeTextFile: true });
  });

  test("fs/write_text_file invokes executor.writeTextFile and returns empty response", async () => {
    interface RecordedCall {
      args: unknown;
      ctx: unknown;
    }
    const calls: RecordedCall[] = [];
    const harness = createHarness(
      { fsWriteTextFile: true },
      {
        writeTextFile: (args, ctx): Promise<unknown> => {
          calls.push({ args, ctx });
          return Promise.resolve({ bytesWritten: 5, sha256: "abc" });
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("fs/write_text_file");
    expect(handler).toBeDefined();

    const result = await handler?.({ path: "/tmp/file.txt", content: "hello" });

    expect(result).toEqual({});
    expect(calls).toEqual([
      {
        args: { path: "/tmp/file.txt", content: "hello" },
        ctx: {
          toolName: "fs.write_text_file",
          rawInput: { path: "/tmp/file.txt", content_bytes: 5 },
          dispatchId: "handoff-1",
        },
      },
    ]);
  });

  test("fs/write_text_file maps OperationRejectedError to -32004", async () => {
    const harness = createHarness(
      { fsWriteTextFile: true },
      {
        writeTextFile: (): never => {
          throw new OperationRejectedError("denied");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("fs/write_text_file");
    const { error } = await captureError(handler?.({ path: "/tmp/file.txt", content: "hello" }));

    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe(-32004);
    expect(error?.message).toBe("denied");
  });

  test("fs/write_text_file maps OutsideWorktreeError to -32001", async () => {
    const harness = createHarness(
      { fsWriteTextFile: true },
      {
        writeTextFile: (): never => {
          throw new OutsideWorktreeError("outside");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("fs/write_text_file");
    const { error } = await captureError(handler?.({ path: "/tmp/file.txt", content: "hello" }));

    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe(-32001);
    expect(error?.message).toBe("outside");
  });

  test("terminal=true registers all terminal/* handlers", async () => {
    const harness = createHarness({ terminal: true });

    await harness.runDispatch();

    for (const method of [
      "terminal/create",
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/release",
      "terminal/kill",
    ]) {
      expect(harness.registeredMethods).toContain(method);
    }
  });

  test("terminal=true advertises clientCapabilities.terminal", async () => {
    const harness = createHarness({ terminal: true });

    await harness.runDispatch();

    expect(harness.getInitializeParams().clientCapabilities?.terminal).toBe(true);
  });

  test("terminal/create returns terminal_id from executor", async () => {
    interface RecordedCall {
      args: unknown;
      ctx: unknown;
    }
    const calls: RecordedCall[] = [];
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (args, ctx): Promise<unknown> => {
          calls.push({ args, ctx });
          return Promise.resolve({ terminal_id: "term-123" });
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/create");
    const result = await handler?.({
      command: "echo hello",
      args: ["echo", "hello"],
      cwd: "/tmp",
      output_byte_limit: 1234,
    });

    expect(result).toEqual({ terminal_id: "term-123" });
    expect(calls).toEqual([
      {
        args: {
          command: "echo hello",
          argv: ["echo", "hello"],
          cwd: "/tmp",
          output_byte_limit: 1234,
        },
        ctx: {
          toolName: "terminal.create",
          rawInput: { argv: ["echo", "hello"], cmd: "echo hello", cwd: "/tmp" },
          dispatchId: "handoff-1",
        },
      },
    ]);
  });

  test("terminal/output returns the executor output snapshot", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: (): Promise<unknown> =>
          Promise.resolve({
            output: "hello\n",
            truncated: false,
            exit_status: { exitCode: 0, signal: null },
          }),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/output");
    const result = await handler?.({ terminal_id: "term-123" });

    expect(result).toEqual({
      output: "hello\n",
      truncated: false,
      exit_status: { exitCode: 0, signal: null },
    });
  });

  test("terminal/kill maps TerminalNotFoundError to -32005", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalKill: (): never => {
          throw new TerminalNotFoundError("term-404");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/kill");
    const { error } = await captureError(handler?.({ terminal_id: "term-404" }));

    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe(-32005);
    expect(error?.message).toBe("terminal not found: term-404");
  });
});
