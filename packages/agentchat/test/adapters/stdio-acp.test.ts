import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { StdioAcpAdapter } from '../../src/adapters/stdio-acp.js';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';

function createPermissionHarness() {
  const mockStdin = new PassThrough();
  const mockStdout = new PassThrough();
  const mockKill = vi.fn();
  const mockExited = Promise.resolve(0);
  const startServer = vi.fn().mockResolvedValue({
    stdin: mockStdin,
    stdout: mockStdout,
    kill: mockKill,
    exited: mockExited,
  });

  let requestHandler: ((params: any) => Promise<any> | any) | undefined;
  let lastOutcome: any = null;
  const mockClientRequest = vi.fn().mockImplementation(async (method: string, _params: any) => {
    if (method === 'initialize') {
      return { protocolVersion: 1 };
    }
    if (method === 'session/new') {
      return { sessionId: 'session-123' };
    }
    if (method === 'session/prompt') {
      if (!requestHandler) throw new Error('missing request handler');
      const outcome = await requestHandler({
        toolCall: {
          title: 'mcp__penumbra__chain.list_agents',
          rawInput: { args: ['--all'] },
        },
        options: [
          { kind: 'allow_always', optionId: 'allow-always' },
          { kind: 'allow_once', optionId: 'allow-once' },
          { kind: 'reject_once', optionId: 'reject-once' },
        ],
      });
      lastOutcome = outcome;
      return { stopReason: 'end_turn' };
    }
    return {};
  });

  const adapter = new StdioAcpAdapter(
    { binary: 'mock-acp', mcpServers: [{ name: 'penumbra', command: 'bun', args: ['/tmp/penumbra-mcp.ts'] } as any] },
    {
      startServer,
      createClient: () => ({
        onRequest: (method: string, handler: (params: any) => Promise<any> | any) => {
          if (method === 'session/request_permission') {
            requestHandler = handler;
          }
        },
        on: vi.fn(),
        request: mockClientRequest,
      }),
    },
  );

  return { adapter, mockClientRequest, mockKill, mockStdout, mockStdin, getOutcome: () => lastOutcome };
}

describe('StdioAcpAdapter', () => {
  it('calls requestPermission with the tool call context and selects allow_always on approve', async () => {
    const requestPermission = vi.fn().mockResolvedValue('approve' as const);
    const { adapter, getOutcome } = createPermissionHarness();

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalledWith({
      toolName: 'mcp__penumbra__chain.list_agents',
      rawInput: { args: ['--all'] },
      dispatchId: expect.any(String),
    });

    expect(getOutcome()).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
  });

  it('returns cancelled when requestPermission rejects the tool call', async () => {
    const requestPermission = vi.fn().mockResolvedValue('reject' as const);
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    let requestHandler: ((params: any) => Promise<any> | any) | undefined;
    let lastOutcome: any = null;
    const mockClientRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'session-123' };
      if (method === 'session/prompt') {
        if (!requestHandler) throw new Error('missing request handler');
        lastOutcome = await requestHandler({
          toolCall: {
            title: 'mcp__penumbra__chain.list_agents',
            rawInput: { args: ['--all'] },
          },
          options: [{ kind: 'allow_always', optionId: 'allow-always' }],
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', mcpServers: [{ name: 'penumbra', command: 'bun', args: ['/tmp/penumbra-mcp.ts'] } as any] },
      {
        startServer,
        createClient: () => ({
          onRequest: (method: string, handler: (params: any) => Promise<any> | any) => {
            if (method === 'session/request_permission') {
              requestHandler = handler;
            }
          },
          on: vi.fn(),
          request: mockClientRequest,
        }),
      },
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalledWith({
      toolName: 'mcp__penumbra__chain.list_agents',
      rawInput: { args: ['--all'] },
      dispatchId: expect.any(String),
    });

    expect(lastOutcome).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(mockKill).toHaveBeenCalled();
  });

  it('returns cancelled locally without invoking requestPermission when tool title and name are both missing', async () => {
    const requestPermission = vi.fn().mockResolvedValue('approve');
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    let requestHandler: ((params: any) => Promise<any> | any) | undefined;
    let lastOutcome: any = null;
    const mockClientRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'session-123' };
      if (method === 'session/prompt') {
        if (!requestHandler) throw new Error('missing request handler');
        lastOutcome = await requestHandler({
          toolCall: {
            rawInput: { whatever: 1 },
          },
          options: [
            { kind: 'allow_always', optionId: 'allow-always' },
            { kind: 'allow_once', optionId: 'allow-once' },
            { kind: 'reject_once', optionId: 'reject-once' },
          ],
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', mcpServers: [{ name: 'penumbra', command: 'bun', args: ['/tmp/penumbra-mcp.ts'] } as any] },
      {
        startServer,
        createClient: () => ({
          onRequest: (method: string, handler: (params: any) => Promise<any> | any) => {
            if (method === 'session/request_permission') {
              requestHandler = handler;
            }
          },
          on: vi.fn(),
          request: mockClientRequest,
        }),
      },
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).not.toHaveBeenCalled();
    expect(lastOutcome).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(mockKill).toHaveBeenCalled();
  });

  it('keeps the Phase 1a auto-allow stub when requestPermission is absent', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    let requestHandler: ((params: any) => Promise<any> | any) | undefined;
    let lastOutcome: any = null;
    const mockClientRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'session-123' };
      if (method === 'session/prompt') {
        if (!requestHandler) throw new Error('missing request handler');
        lastOutcome = await requestHandler({
          toolCall: {
            title: 'mcp__penumbra__chain.list_agents',
            rawInput: { args: ['--all'] },
          },
          options: [{ kind: 'allow_always', optionId: 'allow-always' }],
        });
        return { stopReason: 'end_turn' };
      }
      return {};
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', mcpServers: [{ name: 'penumbra', command: 'bun', args: ['/tmp/penumbra-mcp.ts'] } as any] },
      {
        startServer,
        createClient: () => ({
          onRequest: (method: string, handler: (params: any) => Promise<any> | any) => {
            if (method === 'session/request_permission') {
              requestHandler = handler;
            }
          },
          on: vi.fn(),
          request: mockClientRequest,
        }),
      },
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    expect(lastOutcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
    expect(mockKill).toHaveBeenCalled();
  });

  it('happy path: accumulates text from session/update notifications', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp' },
      {
        startServer,
        createClient: (h: any) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      }
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    // 1. Server sends initialize response
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1 }, id: 1 }) + '\n');

    // 2. Server sends session/new response
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

    // 3. Server streams agent_message_chunk session/update notifications carrying the text
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-123',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'wor' },
        },
      },
    }) + '\n');
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-123',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ld' },
        },
      },
    }) + '\n');

    // 4. Server sends prompt response with stopReason — signals turn complete (no text in response)
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { stopReason: 'end_turn' }, id: 3 }) + '\n');

    const result = await dispatchPromise;
    expect(result.text).toBe('world');
    expect(mockKill).toHaveBeenCalled();
  });

  it('rejects tool_call session/update notifications', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp' },
      {
        startServer,
        createClient: (h: any) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      }
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    // 1. Initialize
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1 }, id: 1 }) + '\n');

    // 2. session/new
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

    // 3. Server emits a tool_call session/update — adapter should reject single-turn dispatch
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-123',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'read',
        },
      },
    }) + '\n');

    await expect(dispatchPromise).rejects.toThrow('stdio-acp: tool use not yet supported');
    expect(mockKill).toHaveBeenCalled();
  });

  it('forwards session/update.usage_update to the capture port', async () => {
    const captureEmitSpy = vi.fn();
    const fakeCapturePort = { emit: captureEmitSpy } as any;

    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: Promise.resolve(0),
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'fake', capturePort: fakeCapturePort },
      { startServer, createClient: (h) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }) },
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'hi',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
    } as any);

    // Fake the initialize -> newSession -> session/prompt sequence enough to receive a session/update
    await new Promise((r) => setTimeout(r, 5));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1, authMethods: [] }, id: 1 }) + '\n');
    await new Promise((r) => setTimeout(r, 5));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-1' }, id: 2 }) + '\n');
    await new Promise((r) => setTimeout(r, 5));
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'usage_update',
          used: 1234,
          size: 200000,
          cost: { amount: 0.05, currency: 'USD' },
        },
      },
    }) + '\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(captureEmitSpy).toHaveBeenCalledWith({
      kind: 'usage_update',
      used: 1234,
      size: 200000,
      cost: { amount: 0.05, currency: 'USD' },
    });

    // Cleanup: complete the prompt so dispatch resolves
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { stopReason: 'end_turn' }, id: 3 }) + '\n');
    await dispatchPromise.catch(() => {}); // tolerate reject; we're only asserting the emit
  });

  it('rejects when session/prompt hangs past requestTimeoutMs and kills the server', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') return { sessionId: 'session-123' };
      if (method === 'session/prompt') {
        await new Promise(() => {});
      }
      return {};
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', requestTimeoutMs: 200 },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      }
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    await expect(dispatchPromise).rejects.toThrow(/session\/prompt timed out after 200ms/);
    expect(mockKill).toHaveBeenCalled();
  });

  it('merges env and drops unsetEnv keys, affecting auth method fallback', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn();
    mockClientRequest.mockImplementation((method, _params) => {
      if (method === 'initialize') {
        return Promise.resolve({
          protocolVersion: 1,
          authMethods: [
            { id: 'openai-api-key', type: 'env_var', vars: [{ name: 'OPENAI_API_KEY' }] },
            { id: 'chatgpt', type: 'oauth' },
          ],
        });
      }
      if (method === 'session/new') return Promise.resolve({ sessionId: 'session-123' });
      if (method === 'session/prompt') return Promise.resolve({ stopReason: 'end_turn' });
      return Promise.resolve({});
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: 'mock-acp',
        env: { FOO: 'bar', OPENAI_API_KEY: 'local-key' },
        unsetEnv: ['OPENAI_API_KEY'],
      },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      }
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    const passedEnv = startServer.mock.calls[0][0].env;
    expect(passedEnv.FOO).toBe('bar');
    expect(passedEnv.OPENAI_API_KEY).toBeUndefined();

    expect(mockClientRequest).toHaveBeenCalledWith('authenticate', { methodId: 'chatgpt' });
    expect(mockKill).toHaveBeenCalled();
  });

  it('respects authMethodId manual override', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn();
    mockClientRequest.mockImplementation((method, _params) => {
      if (method === 'initialize') {
        return Promise.resolve({
          protocolVersion: 1,
          authMethods: [
            { id: 'openai-api-key', type: 'env_var', vars: [{ name: 'OPENAI_API_KEY' }] },
            { id: 'custom-auth', type: 'custom' },
          ],
        });
      }
      if (method === 'session/new') return Promise.resolve({ sessionId: 'session-123' });
      if (method === 'session/prompt') return Promise.resolve({ stopReason: 'end_turn' });
      return Promise.resolve({});
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: 'mock-acp',
        authMethodId: 'custom-auth',
        env: { OPENAI_API_KEY: 'present' }, // Heuristic would pick openai-api-key
      },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      }
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    expect(mockClientRequest).toHaveBeenCalledWith('authenticate', { methodId: 'custom-auth' });
  });

  it('sends prompt as ContentBlock array per ACP spec', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn();
    mockClientRequest.mockImplementation((method, _params) => {
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 });
      if (method === 'session/new') return Promise.resolve({ sessionId: 'session-123' });
      if (method === 'session/prompt') return Promise.resolve({ stopReason: 'end_turn' });
      return Promise.resolve({});
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp' },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      }
    );

    await adapter.dispatch({
      prompt: 'hello world',
      signal: new AbortController().signal,
    });

    const promptCall = mockClientRequest.mock.calls.find((c: any[]) => c[0] === 'session/prompt');
    expect(promptCall).toBeDefined();
    expect(promptCall![1]).toEqual({
      sessionId: 'session-123',
      prompt: [{ type: 'text', text: 'hello world' }],
    });
  });

  it('passes mcpServers from options into session/new params', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn();
    mockClientRequest.mockImplementation((method: string, _params: unknown) => {
      if (method === 'initialize') return Promise.resolve({ protocolVersion: 1 });
      if (method === 'session/new') return Promise.resolve({ sessionId: 'session-123' });
      if (method === 'session/prompt') return Promise.resolve({ stopReason: 'end_turn' });
      return Promise.resolve({});
    });

    const mcpServers = [
      {
        name: 'penumbra',
        command: 'bun',
        args: ['/tmp/penumbra-mcp.ts'],
        env: [{ name: 'PENUMBRA_STORAGE_ROOT', value: '/tmp/penumbra-live' }],
      },
    ];

    const adapter = new StdioAcpAdapter(
      { binary: 'mock-acp', mcpServers },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      }
    );

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    const sessionNewCall = mockClientRequest.mock.calls.find((c: any[]) => c[0] === 'session/new');
    expect(sessionNewCall).toBeDefined();
    expect(sessionNewCall![1].mcpServers).toEqual(mcpServers);
  });

  it('injects PENUMBRA_HANDOFF_ID only for penumbra-mcp stdio servers, even when env is omitted', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    let capturedSessionParams: any = null;
    const mockClientRequest = vi.fn().mockImplementation(async (method: string, params: any) => {
      if (method === 'initialize') return { protocolVersion: 1 };
      if (method === 'session/new') {
        capturedSessionParams = params;
        return { sessionId: 'session-123' };
      }
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    });

    const adapter = new StdioAcpAdapter(
      {
        binary: 'mock-acp',
        mcpServers: [
          {
            name: 'penumbra-mcp',
            command: '/bin/penumbra-mcp',
            args: [],
          } as any,
          {
            name: 'github-mcp',
            command: '/bin/github-mcp',
            args: [],
            env: [{ name: 'TOKEN', value: 'abc123' }],
          } as any,
        ],
      },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = mockClientRequest;
          return client;
        },
      },
    );

    await adapter.dispatch({
      prompt: 'hi',
      conversation: { id: 'c1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: 'HANDOFF_ABC',
    });

    expect(capturedSessionParams.mcpServers).toBeDefined();
    expect(capturedSessionParams.mcpServers[0].env).toEqual([
      { name: 'PENUMBRA_HANDOFF_ID', value: 'HANDOFF_ABC' },
    ]);
    expect(capturedSessionParams.mcpServers[1].env).toEqual([{ name: 'TOKEN', value: 'abc123' }]);
  });
});
