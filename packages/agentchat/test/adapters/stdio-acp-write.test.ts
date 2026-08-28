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

    expect(result).toMatchObject({ terminal_id: "term-123" });
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

  test("terminal/create's response carries both terminal_id and terminalId", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (): Promise<unknown> => Promise.resolve({ terminal_id: "term-123" }),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/create");
    const result = await handler?.({ command: "echo hello" });

    expect(result).toEqual({ terminal_id: "term-123", terminalId: "term-123" });
  });

  test("terminal/create preserves a pre-existing terminalId while adding no alias when terminal_id is absent", async () => {
    const results = [
      { terminal_id: "snake-term", terminalId: "camel-term" },
      { terminalId: "only-camel" },
    ];
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (): Promise<unknown> => Promise.resolve(results.shift()),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/create");
    const withSnake = await handler?.({ command: "echo hello" });
    const withoutSnake = await handler?.({ command: "echo hello" });

    expect(withSnake).toEqual({ terminal_id: "snake-term", terminalId: "camel-term" });
    expect(withoutSnake).toEqual({ terminalId: "only-camel" });
  });

  test("terminal/create reads params.outputByteLimit when output_byte_limit is absent", async () => {
    const calls: unknown[] = [];
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (args): Promise<unknown> => {
          calls.push(args);
          return Promise.resolve({ terminal_id: "term-123" });
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/create");
    await handler?.({ command: "echo hello", outputByteLimit: 4321 });

    expect(calls).toEqual([
      {
        command: "echo hello",
        argv: undefined,
        cwd: undefined,
        output_byte_limit: 4321,
      },
    ]);
  });

  test("terminal/create prefers output_byte_limit over outputByteLimit when both casings are present", async () => {
    const calls: unknown[] = [];
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (args): Promise<unknown> => {
          calls.push(args);
          return Promise.resolve({ terminal_id: "term-123" });
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/create");
    await handler?.({ command: "echo hello", output_byte_limit: 1234, outputByteLimit: 4321 });

    expect(calls).toEqual([
      {
        command: "echo hello",
        argv: undefined,
        cwd: undefined,
        output_byte_limit: 1234,
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

    expect(result).toMatchObject({
      output: "hello\n",
      truncated: false,
      exit_status: { exitCode: 0, signal: null },
    });
  });

  test("terminal/wait_for_exit and terminal/output resolve a terminal created with a camelCase terminalId", async () => {
    const calls: unknown[] = [];
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: (args): Promise<unknown> => {
          calls.push(args);
          if ((args as { terminal_id?: string }).terminal_id !== "term-123") {
            throw new TerminalNotFoundError(String((args as { terminal_id?: string }).terminal_id));
          }
          return Promise.resolve({ output: "hello\n", truncated: false });
        },
        terminalWaitForExit: (args): Promise<unknown> => {
          calls.push(args);
          if ((args as { terminal_id?: string }).terminal_id !== "term-123") {
            throw new TerminalNotFoundError(String((args as { terminal_id?: string }).terminal_id));
          }
          return Promise.resolve({ exit_status: { exitCode: 0, signal: null } });
        },
      },
    );

    await harness.runDispatch();
    const outputHandler = harness.getHandler("terminal/output");
    const waitHandler = harness.getHandler("terminal/wait_for_exit");
    const outputResult = await outputHandler?.({ terminalId: "term-123" });
    const waitResult = await waitHandler?.({ terminalId: "term-123" });

    expect(outputResult).toEqual({ output: "hello\n", truncated: false });
    expect(waitResult).toMatchObject({ exit_status: { exitCode: 0, signal: null } });
    expect(calls).toEqual([{ terminal_id: "term-123" }, { terminal_id: "term-123" }]);
  });

  test("terminal/wait_for_exit prefers terminal_id over terminalId when both casings are present", async () => {
    const calls: unknown[] = [];
    const harness = createHarness(
      { terminal: true },
      {
        terminalWaitForExit: (args): Promise<unknown> => {
          calls.push(args);
          return Promise.resolve({ exit_status: { exitCode: 0, signal: null } });
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/wait_for_exit");
    await handler?.({ terminal_id: "snake-term", terminalId: "camel-term" });

    expect(calls).toEqual([{ terminal_id: "snake-term" }]);
  });

  test("terminal/wait_for_exit's response carries both exit_status and exitStatus", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalWaitForExit: (): Promise<unknown> =>
          Promise.resolve({ exit_status: { exitCode: 0, signal: null } }),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/wait_for_exit");
    const result = await handler?.({ terminal_id: "term-123" });

    expect(result).toEqual({
      exit_status: { exitCode: 0, signal: null },
      exitStatus: { exitCode: 0, signal: null },
    });
  });

  test("terminal/wait_for_exit preserves a pre-existing exitStatus while adding no alias when exit_status is absent", async () => {
    const results = [
      {
        exit_status: { exitCode: 0, signal: null },
        exitStatus: { exitCode: 99, signal: "SIGTERM" },
      },
      { exitStatus: { exitCode: 7, signal: null } },
    ];
    const harness = createHarness(
      { terminal: true },
      {
        terminalWaitForExit: (): Promise<unknown> => Promise.resolve(results.shift()),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/wait_for_exit");
    const withSnake = await handler?.({ terminal_id: "term-123" });
    const withoutSnake = await handler?.({ terminal_id: "term-123" });

    expect(withSnake).toEqual({
      exit_status: { exitCode: 0, signal: null },
      exitStatus: { exitCode: 99, signal: "SIGTERM" },
    });
    expect(withoutSnake).toEqual({ exitStatus: { exitCode: 7, signal: null } });
  });

  test("terminal/output's response carries exitStatus when exit_status is present, and omits it when absent", async () => {
    const outputs = [
      { output: "hello\n", truncated: false, exit_status: { exitCode: 0, signal: null } },
      { output: "still running\n", truncated: false },
    ];
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: (): Promise<unknown> => Promise.resolve(outputs.shift()),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/output");
    const exited = await handler?.({ terminal_id: "term-123" });
    const running = await handler?.({ terminal_id: "term-123" });

    expect(exited).toEqual({
      output: "hello\n",
      truncated: false,
      exit_status: { exitCode: 0, signal: null },
      exitStatus: { exitCode: 0, signal: null },
    });
    expect(running).toEqual({ output: "still running\n", truncated: false });
    expect(running).not.toHaveProperty("exitStatus");
  });

  test("terminal handlers uniformly apply terminalId and exitStatus aliases", async () => {
    const aliasedResult = {
      terminal_id: "term-123",
      exit_status: { exitCode: 0, signal: null },
    };
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (): Promise<unknown> => Promise.resolve(aliasedResult),
        terminalOutput: (): Promise<unknown> => Promise.resolve(aliasedResult),
        terminalWaitForExit: (): Promise<unknown> => Promise.resolve(aliasedResult),
        terminalRelease: (): Promise<unknown> => Promise.resolve(aliasedResult),
        terminalKill: (): Promise<unknown> => Promise.resolve(aliasedResult),
      },
    );

    await harness.runDispatch();

    expect(await harness.getHandler("terminal/create")?.({ command: "echo hello" })).toEqual({
      ...aliasedResult,
      terminalId: "term-123",
      exitStatus: { exitCode: 0, signal: null },
    });
    for (const method of [
      "terminal/output",
      "terminal/wait_for_exit",
      "terminal/release",
      "terminal/kill",
    ]) {
      expect(await harness.getHandler(method)?.({ terminal_id: "term-123" })).toEqual({
        ...aliasedResult,
        terminalId: "term-123",
        exitStatus: { exitCode: 0, signal: null },
      });
    }
  });

  test("a terminalId valid under session A does not resolve under session B", async () => {
    const terminals = new Map<string, "session-a" | "session-b">();
    const scopedExecutor = (owner: "session-a" | "session-b"): MockExecutor => ({
      terminalCreate: (): Promise<unknown> => {
        terminals.set("term-123", owner);
        return Promise.resolve({ terminal_id: "term-123" });
      },
      terminalWaitForExit: (args): Promise<unknown> => {
        const terminalId = (args as { terminal_id?: string }).terminal_id;
        if (terminalId === undefined || terminals.get(terminalId) !== owner) {
          throw new TerminalNotFoundError(String(terminalId));
        }
        return Promise.resolve({ exit_status: { exitCode: 0, signal: null } });
      },
    });
    const harnessA = createHarness({ terminal: true }, scopedExecutor("session-a"));
    const harnessB = createHarness({ terminal: true }, scopedExecutor("session-b"));

    await harnessA.runDispatch();
    await harnessB.runDispatch();
    const createHandlerA = harnessA.getHandler("terminal/create");
    const handlerA = harnessA.getHandler("terminal/wait_for_exit");
    const handlerB = harnessB.getHandler("terminal/wait_for_exit");

    await expect(createHandlerA?.({ command: "echo hello" })).resolves.toMatchObject({
      terminal_id: "term-123",
    });
    await expect(handlerA?.({ terminalId: "term-123" })).resolves.toMatchObject({
      exit_status: { exitCode: 0, signal: null },
    });
    const { error } = await captureError(handlerB?.({ terminalId: "term-123" }));

    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe(-32005);
    expect(error?.message).toBe("terminal not found: term-123");
  });

  test("terminal/output rejects clearly when neither terminal id casing is supplied", async () => {
    let called = false;
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: (): Promise<unknown> => {
          called = true;
          throw new TerminalNotFoundError("");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/output");
    const { error } = await captureError(handler?.({}));

    expect(called).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("terminal/output: missing terminal_id or terminalId");
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
