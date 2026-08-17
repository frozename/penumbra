import type { Subprocess } from "bun";

import {
  buildFramedCommand,
  parseFramedOutput,
  type ParseFramedOutputResult,
} from "./shell-framing.js";

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
    super(`max sessions per handoff exceeded (limit ${String(limit)})`);
    this.name = "MaxSessionsPerHandoffError";
  }
}

interface SessionState {
  handoffId: string;
  sessionId: string;
  proc: Subprocess<"pipe", "pipe", "pipe">;
  launchEnv: Record<string, string>;
  cwd: string;
  pty: boolean;
  createdAt: string;
  lastUsedAt: string;
  agentName?: string;
  runQueue: Promise<unknown>;
  dead: boolean;
  stdoutBuffer: string;
  stderrBuffer: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  waiters: Set<() => void>;
}

const REDACTION_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /nvapi-[A-Za-z0-9_-]{20,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /fc-[A-Za-z0-9]{20,}/g,
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

const COMMAND_TIMED_OUT = "COMMAND_TIMED_OUT" as const;
const COMMAND_CANCELLED = "COMMAND_CANCELLED" as const;
const LIVE_CAPTURE_MARKER_CONTEXT_BYTES = 8192;
const TERMINAL_HANDOFF_STATUSES = new Set(["completed", "failed", "expired", "cancelled"]);

export function redactCredentials(text: string): string {
  let out = text;
  for (const pattern of REDACTION_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

// The daemon's own auth tokens must never reach a spawned shell: leaking
// PENUMBRA_TOKEN (the shared bearer) escalates a sandboxed worker to full
// daemon-API control. Dropped unconditionally from every child env, on top of
// the operator's configured unset_env list.
export const DAEMON_SECRET_ENV_KEYS: readonly string[] = [
  "PENUMBRA_TOKEN",
  "PENUMBRA_DAEMON_TOKEN",
  "PENUMBRA_SIRIUS_TOKEN",
];

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "PWD",
] as const;

// Build a child-process environment from a strict allowlist, then apply the
// operator's unset_env keys and the daemon's own auth-token blocklist.
export function buildScrubbedChildEnv(
  unsetEnv: readonly string[] | undefined,
  extraEnv: Record<string, string> = {},
): Record<string, string> {
  const drop = new Set<string>([...(unsetEnv ?? []), ...DAEMON_SECRET_ENV_KEYS]);
  const out: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && !drop.has(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (!drop.has(key)) out[key] = value;
  }
  return out;
}

// ESC (0x1B) and BEL (0x07) built at runtime to satisfy no-control-regex
const ANSI_CSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[a-zA-Z]`, "gu");
const ANSI_OSC_RE = new RegExp(
  `${String.fromCodePoint(0x1b)}\\][^${String.fromCodePoint(0x07)}]*${String.fromCodePoint(0x07)}`,
  "gu",
);

function stripAnsiEscapes(text: string): string {
  return text.replaceAll(ANSI_CSI_RE, "").replaceAll(ANSI_OSC_RE, "");
}

function normalizeByteLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Math.floor(limit);
}

function sliceUtf8Prefix(text: string, limit: number): string {
  const byteLimit = normalizeByteLimit(limit);
  if (Buffer.byteLength(text, "utf8") <= byteLimit) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= byteLimit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(0, low);
}

function sliceUtf8Suffix(text: string, limit: number): string {
  const byteLimit = normalizeByteLimit(limit);
  if (Buffer.byteLength(text, "utf8") <= byteLimit) {
    return text;
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(text.length - mid), "utf8") <= byteLimit) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(text.length - low);
}

function boundLiveCaptureBuffer(
  text: string,
  outputByteLimit: number,
): { text: string; truncated: boolean } {
  const headLimit = normalizeByteLimit(outputByteLimit) + LIVE_CAPTURE_MARKER_CONTEXT_BYTES;
  const tailLimit = LIVE_CAPTURE_MARKER_CONTEXT_BYTES;
  const maxBufferBytes = headLimit + tailLimit;
  if (Buffer.byteLength(text, "utf8") <= maxBufferBytes) {
    return { text, truncated: false };
  }

  return {
    text: `${sliceUtf8Prefix(text, headLimit)}${sliceUtf8Suffix(text, tailLimit)}`,
    truncated: true,
  };
}

function truncateToByteLimit(text: string, limit: number): { text: string; truncated: boolean } {
  const byteLimit = normalizeByteLimit(limit);
  if (Buffer.byteLength(text, "utf8") <= byteLimit) {
    return { text, truncated: false };
  }

  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > byteLimit) {
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

type BunSpawnWithPty = (
  cmd: string[],
  opts: Record<string, unknown>,
) => Subprocess<"pipe", "pipe", "pipe">;

export class ShellSessionPool {
  private readonly handoffs = new Map<string, Map<string, SessionState>>();
  private readonly intentionallyKilled = new WeakSet<Subprocess<"pipe", "pipe", "pipe">>();

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
      stdoutBuffer: "",
      stderrBuffer: "",
      stdoutTruncated: false,
      stderrTruncated: false,
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
      return { exit_code: -1, stdout: "", stderr: "session ended", truncated: false };
    }

    const next = state.runQueue.then(() => this.runCommandImpl(state, input));
    state.runQueue = next.catch(() => undefined);
    return await next;
  }

  async closeSession(input: {
    handoffId: string;
    sessionId: string;
  }): Promise<{ closed: boolean }> {
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
        state.proc.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
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
    const now = (this.deps.now ?? ((): Date => new Date()))().getTime();

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

  private async runCommandImpl(
    state: SessionState,
    input: RunCommandInput,
  ): Promise<RunCommandResult> {
    if (state.dead) {
      return { exit_code: -1, stdout: "", stderr: "session ended", truncated: false };
    }

    if (input.agentName) {
      state.agentName = input.agentName;
    }

    this.resetBuffers(state);

    const commandId = this.deps.uuid();
    const { snippet, startMarker, endMarker } = buildFramedCommand({
      commandId,
      userCommand: input.command,
      stdin: input.stdin,
    });

    const stdoutStart = state.stdoutBuffer.length;
    const stderrStart = state.stderrBuffer.length;
    void state.proc.stdin.write(`${snippet}\n`);

    const timedOutFlag = { value: false };
    const completion = this.waitForCommandCompletion(
      state,
      stdoutStart,
      stderrStart,
      startMarker,
      endMarker,
      () => timedOutFlag.value,
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof COMMAND_TIMED_OUT>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOutFlag.value = true;
        resolve(COMMAND_TIMED_OUT);
      }, this.deps.config.maxCommandDurationMs);
    });

    let result;
    try {
      result = await Promise.race([completion, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (result === COMMAND_TIMED_OUT) {
      try {
        void state.proc.stdin.write("");
      } catch {
        // process stdin may be closed
      }
      try {
        void state.proc.stdin.write("\n");
      } catch {
        // process stdin may be closed
      }
      await this.replaceTimedOutProcess(state);
      this.resetBuffers(state);
      state.lastUsedAt = this.timestamp();
      return {
        exit_code: 124,
        stdout: "",
        stderr: "shell_run: command timed out\n",
        truncated: false,
      };
    }

    if (result === COMMAND_CANCELLED) {
      this.resetBuffers(state);
      return {
        exit_code: 124,
        stdout: "",
        stderr: "shell_run: command timed out\n",
        truncated: false,
      };
    }

    if (result === null) {
      this.resetBuffers(state);
      return { exit_code: -1, stdout: "", stderr: "session ended", truncated: false };
    }

    const liveTruncated = state.stdoutTruncated || state.stderrTruncated;
    this.resetBuffers(state);

    const agentName = input.agentName ?? state.agentName ?? "";
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
      truncated: liveTruncated || truncatedStdout.truncated || truncatedStderr.truncated,
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
      const finish = (): void => {
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
    proc: Subprocess<"pipe", "pipe", "pipe">,
    stream: ReadableStream<Uint8Array>,
    target: "stdout" | "stderr",
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const value of stream) {
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk || state.proc !== proc || state.dead) continue;
        this.appendToBuffer(state, target, chunk);
        this.notifyWaiters(state);
      }
      const tail = decoder.decode();
      if (tail && state.proc === proc && !state.dead) {
        this.appendToBuffer(state, target, tail);
      }
    } finally {
      this.notifyWaiters(state);
    }
  }

  private appendToBuffer(state: SessionState, target: "stdout" | "stderr", chunk: string): void {
    if (target === "stdout") {
      const bounded = boundLiveCaptureBuffer(
        `${state.stdoutBuffer}${chunk}`,
        this.deps.config.outputByteLimit,
      );
      state.stdoutBuffer = bounded.text;
      if (bounded.truncated) {
        state.stdoutTruncated = true;
      }
    } else {
      const bounded = boundLiveCaptureBuffer(
        `${state.stderrBuffer}${chunk}`,
        this.deps.config.outputByteLimit,
      );
      state.stderrBuffer = bounded.text;
      if (bounded.truncated) {
        state.stderrTruncated = true;
      }
    }
  }

  private buildChildEnv(
    handoffId: string,
    sessionId: string,
    env: Record<string, string>,
  ): Record<string, string> {
    return buildScrubbedChildEnv(this.deps.config.unsetEnv, {
      ...env,
      PENUMBRA_SHELL_SESSION_ID: sessionId,
      PENUMBRA_HANDOFF_ID: handoffId,
    });
  }

  private notifyWaiters(state: SessionState): void {
    const waiters = [...state.waiters];
    state.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  private resetBuffers(state: SessionState): void {
    state.stdoutBuffer = "";
    state.stderrBuffer = "";
    state.stdoutTruncated = false;
    state.stderrTruncated = false;
  }

  private spawnShell(
    cwd: string,
    env: Record<string, string>,
    pty: boolean,
  ): Subprocess<"pipe", "pipe", "pipe"> {
    if (pty) {
      try {
        const spawnWithPty = Bun.spawn as unknown as BunSpawnWithPty;
        return spawnWithPty(["bash", "--norc", "--noprofile", "-i"], {
          cwd,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          pty: true,
        });
      } catch (err) {
        throw new Error(`pty unavailable: ${String(err)}`);
      }
    }

    return Bun.spawn(["bash", "--norc", "--noprofile", "-i"], {
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  private attachProcess(state: SessionState, proc: Subprocess<"pipe", "pipe", "pipe">): void {
    void this.pumpStream(state, proc, proc.stdout, "stdout");
    void this.pumpStream(state, proc, proc.stderr, "stderr");
    void proc.exited.finally(() => {
      if (this.intentionallyKilled.has(proc)) return;
      if (state.proc !== proc) return;
      state.dead = true;
      this.notifyWaiters(state);
      this.deleteSession(state.handoffId, state.sessionId);
    });
  }

  private async bootstrapSession(state: SessionState): Promise<void> {
    void state.proc.stdin.write("unset PROMPT_COMMAND\nPS1=''\nPS2=''\nPS4=''\nexec 3>&2\n");
    await this.sleep(75);
    this.resetBuffers(state);
  }

  private async replaceTimedOutProcess(state: SessionState): Promise<void> {
    if (state.dead || this.handoffs.get(state.handoffId)?.get(state.sessionId) !== state) {
      return;
    }

    const oldProc = state.proc;
    this.intentionallyKilled.add(oldProc);
    try {
      oldProc.kill("SIGTERM");
    } catch {
      // process may already be dead
    }
    await Promise.race([oldProc.exited, this.sleep(100)]);
    if (oldProc.exitCode === null) {
      try {
        oldProc.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
      await Promise.race([oldProc.exited, this.sleep(100)]);
    }

    if (state.dead || this.handoffs.get(state.handoffId)?.get(state.sessionId) !== state) {
      return;
    }

    const proc = this.spawnShell(state.cwd, state.launchEnv, state.pty);
    state.proc = proc;
    this.attachProcess(state, proc);
    await this.bootstrapSession(state);

    if (state.dead || this.handoffs.get(state.handoffId)?.get(state.sessionId) !== state) {
      this.intentionallyKilled.add(proc);
      try {
        proc.kill("SIGKILL");
      } catch {
        // process may already be dead
      }
      return;
    }
  }

  private deleteSession(handoffId: string, sessionId: string): void {
    const sessions = this.handoffs.get(handoffId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.handoffs.delete(handoffId);
    }
  }

  private terminateProcess(proc: Subprocess<"pipe", "pipe", "pipe">): void {
    try {
      proc.kill("SIGTERM");
    } catch {
      // process may already be dead
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private timestamp(): string {
    return (this.deps.now ?? ((): Date => new Date()))().toISOString();
  }
}
