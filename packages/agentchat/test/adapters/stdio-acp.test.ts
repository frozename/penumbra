import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { StdioAcpAdapter } from '../../src/adapters/stdio-acp.js';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';

describe('StdioAcpAdapter', () => {
  it('happy path: initializes, creates session, and prompts', async () => {
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
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05' }, id: 1 }) + '\n');

    // 2. Server sends newSession response
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

    // 3. Server sends prompt response
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { text: 'world' }, id: 3 }) + '\n');

    const result = await dispatchPromise;
    expect(result.text).toBe('world');
    expect(mockKill).toHaveBeenCalled();
  });

  it('rejects tool call requests', async () => {
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
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: '2024-11-05' }, id: 1 }) + '\n');

    // 2. newSession
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

    // 3. Server sends tool call request
    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'tool.call.requested', params: {} }) + '\n');

    await expect(dispatchPromise).rejects.toThrow('stdio-acp: tool use not yet supported');
    expect(mockKill).toHaveBeenCalled();
  });
});
