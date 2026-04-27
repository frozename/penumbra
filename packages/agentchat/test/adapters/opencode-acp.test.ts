import { expect, mock, test } from 'bun:test';
import { OpencodeAcpAdapter } from '../../src/adapters/opencode-acp.js';
import type { AcpServerHandle } from '../../src/adapters/acp-server.js';
import type { AcpClientOptions } from '../../src/adapters/acp-client.js';
import type { AcpEvent } from '../../src/adapters/acp-types.js';
import type { DispatchInput } from '../../src/sdk/adapter.js';

function createInput(prompt = 'ping'): DispatchInput {
  return {
    prompt,
    conversation: { id: 'conv-1', project_id: null },
    config: {},
    signal: new AbortController().signal,
  };
}

function createServerHandle(): AcpServerHandle & { kill: ReturnType<typeof mock> } {
  const kill = mock(async () => {});
  return {
    port: 4312,
    baseUrl: 'http://127.0.0.1:4312',
    pid: 999,
    kill,
    exited: Promise.resolve({ code: 0, signal: null }),
  };
}

function createClient(events: AcpEvent[]) {
  return {
    openSession: mock(async (_req?: { cwd?: string }) => ({ sessionId: 'sess-123' })),
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
        yield event;
      }
    }),
  };
}

test('opencode-acp concatenates SSE text deltas into a single response', async () => {
  const handle = createServerHandle();
  const startServer = mock(async () => handle);
  const client = createClient([
    { type: 'message.part.delta', messageID: 'm1', partIndex: 0, delta: 'po' },
    { type: 'message.part.delta', messageID: 'm1', partIndex: 0, delta: 'ng' },
    { type: 'done' },
  ]);
  const createClientMock = mock((opts: AcpClientOptions) => {
    expect(opts.baseUrl).toBe(handle.baseUrl);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    return client;
  });

  const adapter = new OpencodeAcpAdapter(
    {
      model: 'deepseek-v4',
      cwd: '/tmp/opencode-acp',
      opencodeBinary: 'custom-opencode',
      bootTimeoutMs: 1_234,
      requestTimeoutMs: 5_000,
    },
    { startServer, createClient: createClientMock },
  );

  const out = await adapter.dispatch(createInput());

  expect(out).toEqual({ text: 'pong' });
  expect(startServer).toHaveBeenCalledTimes(1);
  expect(startServer.mock.calls[0]?.[0]).toEqual({
    cwd: '/tmp/opencode-acp',
    pure: true,
    signal: startServer.mock.calls[0]?.[0].signal,
    opencodeBinary: 'custom-opencode',
    bootTimeoutMs: 1_234,
  });
  expect(client.openSession).toHaveBeenCalledWith({ cwd: '/tmp/opencode-acp' });
  expect(client.sendMessage).toHaveBeenCalledWith('sess-123', 'ping', {
    model: 'deepseek-v4',
    tools: [],
    directory: '/tmp/opencode-acp',
    workspace: '/tmp/opencode-acp',
  });
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test('opencode-acp rejects when ACP requests a tool call', async () => {
  const handle = createServerHandle();
  const startServer = mock(async () => handle);
  const client = createClient([
    {
      type: 'tool.call.requested',
      callID: 'call-1',
      tool: 'grep',
      arguments: { pattern: 'AuthManager' },
    },
  ]);

  const adapter = new OpencodeAcpAdapter(
    { model: 'deepseek-v4', cwd: '/tmp/opencode-acp' },
    {
      startServer,
      createClient: mock((_opts: AcpClientOptions) => client),
    },
  );

  await expect(adapter.dispatch(createInput())).rejects.toThrow(
    'opencode-acp: tool calls not supported in Commit 3 (requested grep)',
  );
  expect(handle.kill).toHaveBeenCalledTimes(1);
});

test('opencode-acp surfaces ACP server boot failures cleanly', async () => {
  const startServer = mock(async () => {
    throw new Error('ACP server did not report a port within 10ms');
  });
  const createClientMock = mock((_opts: AcpClientOptions) => {
    throw new Error('client should not be created when boot fails');
  });

  const adapter = new OpencodeAcpAdapter(
    { model: 'deepseek-v4', cwd: '/tmp/opencode-acp', bootTimeoutMs: 10 },
    { startServer, createClient: createClientMock },
  );

  await expect(adapter.dispatch(createInput())).rejects.toThrow(
    'ACP server did not report a port within 10ms',
  );
  expect(createClientMock).not.toHaveBeenCalled();
});

const integrationEnabled =
  process.env.PENUMBRA_RUN_OPENCODE_INTEGRATION === '1' && Boolean(Bun.which('opencode'));

test.if(integrationEnabled)('opencode-acp can dispatch a real ping against opencode ACP', async () => {
  const adapter = new OpencodeAcpAdapter({
    model: process.env.PENUMBRA_OPENCODE_MODEL ?? 'gpt-5',
    cwd: process.cwd(),
    bootTimeoutMs: 10_000,
    requestTimeoutMs: 45_000,
  });

  const out = await adapter.dispatch(
    createInput('Reply with the single word pong. Do not use tools.'),
  );

  expect(out.text.trim().length).toBeGreaterThan(0);
});
