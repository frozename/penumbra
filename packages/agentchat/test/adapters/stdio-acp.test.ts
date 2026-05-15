import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  StdioAcpAdapter,
  isClaudeHostEnvKey,
  resolveHostEnvPolicy,
  shouldScrubHostEnvKey,
} from '../../src/adapters/stdio-acp.js';
import type { HostEnvPolicy } from '../../src/adapters/stdio-acp.js';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';
import { ThoughtCapture } from '../../src/worker/thought-capture.js';

function createPermissionHarness(adapterOptions: Record<string, unknown> = {
  mcpServers: [{ name: 'penumbra', command: 'bun', args: ['/tmp/penumbra-mcp.ts'] } as any],
}) {
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
    { binary: 'mock-acp', ...adapterOptions },
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
  it('isClaudeHostEnvKey identifies host-Claude env keys', () => {
    expect(isClaudeHostEnvKey('CLAUDECODE')).toBe(true);
    expect(isClaudeHostEnvKey('CLAUDE_CODE_ENTRYPOINT')).toBe(true);
    expect(isClaudeHostEnvKey('CLAUDE_CODE_FOO_BAR_2')).toBe(true);
    expect(isClaudeHostEnvKey('CLAUDE_EFFORT')).toBe(true);
    expect(isClaudeHostEnvKey('CLAUDE_PLUGIN_DATA')).toBe(true);
    expect(isClaudeHostEnvKey('ANTHROPIC_MODEL')).toBe(false);
    expect(isClaudeHostEnvKey('CLAUDE_CONFIG_DIR')).toBe(false);
    expect(isClaudeHostEnvKey('CLAUDECODE_EXTRA')).toBe(false);
    expect(isClaudeHostEnvKey('CLAUDE')).toBe(false);
    expect(isClaudeHostEnvKey('')).toBe(false);
  });

  it('dispatchStream scrubs only claude host env keys when hostEnvPolicy enables claude', async () => {
    const previousEnv = {
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_FOO: process.env.CLAUDE_CODE_FOO,
      OPENCODE_BAR: process.env.OPENCODE_BAR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_FOO = 'bar';
    process.env.OPENCODE_BAR = 'keep';
    process.env.ANTHROPIC_API_KEY = 'keep';

    try {
      const capturedEnv: Record<string, string> = {};
      const adapter = new StdioAcpAdapter(
        {
          binary: 'mock-acp',
          hostEnvPolicy: { claude: true },
        },
        {
          startServer: vi.fn().mockImplementation(async (opts) => {
            Object.assign(capturedEnv, opts.env);
            return {
              stdin: new PassThrough(),
              stdout: new PassThrough(),
              kill: vi.fn(),
              exited: Promise.resolve(0),
            };
          }),
          createClient: () => ({
            onRequest: vi.fn(),
            on: vi.fn(),
            request: vi.fn().mockImplementation(async (method: string) => {
              if (method === 'initialize') return { protocolVersion: 1 };
              if (method === 'session/new') return { sessionId: 'session-123' };
              if (method === 'session/prompt') return { stopReason: 'end_turn' };
              return {};
            }),
          }),
        },
      );

      await adapter.dispatch({
        prompt: 'hello',
        signal: new AbortController().signal,
      });

      expect(capturedEnv.CLAUDECODE).toBeUndefined();
      expect(capturedEnv.CLAUDE_CODE_FOO).toBeUndefined();
      expect(capturedEnv.OPENCODE_BAR).toBe('keep');
      expect(capturedEnv.ANTHROPIC_API_KEY).toBe('keep');
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('resolveHostEnvPolicy returns claude when only the legacy alias is set', () => {
    expect(resolveHostEnvPolicy({ sanitizeClaudeHostEnv: true })).toEqual({ claude: true });
  });

  it('resolveHostEnvPolicy merges the legacy alias when hostEnvPolicy is empty', () => {
    expect(resolveHostEnvPolicy({ hostEnvPolicy: {}, sanitizeClaudeHostEnv: true })).toEqual({ claude: true });
  });

  it('resolveHostEnvPolicy preserves explicit false over the legacy alias', () => {
    expect(
      resolveHostEnvPolicy({
        hostEnvPolicy: { claude: false },
        sanitizeClaudeHostEnv: true,
      }),
    ).toEqual({ claude: false });
  });

  it('resolveHostEnvPolicy throws on unknown enabled providers', () => {
    expect(() =>
      resolveHostEnvPolicy({
        hostEnvPolicy: { unknown: true } as unknown as HostEnvPolicy,
      }),
    ).toThrow(/unknown provider "unknown"/);
  });

  it('resolveHostEnvPolicy allows unknown disabled providers', () => {
    expect(
      resolveHostEnvPolicy({
        hostEnvPolicy: { unknown: false } as unknown as HostEnvPolicy,
      }),
    ).toEqual({ unknown: false });
  });

  it('shouldScrubHostEnvKey returns false for an unregistered provider', () => {
    expect(shouldScrubHostEnvKey('OPENCODE_BAR', { opencode: true } as unknown as HostEnvPolicy)).toBe(false);
  });

  function withClaudeCodeHostEnv<T>(run: () => Promise<T>): Promise<T> {
    const claudeCodeHostEnvKeys = [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'CLAUDE_EFFORT',
      'CLAUDE_PLUGIN_DATA',
    ] as const;
    const previous = new Map<string, string | undefined>();
    for (const key of claudeCodeHostEnvKeys) {
      previous.set(key, process.env[key]);
      process.env[key] = key === 'CLAUDECODE' ? '1' : `test-${key.toLowerCase()}`;
    }
    return run().finally(() => {
      for (const key of claudeCodeHostEnvKeys) {
        const value = previous.get(key);
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
  }

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

  it('registers permission handling for standalone fs.write capability', async () => {
    const requestPermission = vi.fn().mockResolvedValue('approve' as const);
    const { adapter, getOutcome } = createPermissionHarness({ fsWriteTextFile: true });

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalled();
    expect(getOutcome()).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
  });

  it('registers permission handling for standalone terminal capability', async () => {
    const requestPermission = vi.fn().mockResolvedValue('approve' as const);
    const { adapter, getOutcome } = createPermissionHarness({ terminal: true });

    await adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
      requestPermission,
    });

    expect(requestPermission).toHaveBeenCalled();
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

  it('routes agent_thought_chunk notifications through ThoughtCapture', async () => {
    const recorded: any[] = [];
    const thoughtCapture = new ThoughtCapture({
      config: {
        enabled: true,
        capture: {
          maxTextBytes: 100,
          maxStreamBytes: 1000,
          adapters: { 'stdio-acp': true },
          perAgentOverrides: {},
        },
        analyze: {
          enabled: false,
          onlyWhen: [],
          digest: { enabled: false, agent: 'x', maxInputChars: 50000, timeoutMs: 60000 },
          signals: { enabled: false, agent: 'x', timeoutMs: 60000, maxInputChars: null, definitions: [] },
        },
      },
      enqueue: (event) => recorded.push(event),
    });

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
      { binary: 'mock-acp', model: 'gemini-acp-pro' },
      {
        startServer,
        createClient: (h: any) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
        thoughtCapture,
      },
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'hello',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      handoff_id: 'h-acp-1',
    });

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1, authMethods: [] }, id: 1 }) + '\n');

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-123',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
          token_count: 3,
        },
      },
    }) + '\n');

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { stopReason: 'end_turn' }, id: 3 }) + '\n');

    await dispatchPromise;

    const thoughtEvents = recorded.filter((event) => event.kind === 'agent.thought');
    expect(thoughtEvents).toHaveLength(1);
    expect(thoughtEvents[0]).toMatchObject({
      handoff_id: 'h-acp-1',
      meta: {
        adapter: 'stdio-acp',
        text: 'thinking',
        token_count: 3,
      },
    });
  });

  it('emits ACP lifecycle events when eventContext is present', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);
    const events: any[] = [];

    const startServer = vi.fn().mockResolvedValue({
      stdin: mockStdin,
      stdout: mockStdout,
      kill: mockKill,
      exited: mockExited,
    });

    const mockClientRequest = vi.fn().mockImplementation(async (method: string) => {
      if (method === 'initialize') return { protocolVersion: 1, authMethods: [] };
      if (method === 'session/new') return { sessionId: 'session-123' };
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
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
      prompt: 'hello',
      conversation: { id: 'c-1', project_id: null },
      config: {},
      signal: new AbortController().signal,
      eventContext: { handoffId: 'h-acp', workerId: 'w-acp' },
      onEvent: (event: any) => events.push(event),
    });

    expect(events.map((event) => event.kind)).toEqual([
      'acp.server.start',
      'acp.session.start',
      'acp.session.end',
    ]);
    expect(events[0]).toMatchObject({
      handoff_id: 'h-acp',
      worker_id: 'w-acp',
      source: 'worker',
      meta: { adapter: 'stdio-acp', binary: 'mock-acp' },
    });
    expect(events[1].meta).toMatchObject({ session_id: 'session-123' });
    expect(events[2].meta).toMatchObject({ stop_reason: 'end_turn' });
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

  it('keeps tool_call session/update alive when only mcpServers are advertised', async () => {
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
      {
        binary: 'mock-acp',
        fsReadTextFile: false,
        fsWriteTextFile: false,
        terminal: false,
        mcpServers: [{ name: 'test', command: 'echo', args: [], env: [] } as any],
      },
      {
        startServer,
        createClient: (h: any) => new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout }),
      },
    );

    const dispatchPromise = adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    });

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: 1 }, id: 1 }) + '\n');

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { sessionId: 'session-123' }, id: 2 }) + '\n');

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

    expect(mockKill).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 10));
    mockStdout.write(JSON.stringify({ jsonrpc: '2.0', result: { stopReason: 'end_turn' }, id: 3 }) + '\n');

    await expect(dispatchPromise).resolves.toMatchObject({ text: '' });
    expect(mockKill).toHaveBeenCalledTimes(1);
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

    await expect(dispatchPromise).rejects.toThrow(/no wire activity .* for 200ms/);
    expect(mockKill).toHaveBeenCalled();
  });

  it('keeps session/prompt alive when ACP session/update progress arrives', async () => {
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
        setTimeout(() => {
          mockStdout.write(JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'session-123',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'still working' },
              },
            },
          }) + '\n');
        }, 150);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { stopReason: 'end_turn' };
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

    await expect(adapter.dispatch({
      prompt: 'hello',
      signal: new AbortController().signal,
    })).resolves.toEqual({ text: 'still working' });
    expect(mockKill).toHaveBeenCalledTimes(1);
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

  it('claude-agent-acp binary strips host env', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);
    let capturedEnv: Record<string, string> | undefined;

    const startServer = vi.fn().mockImplementation(async (opts) => {
      capturedEnv = opts.env;
      return {
        stdin: mockStdin,
        stdout: mockStdout,
        kill: mockKill,
        exited: mockExited,
      };
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'claude-agent-acp', sanitizeClaudeHostEnv: true },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = vi.fn().mockImplementation(async (method: string) => {
            if (method === 'initialize') return { protocolVersion: 1 };
            if (method === 'session/new') return { sessionId: 'session-123' };
            if (method === 'session/prompt') return { stopReason: 'end_turn' };
            return {};
          });
          return client;
        },
      },
    );

    await withClaudeCodeHostEnv(async () => {
      await adapter.dispatch({
        prompt: 'hello',
        signal: new AbortController().signal,
      });
    });

    expect(capturedEnv).toBeDefined();
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA']) {
      expect(capturedEnv).not.toHaveProperty(key);
    }
    expect(mockKill).toHaveBeenCalled();
  });

  it('non-claude binary does not strip host env', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);
    let capturedEnv: Record<string, string> | undefined;

    const startServer = vi.fn().mockImplementation(async (opts) => {
      capturedEnv = opts.env;
      return {
        stdin: mockStdin,
        stdout: mockStdout,
        kill: mockKill,
        exited: mockExited,
      };
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'opencode-acp' },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = vi.fn().mockImplementation(async (method: string) => {
            if (method === 'initialize') return { protocolVersion: 1 };
            if (method === 'session/new') return { sessionId: 'session-123' };
            if (method === 'session/prompt') return { stopReason: 'end_turn' };
            return {};
          });
          return client;
        },
      },
    );

    await withClaudeCodeHostEnv(async () => {
      await adapter.dispatch({
        prompt: 'hello',
        signal: new AbortController().signal,
      });
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).toHaveProperty('CLAUDECODE', '1');
    expect(capturedEnv).toHaveProperty('CLAUDE_CODE_EXECPATH', 'test-claude_code_execpath');
    expect(mockKill).toHaveBeenCalled();
  });

  it('sanitize flag plus opts.env override survives', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);
    let capturedEnv: Record<string, string> | undefined;

    const startServer = vi.fn().mockImplementation(async (opts) => {
      capturedEnv = opts.env;
      return {
        stdin: mockStdin,
        stdout: mockStdout,
        kill: mockKill,
        exited: mockExited,
      };
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'claude-agent-acp', sanitizeClaudeHostEnv: true, env: { CLAUDE_EFFORT: 'low' } },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = vi.fn().mockImplementation(async (method: string) => {
            if (method === 'initialize') return { protocolVersion: 1 };
            if (method === 'session/new') return { sessionId: 'session-123' };
            if (method === 'session/prompt') return { stopReason: 'end_turn' };
            return {};
          });
          return client;
        },
      },
    );

    await withClaudeCodeHostEnv(async () => {
      await adapter.dispatch({
        prompt: 'hello',
        signal: new AbortController().signal,
      });
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).toHaveProperty('CLAUDE_EFFORT', 'low');
    expect(mockKill).toHaveBeenCalled();
  });

  it('sanitize flag plus unsetEnv removes opts.env entry', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);
    let capturedEnv: Record<string, string> | undefined;

    const startServer = vi.fn().mockImplementation(async (opts) => {
      capturedEnv = opts.env;
      return {
        stdin: mockStdin,
        stdout: mockStdout,
        kill: mockKill,
        exited: mockExited,
      };
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'claude-agent-acp', sanitizeClaudeHostEnv: true, env: { CLAUDE_EFFORT: 'low' }, unsetEnv: ['CLAUDE_EFFORT'] },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = vi.fn().mockImplementation(async (method: string) => {
            if (method === 'initialize') return { protocolVersion: 1 };
            if (method === 'session/new') return { sessionId: 'session-123' };
            if (method === 'session/prompt') return { stopReason: 'end_turn' };
            return {};
          });
          return client;
        },
      },
    );

    await withClaudeCodeHostEnv(async () => {
      await adapter.dispatch({
        prompt: 'hello',
        signal: new AbortController().signal,
      });
    });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty('CLAUDE_EFFORT');
    expect(mockKill).toHaveBeenCalled();
  });

  it('prefix match strips arbitrary CLAUDE_CODE_* key', async () => {
    const mockStdin = new PassThrough();
    const mockStdout = new PassThrough();
    const mockKill = vi.fn();
    const mockExited = Promise.resolve(0);
    let capturedEnv: Record<string, string> | undefined;

    const startServer = vi.fn().mockImplementation(async (opts) => {
      capturedEnv = opts.env;
      return {
        stdin: mockStdin,
        stdout: mockStdout,
        kill: mockKill,
        exited: mockExited,
      };
    });

    const adapter = new StdioAcpAdapter(
      { binary: 'claude-agent-acp', sanitizeClaudeHostEnv: true },
      {
        startServer,
        createClient: (h: any) => {
          const client = new StdioAcpClient({ stdin: h.stdin, stdout: h.stdout });
          client.request = vi.fn().mockImplementation(async (method: string) => {
            if (method === 'initialize') return { protocolVersion: 1 };
            if (method === 'session/new') return { sessionId: 'session-123' };
            if (method === 'session/prompt') return { stopReason: 'end_turn' };
            return {};
          });
          return client;
        },
      },
    );

    const previous = process.env.CLAUDE_CODE_FUTURE_FLAG;
    process.env.CLAUDE_CODE_FUTURE_FLAG = '1';
    try {
      await adapter.dispatch({
        prompt: 'hello',
        signal: new AbortController().signal,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_FUTURE_FLAG;
      } else {
        process.env.CLAUDE_CODE_FUTURE_FLAG = previous;
      }
    }

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty('CLAUDE_CODE_FUTURE_FLAG');
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

  it('injects long-lived identity + allowlist env for long_lived_tick dispatches', async () => {
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
            env: [{ name: 'TOKEN', value: 'abc123' }],
          } as any,
          {
            name: 'github-mcp',
            command: '/bin/github-mcp',
            args: [],
            env: [{ name: 'GITHUB_TOKEN', value: 'xyz' }],
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
      long_lived_session: {
        dispatch_kind: 'long_lived_tick',
        agent_id: 'agent-1',
        tick_id: 'tick-1',
        mcp_tool_allowlist: ['penumbra:long_lived_self_state_get', 'penumbra:memory.search', 'ha:ha_pulse'],
      },
    });

    expect(capturedSessionParams.mcpServers).toBeDefined();
    const env = capturedSessionParams.mcpServers[0].env as Array<{ name: string; value: string }>;
    expect(env).toContainEqual({ name: 'TOKEN', value: 'abc123' });
    expect(env).toContainEqual({ name: 'PENUMBRA_HANDOFF_ID', value: 'HANDOFF_ABC' });
    expect(env).toContainEqual({ name: 'PENUMBRA_LONG_LIVED_AGENT_ID', value: 'agent-1' });
    expect(env).toContainEqual({ name: 'PENUMBRA_LONG_LIVED_TICK_ID', value: 'tick-1' });
    const allowlist = env.find((entry) => entry.name === 'PENUMBRA_MCP_TOOL_ALLOWLIST')?.value ?? '';
    const allowlistNames = new Set(allowlist.split(',').filter((name) => name.length > 0));
    expect(allowlistNames.has('long_lived_self_state_get')).toBe(true);
    expect(allowlistNames.has('memory.search')).toBe(true);
    expect(allowlistNames.has('ha:ha_pulse')).toBe(true);
    expect(allowlistNames.has('long_lived_self_state_get')).toBe(true);
    expect(allowlistNames.has('long_lived_self_state_set')).toBe(true);
    expect(allowlistNames.has('long_lived_self_pending_actions')).toBe(true);
    expect(capturedSessionParams.mcpServers[1].env).toEqual([{ name: 'GITHUB_TOKEN', value: 'xyz' }]);
  });
});
