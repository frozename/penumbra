import type { Subprocess } from 'bun';
import { buildFramedCommand, parseFramedOutput, type ParseFramedOutputResult } from './shell-framing.js';

export interface CreateSessionInput {
  handoffId: string;
  cwd: string;
  env: Record<string, string>;
  pty: boolean;
  agentName?: string;
}

export interface RunCommandInput {
  handoffId: string;
  sessionId: string;
  command: string;
  stdin?: string;
  agentName?: string;
}

export interface RunCommandResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SessionInfo {
  session_id: string;
  created_at: string;
  last_used_at: string;
  cwd: string;
  pty: boolean;
}

export interface ShellSessionPoolConfig {
  enabled: boolean;
  maxSessionsPerHandoff: number;
  maxConcurrentRunsPerSession: number;
  maxSessionIdleMs: number;
  maxCommandDurationMs: number;
  outputByteLimit: number;
  redactOutput: boolean;
  unsetEnv: string[];
  dangerousCommandsForAgent: (agentName: string) => string[];
  redactOutputForAgent: (agentName: string) => boolean;
}

export interface HandoffStatusReader {
  getStatus(handoffId: string): Promise<string | null>;
}

export class MaxSessionsPerHandoffError extends Error {
  constructor(limit: number) {
    super(`max sessions per handoff exceeded (limit ${limit})`);
    this.name = 'MaxSessionsPerHandoffError';
  }
}

interface SessionState {
  handoffId: string;
  sessionId: string;
  proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  launchEnv: Record<string, string>;
  cwd: string;
  pty: boolean;
  createdAt: string;
  lastUsedAt: string;
  agentName?: string;
  runQueue: Promise<unknown>;
  dead: boolean;
  replacing: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
  waiters: Set<() => void>;
}

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

const COMMAND_TIMED_OUT = 'COMMAND_TIMED_OUT' as const;
const COMMAND_CANCELLED = 'COMMAND_CANCELLED' as const;
const TERMINAL_HANDOFF_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled']);

function redactCredentials(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function stripAnsiEscapes(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function truncateToByteLimit(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limit) {
    return { text, truncated: false };
  }

  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > limit) {
    end -= 1;
  }
  return { text: text.slice(0, end), truncated: true };
}

export interface ShellSessionPoolDeps {
  config: ShellSessionPoolConfig;
  uuid: () => string;
  now?: () => Date;
  handoffStatusReader?: HandoffStatusReader;
}

export class ShellSessionPool {
  private readonly handoffs = new Map<string, Map<string, SessionState>>();

  constructor(private readonly deps: ShellSessionPoolDeps) {}

  listSessions(handoffId: string): SessionInfo[] {
    const sessions = this.handoffs.get(handoffId);
    if (!sessions) return [];

    return [...sessions.values()]
      .filter((state) => !state.dead)
      .map((state) => ({
        session_id: state.sessionId,
        created_at: state.createdAt,
        last_used_at: state.lastUsedAt,
        cwd: state.cwd,
        pty: state.pty,
      }));
  }

  async createSession(input: CreateSessionInput): Promise<{ sessionId: string }> {
    const sessions = this.handoffs.get(input.handoffId) ?? new Map<string, SessionState>();
    const activeCount = [...sessions.values()].filter((state) => !state.dead).length;
    if (activeCount >= this.deps.config.maxSessionsPerHandoff) {
      throw new MaxSessionsPerHandoffError(this.deps.config.maxSessionsPerHandoff);
    }

    const sessionId = this.deps.uuid();
    const now = this.timestamp();
    const launchEnv = this.buildChildEnv(input.handoffId, sessionId, input.env);
    const proc = this.spawnShell(input.cwd, launchEnv, input.pty);

    const state: SessionState = {
      handoffId: input.handoffId,
      sessionId,
      proc,
      launchEnv,
      cwd: input.cwd,
      pty: input.pty,
      createdAt: now,
      lastUsedAt: now,
      agentName: input.agentName,
      runQueue: Promise.resolve(),
      dead: false,
      replacing: false,
      stdoutBuffer: '',
      stderrBuffer: '',
      waiters: new Set(),
    };

    sessions.set(sessionId, state);
    this.handoffs.set(input.handoffId, sessions);

    this.attachProcess(state, proc);
    await this.bootstrapSession(state);

    return { sessionId };
  }

  async runCommand(input: RunCommandInput): Promise<RunCommandResult> {
    const sessions = this.handoffs.get(input.handoffId);
    const state = sessions?.get(input.sessionId);
    if (!state || state.dead) {
      return { exit_code: -1, stdout: '', stderr: 'session ended', truncated: false };
    }

    const next = state.runQueue.then(() => this.runCommandImpl(state, input));
    state.runQueue = next.catch(() => undefined);
    return next;
  }

  async closeSession(input: { handoffId: string; sessionId: string }): Promise<{ closed: boolean }> {
    const sessions = this.handoffs.get(input.handoffId);
    const state = sessions?.get(input.sessionId);
    if (!state || state.dead) {
      return { closed: false };
    }

    state.dead = true;
    this.notifyWaiters(state);
    this.deleteSession(input.handoffId, input.sessionId);
    this.terminateProcess(state.proc);
    await Promise.race([state.proc.exited, this.sleep(100)]);
    if (state.proc.exitCode === null) {
      try {
        state.proc.kill('SIGKILL');
      } catch {}
    }

    return { closed: true };
  }

  async reapHandoff(handoffId: string): Promise<void> {
    const sessions = this.handoffs.get(handoffId);
    if (!sessions) return;

    const sessionIds = [...sessions.keys()];
    for (const sessionId of sessionIds) {
      await this.closeSession({ handoffId, sessionId });
    }
  }

  async reapTerminalHandoffs(): Promise<void> {
    if (!this.deps.handoffStatusReader) return;

    for (const handoffId of [...this.handoffs.keys()]) {
      const status = await this.deps.handoffStatusReader.getStatus(handoffId);
      if (status && TERMINAL_HANDOFF_STATUSES.has(status)) {
        await this.reapHandoff(handoffId);
      }
    }
  }

  async reapIdleSessions(): Promise<void> {
    const now = (this.deps.now ?? (() => new Date()))().getTime();

    for (const [handoffId, sessions] of this.handoffs) {
      for (const [sessionId, state] of sessions) {
        const lastUsed = new Date(state.lastUsedAt).getTime();
        if (now - lastUsed > this.deps.config.maxSessionIdleMs) {
          await this.closeSession({ handoffId, sessionId });
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const handoffId of [...this.handoffs.keys()]) {
      await this.reapHandoff(handoffId);
    }
  }

  private async runCommandImpl(state: SessionState, input: RunCommandInput): Promise<RunCommandResult> {
    if (state.dead) {
      return { exit_code: -1, stdout: '', stderr: 'session ended', truncated: false };
    }

    if (input.agentName) {
      state.agentName = input.agentName;
    }

    const commandId = this.deps.uuid();
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId,
      userCommand: input.command,
      stdin: input.stdin,
    });

    const stdoutStart = state.stdoutBuffer.length;
    const stderrStart = state.stderrBuffer.length;
    state.proc.stdin.write(`${snippet}\n`);

    let timedOut = false;
    const completion = this.waitForCommandCompletion(state, stdoutStart, stderrStart, startMarker, endMarker, () => timedOut);
    const result = await Promise.race([
      completion,
      this.sleep(this.deps.config.maxCommandDurationMs).then(() => {
        timedOut = true;
        return COMMAND_TIMED_OUT;
      }),
    ]);

    if (result === COMMAND_TIMED_OUT) {
      try {
        state.proc.stdin.write('\u0003');
      } catch {}
      try {
        state.proc.stdin.write('\n');
      } catch {}
      await this.replaceTimedOutProcess(state);
      this.resetBuffers(state);
      state.lastUsedAt = this.timestamp();
      return {
        exit_code: 124,
        stdout: '',
        stderr: 'shell_run: command timed out\n',
        truncated: false,
      };
    }

    if (result === COMMAND_CANCELLED) {
      this.resetBuffers(state);
      return { exit_code: 124, stdout: '', stderr: 'shell_run: command timed out\n', truncated: false };
    }

    if (result === null || state.dead) {
      this.resetBuffers(state);
      return { exit_code: -1, stdout: '', stderr: 'session ended', truncated: false };
    }

    this.resetBuffers(state);

    const agentName = input.agentName ?? state.agentName ?? '';
    let stdout = result.stdout;
    let stderr = result.stderr;
    if (state.pty) {
      stdout = stripAnsiEscapes(stdout);
      stderr = stripAnsiEscapes(stderr);
    }
    if (this.deps.config.redactOutputForAgent(agentName)) {
      stdout = redactCredentials(stdout);
      stderr = redactCredentials(stderr);
    }

    const truncatedStdout = truncateToByteLimit(stdout, this.deps.config.outputByteLimit);
    const truncatedStderr = truncateToByteLimit(stderr, this.deps.config.outputByteLimit);
    state.lastUsedAt = this.timestamp();

    return {
      exit_code: result.exitCode,
      stdout: truncatedStdout.text,
      stderr: truncatedStderr.text,
      truncated: truncatedStdout.truncated || truncatedStderr.truncated,
    };
  }

  private async waitForCommandCompletion(
    state: SessionState,
    stdoutStart: number,
    stderrStart: number,
    startMarker: string,
    endMarker: string,
    isCancelled: () => boolean,
  ): Promise<ParseFramedOutputResult | null | typeof COMMAND_CANCELLED> {
    while (!isCancelled()) {
      const parsed = parseFramedOutput({
        stdout: state.stdoutBuffer.slice(stdoutStart),
        stderr: state.stderrBuffer.slice(stderrStart),
        startMarker,
        endMarker,
      });

      if (parsed.complete) {
        return parsed;
      }

      if (state.dead) {
        return null;
      }

      await this.waitForData(state, 50);
    }

    return COMMAND_CANCELLED;
  }

  private async waitForData(state: SessionState, timeoutMs: number): Promise<void> {
    if (state.dead) return;

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        state.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      state.waiters.add(finish);
    });
  }

  private async pumpStream(
    state: SessionState,
    proc: Subprocess<'pipe', 'pipe', 'pipe'>,
    stream: ReadableStream<Uint8Array>,
    target: 'stdout' | 'stderr',
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        if (state.proc !== proc || state.dead) continue;
        if (target === 'stdout') {
          state.stdoutBuffer += chunk;
        } else {
          state.stderrBuffer += chunk;
        }
        this.notifyWaiters(state);
      }

      const tail = decoder.decode();
      if (tail && state.proc === proc && !state.dead) {
        if (target === 'stdout') {
          state.stdoutBuffer += tail;
        } else {
          state.stderrBuffer += tail;
        }
      }
    } finally {
      this.notifyWaiters(state);
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  private buildChildEnv(handoffId: string, sessionId: string, env: Record<string, string>): Record<string, string> {
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') {
        inherited[key] = value;
      }
    }

    for (const key of this.deps.config.unsetEnv) {
      delete inherited[key];
    }

    return {
      ...inherited,
      ...env,
      PENUMBRA_SHELL_SESSION_ID: sessionId,
      PENUMBRA_HANDOFF_ID: handoffId,
    };
  }

  private notifyWaiters(state: SessionState): void {
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private resetBuffers(state: SessionState): void {
    state.stdoutBuffer = '';
    state.stderrBuffer = '';
  }

  private spawnShell(cwd: string, env: Record<string, string>, pty: boolean): Subprocess<'pipe', 'pipe', 'pipe'> {
    if (pty) {
      try {
        return (Bun.spawn as any)(['bash', '--norc', '--noprofile', '-i'], {
          cwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
          pty: true,
        }) as Subprocess<'pipe', 'pipe', 'pipe'>;
      } catch (err) {
        throw new Error(`pty unavailable: ${String(err)}`);
      }
    }

    return Bun.spawn(['bash', '--norc', '--noprofile', '-i'], {
      cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as Subprocess<'pipe', 'pipe', 'pipe'>;
  }

  private attachProcess(state: SessionState, proc: Subprocess<'pipe', 'pipe', 'pipe'>): void {
    void this.pumpStream(state, proc, proc.stdout as ReadableStream<Uint8Array>, 'stdout');
    void this.pumpStream(state, proc, proc.stderr as ReadableStream<Uint8Array>, 'stderr');
    void proc.exited.finally(() => {
      if (state.replacing && state.proc === proc) return;
      if (state.proc !== proc) return;
      state.dead = true;
      this.notifyWaiters(state);
      this.deleteSession(state.handoffId, state.sessionId);
    });
  }

  private async bootstrapSession(state: SessionState): Promise<void> {
    state.proc.stdin.write("unset PROMPT_COMMAND\nPS1=''\nPS2=''\nPS4=''\nexec 3>&2\n");
    await this.sleep(75);
    this.resetBuffers(state);
  }

  private async replaceTimedOutProcess(state: SessionState): Promise<void> {
    const oldProc = state.proc;
    state.replacing = true;
    try {
      oldProc.kill('SIGTERM');
    } catch {}
    await Promise.race([oldProc.exited, this.sleep(100)]);
    if (oldProc.exitCode === null) {
      try {
        oldProc.kill('SIGKILL');
      } catch {}
      await Promise.race([oldProc.exited, this.sleep(100)]);
    }

    const proc = this.spawnShell(state.cwd, state.launchEnv, state.pty);
    state.proc = proc;
    state.dead = false;
    this.attachProcess(state, proc);
    await this.bootstrapSession(state);
    state.replacing = false;
  }

  private deleteSession(handoffId: string, sessionId: string): void {
    const sessions = this.handoffs.get(handoffId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.handoffs.delete(handoffId);
    }
  }

  private terminateProcess(proc: Subprocess<'pipe', 'pipe', 'pipe'>): void {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private timestamp(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}
