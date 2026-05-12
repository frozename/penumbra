import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import type { HostedMcpServer } from '@penumbra/agentchat/config/types';
import { createLogger } from '@penumbra/core';

export interface McpPoolDeps {
  spawnChildProcess?: typeof nodeSpawn;
  now?: () => number;
  log?: ReturnType<typeof createLogger>;
  graceMs?: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FederationToolHealth {
  server: string;
  tool: string;
  name: string;
}

export interface SkippedFederationToolHealth {
  server: string;
  tool: string;
  reason: string;
}

export interface FederationHealthSnapshot {
  registered: FederationToolHealth[];
  skipped: SkippedFederationToolHealth[];
}

export interface McpPool {
  ensureRunning(spec: HostedMcpServer): Promise<void>;
  callTool(serverName: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
  listTools(serverName: string): Promise<McpToolDescriptor[]>;
  acquire(agentId: string, serverName: string): void;
  release(agentId: string, serverName: string): void;
  getFederationHealth(): FederationHealthSnapshot;
  shutdown(): Promise<void>;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type McpState = {
  proc: ChildProcess;
  requestSeq: number;
  pending: Map<number, PendingRequest>;
  tools: McpToolDescriptor[];
  refs: Set<string>;
  spec: HostedMcpServer;
  lastReleaseAt?: number;
  initialized: boolean;
  initPromise?: Promise<void>;
  tornDown?: boolean;
  stdoutBuffer: string;
  cleanup?: () => void;
  specHash: string;
};

/**
 * Grace period before tearing down an MCP subprocess after the last
 * long-lived agent releases its reference.
 */
const DEFAULT_GRACE_MS = 5 * 60_000;
const MAX_LINE_BYTES = 1_048_576;

export function createMcpPool(deps: McpPoolDeps = {}): McpPool & { _sweep(): void; _state(serverName: string): McpState | undefined } {
  const log = deps.log ?? createLogger({ component: 'daemon:mcp-pool' });
  const states = new Map<string, McpState>();
  let lastRegistration: FederationHealthSnapshot = { registered: [], skipped: [] };
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const spawnChildProcess = deps.spawnChildProcess ?? nodeSpawn;
  const now = deps.now ?? Date.now;
  const sweepTimer = setInterval(() => {
    sweep();
  }, 60_000);
  sweepTimer.unref?.();

  function envFromSpec(spec: HostedMcpServer): Record<string, string> {
    return Object.fromEntries((spec.env ?? []).map((entry) => [entry.name, entry.value]));
  }

  function specHash(spec: HostedMcpServer): string {
    return JSON.stringify({
      command: spec.command,
      args: spec.args ?? [],
      env: (spec.env ?? []).map((entry) => `${entry.name}=${entry.value}`).sort(),
    });
  }

  function rejectPending(state: McpState, message: string): void {
    for (const [id, pending] of state.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      state.pending.delete(id);
    }
  }

  function teardownState(serverName: string, state: McpState): void {
    if (state.tornDown) {
      if (states.get(serverName) === state) states.set(serverName, state);
      return;
    }
    state.tornDown = true;
    rejectPending(state, 'mcp_disconnected');
    try {
      state.proc.kill();
    } catch {
      /* ignore */
    }
    if (states.get(serverName) === state) states.set(serverName, state);
  }

  function snapshotHealth(reason?: string): void {
    const registered: FederationToolHealth[] = [];
    const skipped: SkippedFederationToolHealth[] = [...lastRegistration.skipped];
    const seenSkipped = new Set(skipped.map((entry) => `${entry.server}::${entry.tool}::${entry.reason}`));
    for (const [server, state] of states) {
      if (state.initialized) {
        for (const tool of state.tools) {
          registered.push({
            server,
            tool: tool.name,
            name: `${server}.${tool.name}`,
          });
        }
        continue;
      }
      if (reason) {
        const key = `${server}::${server}::${reason}`;
        if (!seenSkipped.has(key)) {
          skipped.push({ server, tool: server, reason });
          seenSkipped.add(key);
        }
      }
    }
    lastRegistration = { registered, skipped };
  }

  function isRunning(state: McpState): boolean {
    return !state.tornDown &&
      state.proc.exitCode == null &&
      state.proc.signalCode == null &&
      Boolean(state.proc.stdin?.writable);
  }

  function attachProc(serverName: string, spec: HostedMcpServer): McpState {
    const proc = spawnChildProcess(spec.command, spec.args ?? [], {
      env: { ...process.env, ...envFromSpec(spec) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const state: McpState = {
      proc,
      requestSeq: 0,
      pending: new Map(),
      tools: [],
      refs: new Set(),
      spec,
      specHash: specHash(spec),
      initialized: false,
      stdoutBuffer: '',
    };
    const onData = (chunk: string | Buffer) => {
      state.stdoutBuffer += chunk.toString();
      if (state.stdoutBuffer.length > MAX_LINE_BYTES) {
        log.error({ server: serverName, len: state.stdoutBuffer.length }, 'mcp-pool-stdout-line-too-large-killing');
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        return;
      }
      let idx: number;
      while ((idx = state.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = state.stdoutBuffer.slice(0, idx).trim();
        state.stdoutBuffer = state.stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch (error) {
          log.warn({ err: error, serverName, line }, 'mcp pool dropped invalid json line');
          continue;
        }
        if (typeof message.id === 'number' && state.pending.has(message.id)) {
          const pending = state.pending.get(message.id)!;
          state.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(new Error(typeof message.error?.message === 'string' ? message.error.message : 'mcp_error'));
          } else {
            pending.resolve(message.result);
          }
          continue;
        }
        if (message.method === 'notifications/initialized') continue;
      }
    };
    const onDisconnect = () => teardownState(serverName, state);
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', onData);
    proc.stdout?.on('end', onDisconnect);
    proc.stdout?.on('close', onDisconnect);
    proc.on('exit', onDisconnect);
    proc.on('close', onDisconnect);
    state.cleanup = () => {
      proc.stdout?.off('data', onData);
      proc.stdout?.off('end', onDisconnect);
      proc.stdout?.off('close', onDisconnect);
      proc.off('exit', onDisconnect);
      proc.off('close', onDisconnect);
    };
    states.set(serverName, state);
    return state;
  }

  function sendRequest<T>(state: McpState, method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const id = ++state.requestSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error('mcp_call_timeout'));
      }, timeoutMs);
      state.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      if (!state.proc.stdin?.writable) {
        state.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('mcp_unavailable'));
        return;
      }
      state.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async function initialize(state: McpState): Promise<void> {
    await sendRequest(state, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'penumbra-mcp-pool', version: '0.1.0' },
    });
    state.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    const tools = await sendRequest<{ tools: McpToolDescriptor[] }>(state, 'tools/list', {});
    state.tools = Array.isArray(tools.tools) ? tools.tools : [];
    state.initialized = true;
  }

  async function ensureStateRunning(spec: HostedMcpServer): Promise<McpState> {
    let existing = states.get(spec.name);
    if (existing && isRunning(existing) && existing.initialized && existing.specHash === specHash(spec)) return existing;
    if (existing && isRunning(existing) && existing.initialized && existing.specHash !== specHash(spec)) {
      log.warn({ server: spec.name }, 'mcp-pool-spec-drift-restart');
      existing.cleanup?.();
      try {
        existing.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      states.delete(spec.name);
      existing = undefined;
    }
    if (existing && isRunning(existing) && existing.initPromise) {
      await existing.initPromise;
      return existing;
    }
    if (existing?.cleanup) existing.cleanup();
    if (existing && !isRunning(existing)) existing.tornDown = true;
    const state = existing && isRunning(existing) ? existing : attachProc(spec.name, spec);
    state.spec = spec;
    state.tornDown = false;
    state.initialized = false;
    state.initPromise = initialize(state).then(
      () => {
        state.initPromise = undefined;
      },
      (error) => {
        state.initPromise = undefined;
        teardownState(spec.name, state);
        throw error;
      },
    );
    states.set(spec.name, state);
    await state.initPromise;
    return state;
  }

  function sweep(): void {
    const current = now();
    for (const [serverName, state] of states) {
      if (state.refs.size > 0 || state.lastReleaseAt == null) continue;
      if ((current - state.lastReleaseAt) <= graceMs) continue;
      state.cleanup?.();
      try {
        state.proc.kill();
      } catch {
        /* ignore */
      }
      rejectPending(state, 'mcp_shutdown');
      states.delete(serverName);
    }
  }

  return {
    async ensureRunning(spec: HostedMcpServer): Promise<void> {
      try {
        await ensureStateRunning(spec);
      } catch (error) {
        lastRegistration = {
          registered: [...lastRegistration.registered],
          skipped: [...lastRegistration.skipped, { server: spec.name, tool: spec.name, reason: String((error as Error)?.message ?? error) }],
        };
        throw error;
      }
      snapshotHealth();
    },

    async callTool(serverName: string, toolName: string, args: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
      const existing = states.get(serverName);
      if (!existing) throw new Error('mcp_unavailable');
      await ensureStateRunning(existing.spec);
      const state = states.get(serverName);
      if (!state || state.tornDown) throw new Error('mcp_unavailable');
      return sendRequest(state, 'tools/call', { name: toolName, arguments: args ?? {} }, opts?.timeoutMs ?? 30_000);
    },

    async listTools(serverName: string): Promise<McpToolDescriptor[]> {
      const state = states.get(serverName);
      if (!state) throw new Error('mcp_unavailable');
      await ensureStateRunning(state.spec);
      return [...(states.get(serverName)?.tools ?? [])];
    },

    acquire(agentId: string, serverName: string): void {
      const state = states.get(serverName);
      if (!state) return;
      state.refs.add(agentId);
      state.lastReleaseAt = undefined;
    },

    release(agentId: string, serverName: string): void {
      const state = states.get(serverName);
      if (!state) return;
      state.refs.delete(agentId);
      if (state.refs.size === 0) state.lastReleaseAt = now();
    },

    getFederationHealth(): FederationHealthSnapshot {
      snapshotHealth();
      return {
        registered: [...lastRegistration.registered],
        skipped: [...lastRegistration.skipped],
      };
    },

    async shutdown(): Promise<void> {
      clearInterval(sweepTimer);
      for (const [serverName, state] of states) {
        state.cleanup?.();
        rejectPending(state, 'mcp_shutdown');
        try {
          state.proc.kill();
        } catch {
          /* ignore */
        }
        state.tornDown = true;
        states.delete(serverName);
      }
    },

    _sweep: sweep,
    _state: (serverName: string) => states.get(serverName),
  };
}
