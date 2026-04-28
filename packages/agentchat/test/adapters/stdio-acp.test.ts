import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { StdioAcpAdapter } from '../../src/adapters/stdio-acp.js';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';

describe('StdioAcpAdapter', () => {
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
});
