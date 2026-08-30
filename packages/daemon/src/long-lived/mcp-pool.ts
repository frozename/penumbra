import type { HostedMcpServer } from "@penumbra/agentchat/config/types";
import type { ChildProcess } from "node:child_process";

import { createLogger } from "@penumbra/core";
import { spawn as nodeSpawn } from "node:child_process";

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
  callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    opts?: { timeoutMs?: number; _meta?: Record<string, unknown> },
  ): Promise<unknown>;
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

type JsonRpcMessage = {
  id?: unknown;
  error?: unknown;
  result?: unknown;
  method?: unknown;
};

const DEFAULT_GRACE_MS = 5 * 60_000;
const MAX_LINE_BYTES = 1_048_576;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseJsonRpcMessage(line: string): JsonRpcMessage | undefined {
  const parsed = JSON.parse(line) as unknown;
  return asRecord(parsed);
}

function messageError(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  const record = asRecord(error);
  const message = record?.message;
  return typeof message === "string" ? message : "mcp_error";
}

class McpPoolRuntime implements McpPool {
  private readonly log: ReturnType<typeof createLogger>;
  private readonly states = new Map<string, McpState>();
  private readonly graceMs: number;
  private readonly spawnChildProcess: typeof nodeSpawn;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private lastRegistration: FederationHealthSnapshot = { registered: [], skipped: [] };

  constructor(deps: McpPoolDeps) {
    this.log = deps.log ?? createLogger({ component: "daemon:mcp-pool" });
    this.graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
    this.spawnChildProcess = deps.spawnChildProcess ?? nodeSpawn;
    this.now = deps.now ?? Date.now;
    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, 60_000);
    this.sweepTimer.unref();
  }

  async ensureRunning(spec: HostedMcpServer): Promise<void> {
    try {
      await this.ensureStateRunning(spec);
    } catch (error) {
      this.recordSkip(spec.name, errorMessage(error));
      throw error;
    }
    this.snapshotHealth();
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    opts?: { timeoutMs?: number; _meta?: Record<string, unknown> },
  ): Promise<unknown> {
    const existing = this.states.get(serverName);
    if (!existing) throw new Error("mcp_unavailable");
    try {
      await this.ensureStateRunning(existing.spec);
    } catch (error) {
      this.recordSkip(serverName, errorMessage(error));
      throw error;
    }
    const state = this.states.get(serverName);
    if (!state || state.tornDown) throw new Error("mcp_unavailable");
    const params: Record<string, unknown> = {
      name: toolName,
      arguments: args ?? {},
    };
    if (opts?._meta && typeof opts._meta === "object" && !Array.isArray(opts._meta)) {
      params._meta = opts._meta;
    }
    return await this.sendRequest(state, "tools/call", params, opts?.timeoutMs ?? 30_000);
  }

  async listTools(serverName: string): Promise<McpToolDescriptor[]> {
    const state = this.states.get(serverName);
    if (!state) throw new Error("mcp_unavailable");
    try {
      await this.ensureStateRunning(state.spec);
    } catch (error) {
      this.recordSkip(serverName, errorMessage(error));
      throw error;
    }
    return [...(this.states.get(serverName)?.tools ?? [])];
  }

  private recordSkip(server: string, reason: string): void {
    const skipped = this.lastRegistration.skipped;
    const key = `${server}::${server}::${reason}`;
    for (const entry of skipped) {
      if (`${entry.server}::${entry.tool}::${entry.reason}` === key) {
        return;
      }
    }
    this.lastRegistration = {
      registered: [...this.lastRegistration.registered],
      skipped: [...skipped, { server, tool: server, reason }],
    };
  }

  acquire(agentId: string, serverName: string): void {
    const state = this.states.get(serverName);
    if (!state) return;
    state.refs.add(agentId);
    state.lastReleaseAt = undefined;
  }

  release(agentId: string, serverName: string): void {
    const state = this.states.get(serverName);
    if (!state) return;
    state.refs.delete(agentId);
    if (state.refs.size === 0) state.lastReleaseAt = this.now();
  }

  getFederationHealth(): FederationHealthSnapshot {
    this.snapshotHealth();
    return {
      registered: [...this.lastRegistration.registered],
      skipped: [...this.lastRegistration.skipped],
    };
  }

  shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const [serverName, state] of this.states) {
      state.cleanup?.();
      this.rejectPending(state, "mcp_shutdown");
      try {
        state.proc.kill();
      } catch {
        /* ignore */
      }
      state.tornDown = true;
      this.states.delete(serverName);
    }
    return Promise.resolve();
  }

  _sweep(): void {
    this.sweep();
  }

  _state(serverName: string): McpState | undefined {
    return this.states.get(serverName);
  }

  private envFromSpec(spec: HostedMcpServer): Record<string, string> {
    return Object.fromEntries(spec.env.map((entry) => [entry.name, entry.value]));
  }

  private specHash(spec: HostedMcpServer): string {
    return JSON.stringify({
      command: spec.command,
      args: spec.args,
      env: spec.env.map((entry) => `${entry.name}=${entry.value}`).sort(),
    });
  }

  private rejectPending(state: McpState, message: string): void {
    for (const [id, pending] of state.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      state.pending.delete(id);
    }
  }

  private teardownState(serverName: string, state: McpState): void {
    if (state.tornDown) {
      if (this.states.get(serverName) === state) this.states.set(serverName, state);
      return;
    }
    state.tornDown = true;
    this.rejectPending(state, "mcp_disconnected");
    try {
      state.proc.kill();
    } catch {
      /* ignore */
    }
    if (this.states.get(serverName) === state) this.states.set(serverName, state);
  }

  private snapshotHealth(reason?: string): void {
    const registered: FederationToolHealth[] = [];
    const skipped: SkippedFederationToolHealth[] = [...this.lastRegistration.skipped];
    const seenSkipped = new Set(
      skipped.map((entry) => `${entry.server}::${entry.tool}::${entry.reason}`),
    );
    for (const [server, state] of this.states) {
      this.collectStateHealth(state, server, registered, skipped, seenSkipped, reason);
    }
    this.lastRegistration = { registered, skipped };
  }

  private collectStateHealth(
    state: McpState,
    server: string,
    registered: FederationToolHealth[],
    skipped: SkippedFederationToolHealth[],
    seenSkipped: Set<string>,
    reason?: string,
  ): void {
    if (state.initialized) {
      for (const tool of state.tools) {
        registered.push({ server, tool: tool.name, name: `${server}.${tool.name}` });
      }
      for (let i = skipped.length - 1; i >= 0; i--) {
        const entry = skipped[i];
        if (entry?.server !== server) continue;
        seenSkipped.delete(`${entry.server}::${entry.tool}::${entry.reason}`);
        skipped.splice(i, 1);
      }
      return;
    }
    if (!reason) {
      return;
    }
    const key = `${server}::${server}::${reason}`;
    if (!seenSkipped.has(key)) {
      skipped.push({ server, tool: server, reason });
      seenSkipped.add(key);
    }
  }

  private isRunning(state: McpState): boolean {
    return (
      !state.tornDown &&
      state.proc.exitCode === null &&
      state.proc.signalCode === null &&
      Boolean(state.proc.stdin?.writable)
    );
  }

  private attachProc(serverName: string, spec: HostedMcpServer): McpState {
    const proc = this.spawnChildProcess(spec.command, spec.args, {
      env: { ...process.env, ...this.envFromSpec(spec) },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const state: McpState = {
      proc,
      requestSeq: 0,
      pending: new Map(),
      tools: [],
      refs: new Set(),
      spec,
      specHash: this.specHash(spec),
      initialized: false,
      stdoutBuffer: "",
    };
    const onData = (chunk: string | Buffer): void => {
      this.handleStdoutData(serverName, state, proc, chunk);
    };
    const onDisconnect = (): void => {
      this.teardownState(serverName, state);
    };
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", onData);
    proc.stdout.on("end", onDisconnect);
    proc.stdout.on("close", onDisconnect);
    proc.on("exit", onDisconnect);
    proc.on("close", onDisconnect);
    state.cleanup = (): void => {
      proc.stdout.off("data", onData);
      proc.stdout.off("end", onDisconnect);
      proc.stdout.off("close", onDisconnect);
      proc.off("exit", onDisconnect);
      proc.off("close", onDisconnect);
    };
    this.states.set(serverName, state);
    return state;
  }

  private handleStdoutData(
    serverName: string,
    state: McpState,
    proc: ChildProcess,
    chunk: string | Buffer,
  ): void {
    state.stdoutBuffer += chunk.toString();
    if (state.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.killLargeLine(serverName, proc, state.stdoutBuffer.length);
      return;
    }
    let idx: number;
    while ((idx = state.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = state.stdoutBuffer.slice(0, idx).trim();
      state.stdoutBuffer = state.stdoutBuffer.slice(idx + 1);
      if (line) {
        this.handleStdoutLine(serverName, state, line);
      }
    }
  }

  private killLargeLine(serverName: string, proc: ChildProcess, len: number): void {
    this.log.error({ server: serverName, len }, "mcp-pool-stdout-line-too-large-killing");
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }

  private handleStdoutLine(serverName: string, state: McpState, line: string): void {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(line) ?? {};
    } catch (error) {
      this.log.warn({ err: error, serverName, line }, "mcp pool dropped invalid json line");
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    const pending = id === undefined ? undefined : state.pending.get(id);
    if (id !== undefined && pending) {
      this.resolvePendingMessage(state, id, pending, message);
      return;
    }
    if (message.method === "notifications/initialized") {
      return;
    }
  }

  private resolvePendingMessage(
    state: McpState,
    id: number,
    pending: PendingRequest,
    message: JsonRpcMessage,
  ): void {
    state.pending.delete(id);
    clearTimeout(pending.timer);
    const error = messageError(message.error);
    if (error) {
      pending.reject(new Error(error));
      return;
    }
    pending.resolve(message.result);
  }

  private sendRequest<T>(
    state: McpState,
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const id = ++state.requestSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error("mcp_call_timeout"));
      }, timeoutMs);
      state.pending.set(id, {
        resolve: (value: unknown): void => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      if (!state.proc.stdin?.writable) {
        state.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("mcp_unavailable"));
        return;
      }
      state.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private async initialize(state: McpState): Promise<void> {
    await this.sendRequest(state, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "penumbra-mcp-pool", version: "0.1.0" },
    });
    state.proc.stdin?.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
    );
    const tools = await this.sendRequest<{ tools: McpToolDescriptor[] }>(state, "tools/list", {});
    state.tools = Array.isArray(tools.tools) ? tools.tools : [];
    state.initialized = true;
  }

  private async ensureStateRunning(spec: HostedMcpServer): Promise<McpState> {
    let existing = this.states.get(spec.name);
    const hash = this.specHash(spec);
    if (existing && this.canReuse(existing, hash)) {
      return existing;
    }
    if (existing && this.shouldRestartForDrift(existing, hash)) {
      this.restartForDrift(spec.name, existing);
      existing = undefined;
    }
    if (existing && this.isRunning(existing) && existing.initPromise) {
      await existing.initPromise;
      return existing;
    }
    if (existing && !this.isRunning(existing)) {
      this.teardownState(spec.name, existing);
      existing = undefined;
    }
    const state =
      existing && this.isRunning(existing) ? existing : this.attachProc(spec.name, spec);
    await this.initializeState(spec, state);
    return state;
  }

  private canReuse(state: McpState, hash: string): boolean {
    return this.isRunning(state) && state.initialized && state.specHash === hash;
  }

  private shouldRestartForDrift(state: McpState, hash: string): boolean {
    return this.isRunning(state) && state.initialized && state.specHash !== hash;
  }

  private restartForDrift(serverName: string, state: McpState): void {
    this.log.warn({ server: serverName }, "mcp-pool-spec-drift-restart");
    state.cleanup?.();
    try {
      state.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.states.delete(serverName);
  }

  private async initializeState(spec: HostedMcpServer, state: McpState): Promise<void> {
    state.spec = spec;
    state.tornDown = false;
    state.initialized = false;
    state.initPromise = this.initialize(state).then(
      () => {
        state.initPromise = undefined;
      },
      (error: unknown) => {
        state.initPromise = undefined;
        this.teardownState(spec.name, state);
        throw error;
      },
    );
    this.states.set(spec.name, state);
    await state.initPromise;
  }

  private sweep(): void {
    const current = this.now();
    for (const [serverName, state] of this.states) {
      if (state.refs.size > 0 || state.lastReleaseAt === undefined) continue;
      if (current - state.lastReleaseAt <= this.graceMs) continue;
      state.cleanup?.();
      try {
        state.proc.kill();
      } catch {
        /* ignore */
      }
      this.rejectPending(state, "mcp_shutdown");
      this.states.delete(serverName);
    }
  }
}

export function createMcpPool(
  deps: McpPoolDeps = {},
): McpPool & { _sweep(): void; _state(serverName: string): McpState | undefined } {
  return new McpPoolRuntime(deps);
}
