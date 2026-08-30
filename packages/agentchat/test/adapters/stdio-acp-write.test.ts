import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";
import type { StdioAcpHandle } from "@src/adapters/stdio-acp-server.js";
import type { StdioAcpOptions } from "@src/adapters/stdio-acp.js";
import { redactTerminalErrorMessage, StdioAcpAdapter } from "@src/adapters/stdio-acp.js";
import type { DispatchInput } from "@src/sdk/adapter.js";
import {
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalNotFoundError,
} from "@src/worker/write-tools-errors.js";
import type { WriteToolsExecutor } from "@src/worker/write-tools-executor.js";

type AcpRequestHandler = (params: unknown) => unknown;

interface MockExecutor {
  writeTextFile?: (args: unknown, ctx: unknown) => unknown;
  editTextFile?: (args: unknown, ctx: unknown) => unknown;
  terminalCreate?: (args: unknown, ctx: unknown) => unknown;
  terminalOutput?: (args: unknown, ctx?: unknown) => unknown;
  terminalWaitForExit?: (args: unknown) => unknown;
  terminalRelease?: (args: unknown) => unknown;
  terminalKill?: (args: unknown) => unknown;
  auditTerminalFailure?: (payload: unknown) => unknown;
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
  events: DispatchEventInput[];
  auditEvents: { type: string; payload: unknown }[];
  getInitializeParams: () => InitializeParams;
  getHandler: (method: string) => AcpRequestHandler | undefined;
}

function createHarness(
  options: Partial<StdioAcpOptions> = {},
  executor: MockExecutor = {},
  dispatchOverrides: Partial<Pick<DispatchInput, "trust_mode" | "onEvent">> = {},
): Harness {
  const registeredMethods: string[] = [];
  const events: DispatchEventInput[] = [];
  const auditEvents: { type: string; payload: unknown }[] = [];
  const handlers = new Map<string, AcpRequestHandler>();
  const initializeRef: { value: unknown } = { value: null };
  const executorWithAudit: MockExecutor = {
    auditTerminalFailure: (payload): Promise<void> => {
      auditEvents.push({ type: "terminal.failed", payload });
      return Promise.resolve();
    },
    ...executor,
  };

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
        eventContext: { handoffId: "handoff-1", workerId: "worker-1" },
        onEvent: (event): void => {
          events.push(event);
        },
        executor: asExecutor(executorWithAudit),
        ...dispatchOverrides,
      });
    },
    registeredMethods,
    events,
    auditEvents,
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

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10));
}

function errorCode(error: Error | null): number | undefined {
  if (error === null) return undefined;
  const code = (error as unknown as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}

describe("StdioAcpAdapter write-tool ACP handlers", () => {
  test("redactTerminalErrorMessage emits bounded deterministic text for odd input", () => {
    const redacted = redactTerminalErrorMessage(
      `spawn curl --header "Authorization: Bearer sk-FAKE-SECRET-DO-NOT-LOG-12345" failed`,
      -32000,
    );

    expect(redacted).toBe("terminal error redacted (code=-32000, messageLength=82)");
    expect(redactTerminalErrorMessage(undefined, -32000)).toBe(
      "terminal error redacted (code=-32000, messageLength=0)",
    );
    expect(redactTerminalErrorMessage("comando falhou: açao negada", -32000)).toBe(
      "terminal error redacted (code=-32000, messageLength=27)",
    );
    expect(redactTerminalErrorMessage("x".repeat(10_000), -32000)).toBe(
      "terminal error redacted (code=-32000, messageLength=10000)",
    );
    expect(redactTerminalErrorMessage("terminal not found: term-123", -32005)).toBe(
      "terminal error redacted (code=-32005, messageLength=28)",
    );
  });

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

    const createdTerminal = await createHandlerA?.({ command: "echo hello" });
    expect(createdTerminal).toMatchObject({
      terminal_id: "term-123",
    });
    const exitedTerminal = await handlerA?.({ terminalId: "term-123" });
    expect(exitedTerminal).toMatchObject({
      exit_status: { exitCode: 0, signal: null },
    });
    const { error } = await captureError(handlerB?.({ terminalId: "term-123" }));

    expect(error).toBeInstanceOf(Error);
    expect(errorCode(error)).toBe(-32005);
    expect(error?.message).toBe("terminal not found");
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
    expect(error?.message).toBe("terminal not found");
  });

  test("failed terminal/create emits terminal.failed audit event with method and mapped code", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: (): never => {
          throw new OperationRejectedError("denied");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/create");
    const { error } = await captureError(handler?.({ command: "echo hello" }));

    expect(errorCode(error)).toBe(-32004);
    expect(harness.auditEvents).toEqual([
      {
        type: "terminal.failed",
        payload: {
          handoff_id: "handoff-1",
          method: "terminal/create",
          code: -32004,
          message: "denied",
        },
      },
    ]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        handoff_id: "handoff-1",
        worker_id: "worker-1",
        source: "worker",
        kind: "terminal.failed",
        meta: {
          handoff_id: "handoff-1",
          method: "terminal/create",
          code: -32004,
          message: "denied",
        },
      }) as unknown as DispatchEventInput,
    );
  });

  test("failed terminal/wait_for_exit emits terminal.failed audit event from shared wrapper", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalWaitForExit: (): never => {
          throw new TerminalNotFoundError("term-404");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/wait_for_exit");
    const { error } = await captureError(handler?.({ terminal_id: "term-404" }));

    expect(errorCode(error)).toBe(-32005);
    expect(error?.message).toBe("terminal not found");
    expect(harness.auditEvents).toEqual([
      {
        type: "terminal.failed",
        payload: {
          handoff_id: "handoff-1",
          method: "terminal/wait_for_exit",
          code: -32005,
          message: "terminal not found",
        },
      },
    ]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        kind: "terminal.failed",
        meta: {
          handoff_id: "handoff-1",
          method: "terminal/wait_for_exit",
          code: -32005,
          message: "terminal not found",
        },
      }) as unknown as DispatchEventInput,
    );
  });

  test("internal terminal-not-found failures emit only the canonical message", async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: (): never => {
          throw new TerminalNotFoundError("term-404");
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/output");
    const { error } = await captureError(handler?.({ terminal_id: "term-404" }));

    expect(errorCode(error)).toBe(-32005);
    expect(error?.message).toBe("terminal not found");
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        kind: "terminal.failed",
        meta: expect.objectContaining({
          method: "terminal/output",
          code: -32005,
          message: "terminal not found",
        }) as unknown,
      }) as unknown as DispatchEventInput,
    );
    expect(harness.auditEvents).toEqual([
      {
        type: "terminal.failed",
        payload: {
          handoff_id: "handoff-1",
          method: "terminal/output",
          code: -32005,
          message: "terminal not found",
        },
      },
    ]);
  });

  test("spoofed safe-terminal markers do not bypass terminal failure redaction", async () => {
    const secret = "sk-SPOOFED-SAFE-MARKER-SECRET";
    const spoofed = new Error(`spawn failed with ${secret}`) as Error & {
      safeTerminalMessage?: true;
    };
    spoofed.safeTerminalMessage = true;
    const harness = createHarness(
      { terminal: true },
      {
        terminalKill: (): never => {
          throw spoofed;
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/kill");
    const { error } = await captureError(handler?.({ terminal_id: "term-123" }));
    const expectedMessage = `terminal error redacted (code=-32000, messageLength=${String(spoofed.message.length)})`;

    expect(errorCode(error)).toBe(-32000);
    expect(error?.message).toBe(expectedMessage);
    expect(error?.message).not.toContain(secret);
    expect(JSON.stringify(harness.events)).not.toContain(secret);
    expect(JSON.stringify(harness.auditEvents)).not.toContain(secret);
    const failedEvent = harness.events.find((event) => event.kind === "terminal.failed");
    expect(failedEvent?.meta?.method).toBe("terminal/kill");
    expect(failedEvent?.meta?.code).toBe(-32000);
    expect(failedEvent?.meta?.message).toBe(expectedMessage);
    expect(harness.auditEvents).toEqual([
      {
        type: "terminal.failed",
        payload: {
          handoff_id: "handoff-1",
          method: "terminal/kill",
          code: -32000,
          message: expectedMessage,
        },
      },
    ]);
  });

  test("terminal-not-found failure sinks never include caller-supplied terminal ids", async () => {
    const secretTerminalId = "term-sk-CALLER-CONTROLLED-SECRET";
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: (): never => {
          throw new TerminalNotFoundError(secretTerminalId);
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/output");
    const { error } = await captureError(handler?.({ terminal_id: secretTerminalId }));

    expect(errorCode(error)).toBe(-32005);
    expect(error?.message).toBe("terminal not found");
    expect(error?.message).not.toContain(secretTerminalId);
    expect(JSON.stringify(harness.events)).not.toContain(secretTerminalId);
    expect(JSON.stringify(harness.auditEvents)).not.toContain(secretTerminalId);
    expect(harness.auditEvents).toEqual([
      {
        type: "terminal.failed",
        payload: {
          handoff_id: "handoff-1",
          method: "terminal/output",
          code: -32005,
          message: "terminal not found",
        },
      },
    ]);
  });

  test("terminal failure audit rejection is warned and does not replace the returned error", async () => {
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };
    try {
      const harness = createHarness(
        { terminal: true },
        {
          terminalKill: (): never => {
            throw new TerminalNotFoundError("term-404");
          },
          auditTerminalFailure: (): Promise<void> =>
            Promise.reject(new Error("audit sink offline")),
        },
      );

      await harness.runDispatch();
      const handler = harness.getHandler("terminal/kill");
      const { error } = await captureError(handler?.({ terminal_id: "term-404" }));

      await flush();
      expect(error?.message).toBe("terminal not found");
      expect(warnings).toContainEqual([
        "stdio-acp: terminal failure audit emit failed",
        {
          method: "terminal/kill",
          code: -32005,
          message: "audit sink offline",
        },
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("fast terminal failure audit writes complete before the returned error", async () => {
    let auditCompleted = false;
    const harness = createHarness(
      { terminal: true },
      {
        terminalKill: (): never => {
          throw new TerminalNotFoundError("term-404");
        },
        auditTerminalFailure: async (): Promise<void> => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          auditCompleted = true;
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler("terminal/kill");
    const { error } = await captureError(handler?.({ terminal_id: "term-404" }));

    expect(error?.message).toBe("terminal not found");
    expect(auditCompleted).toBe(true);
  });

  test("hanging terminal failure audit waits only for the bounded timeout", async () => {
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };
    try {
      const harness = createHarness(
        { terminal: true },
        {
          terminalKill: (): never => {
            throw new TerminalNotFoundError("term-404");
          },
          auditTerminalFailure: (): Promise<void> => new Promise(() => undefined),
        },
      );

      await harness.runDispatch();
      const handler = harness.getHandler("terminal/kill");
      const startedAt = Date.now();
      const handled = captureError(handler?.({ terminal_id: "term-404" }));
      const immediate = await Promise.race([
        handled,
        new Promise((resolve) =>
          setTimeout(() => {
            resolve("blocked");
          }, 20),
        ),
      ]);

      expect(immediate).toBe("blocked");

      const bounded = await Promise.race([
        handled,
        new Promise((resolve) =>
          setTimeout(() => {
            resolve("still-blocked");
          }, 2_800),
        ),
      ]);
      const elapsedMs = Date.now() - startedAt;

      expect(bounded).not.toBe("still-blocked");
      expect(elapsedMs).toBeLessThan(2_800);
      expect((bounded as { error: Error | null }).error?.message).toBe("terminal not found");
      const warning = warnings[0] as [string, { message?: unknown }] | undefined;
      const payload = warning?.[1] as unknown as { message?: unknown };
      expect(warning?.[0]).toBe("stdio-acp: terminal failure audit emit failed");
      expect(warning?.[1]).toMatchObject({
        method: "terminal/kill",
        code: -32005,
      });
      expect(typeof payload.message).toBe("string");
      expect(payload.message).toContain("timed out");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("terminal failure audit and logs do not expose raw command secrets", async () => {
    const secret = "FAKE_SECRET_TOKEN_do_not_log";
    const logs: unknown[] = [];
    // eslint-disable-next-line no-console -- Capture the established auto-approval log without exposing it.
    const originalInfo = console.info;
    // eslint-disable-next-line no-console -- Capture the established auto-approval log without exposing it.
    console.info = (...args: unknown[]): void => {
      logs.push(args);
    };
    try {
      const harness = createHarness(
        { terminal: true },
        {
          terminalCreate: (): never => {
            throw new OperationRejectedError("terminal rejected");
          },
        },
        { trust_mode: "all" },
      );

      await harness.runDispatch();
      const handler = harness.getHandler("terminal/create");
      const rawCommand = `curl -H "Authorization: Bearer ${secret}" https://example.test`;
      const rawArgv = ["curl", "-H", `Authorization: Bearer ${secret}`, "https://example.test"];
      const { error } = await captureError(
        handler?.({
          command: rawCommand,
          args: rawArgv,
          cwd: "/tmp",
        }),
      );
      const serializedLogs = JSON.stringify(logs);

      expect(errorCode(error)).toBe(-32004);
      expect(error?.message).toBe("terminal rejected");
      expect(JSON.stringify(harness.events)).not.toContain(secret);
      expect(JSON.stringify(harness.auditEvents)).not.toContain(secret);
      expect(serializedLogs).toContain("terminal/create auto-approved");
      expect(serializedLogs).not.toContain(secret);
      expect(serializedLogs).not.toContain(rawCommand);
      expect(serializedLogs).not.toContain(JSON.stringify(rawArgv));
      expect(logs).toEqual([
        [
          expect.stringMatching(
            /^stdio-acp: terminal\/create auto-approved cwd=\/tmp program=curl commandLength=\d+$/,
          ),
        ],
      ]);
      expect(harness.events.some((event) => event.kind === "terminal.failed")).toBe(true);
      expect(harness.auditEvents.some((event) => event.type === "terminal.failed")).toBe(true);
    } finally {
      // eslint-disable-next-line no-console -- Restore the established auto-approval log sink.
      console.info = originalInfo;
    }
  });

  test("terminal failure redacts secret-bearing mapped error messages from every sink", async () => {
    const secret = "sk-FAKE-SECRET-DO-NOT-LOG-12345";
    const fakeArgv = `["curl","-H","Authorization: Bearer ${secret}","https://example.test"]`;
    const terminalError = new Error(`spawn failed for full argv ${fakeArgv}`);
    const originalWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      const harness = createHarness(
        { terminal: true },
        {
          terminalCreate: (): never => {
            throw terminalError;
          },
        },
        { trust_mode: "all" },
      );

      await harness.runDispatch();
      const handler = harness.getHandler("terminal/create");
      const { error } = await captureError(
        handler?.({
          command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
          args: ["curl", "-H", `Authorization: Bearer ${secret}`, "https://example.test"],
        }),
      );

      expect(harness.events.some((event) => event.kind === "terminal.failed")).toBe(true);
      expect(harness.auditEvents.some((event) => event.type === "terminal.failed")).toBe(true);
      expect(error).not.toBeNull();
      expect(JSON.stringify(harness.events)).not.toContain(secret);
      expect(JSON.stringify(harness.auditEvents)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error?.message).not.toContain(secret);
      expect(error?.message).not.toContain(fakeArgv);
      expect((error as { cause?: unknown } | null)?.cause).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("terminal lifecycle callback failures preserve original terminal error and still audit", async () => {
    const originalTerminalError = new OperationRejectedError("original terminal failure");
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args);
    };
    try {
      const harness = createHarness(
        { terminal: true },
        {
          terminalCreate: (): never => {
            throw originalTerminalError;
          },
        },
        {
          onEvent: (event): void => {
            if (event.kind === "terminal.failed") {
              throw new Error("event callback failed");
            }
          },
        },
      );

      await harness.runDispatch();
      const handler = harness.getHandler("terminal/create");
      const { error } = await captureError(handler?.({ command: "echo hello" }));

      expect(error?.message).toBe("original terminal failure");
      expect(errorCode(error)).toBe(-32004);
      expect(harness.auditEvents).toEqual([
        {
          type: "terminal.failed",
          payload: {
            handoff_id: "handoff-1",
            method: "terminal/create",
            code: -32004,
            message: "original terminal failure",
          },
        },
      ]);
      expect(warnings).toEqual([
        [
          "stdio-acp: terminal failure lifecycle emit failed",
          {
            method: "terminal/create",
            code: -32004,
            message: "event callback failed",
          },
        ],
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("real adapter/client terminal error frames redact unknown secret-bearing failures", async () => {
    const secret = "sk-FAKE-SECRET-DO-NOT-LOG-12345";
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const writtenFrames: unknown[] = [];
    let sentTerminalRequest = false;
    let promptRequestId: string | number | null = null;

    clientToServer.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as {
          id?: string | number;
          method?: string;
          error?: { code?: number; message?: string };
        };
        writtenFrames.push(msg);
        if (msg.method === "initialize") {
          serverToClient.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } })}\n`,
          );
        } else if (msg.method === "session/new") {
          serverToClient.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "session-123" } })}\n`,
          );
        } else if (msg.method === "session/prompt") {
          promptRequestId = msg.id ?? null;
          if (!sentTerminalRequest) {
            sentTerminalRequest = true;
            serverToClient.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 900,
                method: "terminal/create",
                params: {
                  command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
                },
              })}\n`,
            );
          }
        } else if (msg.error !== undefined && msg.id === 900 && promptRequestId !== null) {
          serverToClient.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: promptRequestId,
              result: { stopReason: "end_turn" },
            })}\n`,
          );
        }
      }
    });

    const adapter = new StdioAcpAdapter(
      { binary: "mock-acp", terminal: true },
      {
        startServer: (): Promise<StdioAcpHandle> =>
          Promise.resolve({
            stdin: clientToServer,
            stdout: serverToClient,
            kill: (): void => undefined,
            exited: new Promise(() => undefined),
            getStderrTail: (): string => "",
          }),
        createClient: (handle): StdioAcpClient =>
          new StdioAcpClient({ stdin: handle.stdin, stdout: handle.stdout }),
      },
    );

    await adapter.dispatch({
      prompt: "hello",
      signal: new AbortController().signal,
      conversation: { id: "conv-1", project_id: null },
      config: {},
      handoff_id: "handoff-1",
      eventContext: { handoffId: "handoff-1", workerId: "worker-1" },
      executor: asExecutor({
        terminalCreate: (): never => {
          throw new Error(`spawn failed for ${secret}`);
        },
        auditTerminalFailure: (): Promise<void> => Promise.resolve(),
      }),
    });

    const terminalErrorFrame = writtenFrames.find(
      (frame): frame is { id: number; error: { code: number; message: string } } =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { id?: unknown }).id === 900 &&
        typeof (frame as { error?: unknown }).error === "object",
    );
    expect(terminalErrorFrame).toBeDefined();
    expect(terminalErrorFrame?.error.message).toBe(
      "terminal error redacted (code=-32000, messageLength=" +
        String(`spawn failed for ${secret}`.length) +
        ")",
    );
    expect(JSON.stringify(writtenFrames)).not.toContain(secret);
  });
});
