import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { StdioAcpAdapter } from '../../src/adapters/stdio-acp.js';
import { OperationRejectedError, OutsideWorktreeError, TerminalNotFoundError } from '../../src/worker/write-tools-errors.js';

function createHarness(options: Record<string, unknown> = {}, executor: Record<string, any> = {}) {
  const registeredMethods: string[] = [];
  const handlers = new Map<string, (params: any) => Promise<any> | any>();
  let initializeParams: any = null;

  const startServer = async () => ({
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => {},
    exited: Promise.resolve(0),
  });

  const client = {
    onRequest(method: string, handler: (params: any) => Promise<any> | any) {
      registeredMethods.push(method);
      handlers.set(method, handler);
    },
    on() {},
    async request(method: string, params?: any) {
      if (method === 'initialize') {
        initializeParams = params;
        return { protocolVersion: 1 };
      }
      if (method === 'session/new') return { sessionId: 'session-123' };
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    },
  };

  const adapter = new StdioAcpAdapter(
    {
      binary: 'mock-acp',
      cwd: '/tmp',
      ...options,
    } as any,
    {
      startServer,
      createClient: () => client as any,
    },
  );

  async function runDispatch() {
    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
      conversation: { id: 'conv-1', project_id: null },
      config: {},
      handoff_id: 'handoff-1',
      executor: executor as any,
    });
  }

  return {
    runDispatch,
    registeredMethods,
    getInitializeParams: () => initializeParams,
    getHandler: (method: string) => handlers.get(method),
  };
}

async function captureError(promise: Promise<any>) {
  try {
    return { value: await promise, error: null as Error | null };
  } catch (error) {
    return { value: null, error: error as Error };
  }
}

describe('StdioAcpAdapter write-tool ACP handlers', () => {
  test('fsWriteTextFile=true registers fs/write_text_file', async () => {
    const harness = createHarness({ fsWriteTextFile: true });

    await harness.runDispatch();

    expect(harness.registeredMethods).toContain('fs/write_text_file');
  });

  test('fsWriteTextFile=true advertises clientCapabilities.fs.writeTextFile', async () => {
    const harness = createHarness({ fsWriteTextFile: true });

    await harness.runDispatch();

    expect(harness.getInitializeParams().clientCapabilities.fs).toEqual({ writeTextFile: true });
  });

  test('fs/write_text_file invokes executor.writeTextFile and returns empty response', async () => {
    const calls: any[] = [];
    const harness = createHarness(
      { fsWriteTextFile: true },
      {
        writeTextFile: async (args: any, ctx: any) => {
          calls.push({ args, ctx });
          return { bytesWritten: 5, sha256: 'abc' };
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler('fs/write_text_file');
    expect(handler).toBeDefined();

    const result = await handler!({ path: '/tmp/file.txt', content: 'hello' });

    expect(result).toEqual({});
    expect(calls).toEqual([
      {
        args: { path: '/tmp/file.txt', content: 'hello' },
        ctx: {
          toolName: 'fs.write_text_file',
          rawInput: { path: '/tmp/file.txt', content_bytes: 5 },
          dispatchId: 'handoff-1',
        },
      },
    ]);
  });

  test('fs/write_text_file maps OperationRejectedError to -32004', async () => {
    const harness = createHarness(
      { fsWriteTextFile: true },
      {
        writeTextFile: async () => {
          throw new OperationRejectedError('denied');
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler('fs/write_text_file');
    const { error } = await captureError(handler!({ path: '/tmp/file.txt', content: 'hello' }));

    expect(error).toBeInstanceOf(Error);
    expect((error as any).code).toBe(-32004);
    expect(error?.message).toBe('denied');
  });

  test('fs/write_text_file maps OutsideWorktreeError to -32001', async () => {
    const harness = createHarness(
      { fsWriteTextFile: true },
      {
        writeTextFile: async () => {
          throw new OutsideWorktreeError('outside');
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler('fs/write_text_file');
    const { error } = await captureError(handler!({ path: '/tmp/file.txt', content: 'hello' }));

    expect(error).toBeInstanceOf(Error);
    expect((error as any).code).toBe(-32001);
    expect(error?.message).toBe('outside');
  });

  test('terminal=true registers all terminal/* handlers', async () => {
    const harness = createHarness({ terminal: true });

    await harness.runDispatch();

    expect(harness.registeredMethods).toEqual(
      expect.arrayContaining([
        'terminal/create',
        'terminal/output',
        'terminal/wait_for_exit',
        'terminal/release',
        'terminal/kill',
      ]),
    );
  });

  test('terminal=true advertises clientCapabilities.terminal', async () => {
    const harness = createHarness({ terminal: true });

    await harness.runDispatch();

    expect(harness.getInitializeParams().clientCapabilities.terminal).toBe(true);
  });

  test('terminal/create returns terminal_id from executor', async () => {
    const calls: any[] = [];
    const harness = createHarness(
      { terminal: true },
      {
        terminalCreate: async (args: any, ctx: any) => {
          calls.push({ args, ctx });
          return { terminal_id: 'term-123' };
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler('terminal/create');
    const result = await handler!({ command: 'echo hello', args: ['echo', 'hello'], cwd: '/tmp', output_byte_limit: 1234 });

    expect(result).toEqual({ terminal_id: 'term-123' });
    expect(calls).toEqual([
      {
        args: { command: 'echo hello', argv: ['echo', 'hello'], cwd: '/tmp', output_byte_limit: 1234 },
        ctx: {
          toolName: 'terminal.create',
          rawInput: { argv: ['echo', 'hello'], cmd: 'echo hello', cwd: '/tmp' },
          dispatchId: 'handoff-1',
        },
      },
    ]);
  });

  test('terminal/output returns the executor output snapshot', async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalOutput: async () => ({
          output: 'hello\n',
          truncated: false,
          exit_status: { exitCode: 0, signal: null },
        }),
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler('terminal/output');
    const result = await handler!({ terminal_id: 'term-123' });

    expect(result).toEqual({
      output: 'hello\n',
      truncated: false,
      exit_status: { exitCode: 0, signal: null },
    });
  });

  test('terminal/kill maps TerminalNotFoundError to -32005', async () => {
    const harness = createHarness(
      { terminal: true },
      {
        terminalKill: async () => {
          throw new TerminalNotFoundError('term-404');
        },
      },
    );

    await harness.runDispatch();
    const handler = harness.getHandler('terminal/kill');
    const { error } = await captureError(handler!({ terminal_id: 'term-404' }));

    expect(error).toBeInstanceOf(Error);
    expect((error as any).code).toBe(-32005);
    expect(error?.message).toBe('terminal not found: term-404');
  });
});
