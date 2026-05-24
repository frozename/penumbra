import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { type Logger } from '@penumbra/core';
import type { ExtraWorkerConfig } from './config.js';

const STABLE_WORKER_LIFETIME_MS = 120_000;
const BASE_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 60_000;
const STOP_GRACE_MS = 10_000;
const DEFAULT_WORKER_ENTRY = pathResolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'agentchat',
  'bin',
  'agentchat-worker.ts',
);
if (!existsSync(DEFAULT_WORKER_ENTRY)) {
  throw new Error(`extra worker entry not found: ${DEFAULT_WORKER_ENTRY}`);
}

type ExtraWorkerSubprocess = {
  pid: number | null;
  exitCode: number | null;
  signalCode?: string | null;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number | { code: number; signal?: string }>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
};

type SpawnFunction = (
  args: string[],
  options: {
    stdout: 'pipe';
    stderr: 'pipe';
    env: Record<string, string | undefined>;
  },
) => ExtraWorkerSubprocess;

type ExtraWorkerProcessState = {
  pid: number | null;
  restartCount: number;
  lastStartedAt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
  proc: ExtraWorkerSubprocess | null;
};

export interface ExtraWorkerSupervisorOptions {
  extras: ExtraWorkerConfig[];
  storageRoot: string;
  log: Logger;
  spawn?: SpawnFunction;
  workerEntryPath?: string;
}

export class ExtraWorkerSupervisor {
  private readonly extras: ExtraWorkerConfig[];
  private readonly storageRoot: string;
  private readonly log: Logger;
  private readonly spawnWorkerProcess: SpawnFunction;
  private readonly logDir: string;
  private readonly workerEntryPath: string;
  private logDirEnsured = false;
  private readonly states: Map<string, ExtraWorkerProcessState> = new Map();
  private started = false;
  private stopped = false;

  constructor(opts: ExtraWorkerSupervisorOptions) {
    this.extras = opts.extras;
    this.storageRoot = opts.storageRoot;
    this.log = opts.log;
    this.spawnWorkerProcess = opts.spawn ?? ((args, options) =>
      Bun.spawn(args as any, options) as unknown as ExtraWorkerSubprocess
    );
    this.logDir = join(homedir(), '.penumbra', 'workers');
    this.workerEntryPath = opts.workerEntryPath ?? DEFAULT_WORKER_ENTRY;
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    if (this.started) return;
    if (process.env.PENUMBRA_EXTRA_WORKERS_ENABLED === '0') {
      this.log.warn('extra workers disabled by PENUMBRA_EXTRA_WORKERS_ENABLED=0');
      this.started = true;
      return;
    }

    this.started = true;
    for (const extra of this.extras) {
      this.spawnExtraWorker(extra);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const stopPromises: Promise<void>[] = [];
    for (const [, state] of this.states) {
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.proc) {
        stopPromises.push(this.stopWorker(state));
      }
      state.alive = false;
    }
    await Promise.all(stopPromises);
  }

  private async stopWorker(state: ExtraWorkerProcessState): Promise<void> {
    if (!state.proc) return;
    const proc = state.proc;
    if (proc.exitCode !== null) {
      await proc.exited.catch(() => {});
      return;
    }
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    const exited = await this.waitForExitOrTimeout(proc, STOP_GRACE_MS);
    if (exited) return;
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    await proc.exited.catch(() => {});
  }

  private async stopAfterWait(proc: ExtraWorkerSubprocess, timeoutMs: number): Promise<boolean> {
    const finished = await Promise.race([
      proc.exited.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return finished;
  }

  private waitForExitOrTimeout(proc: ExtraWorkerSubprocess, timeoutMs: number): Promise<boolean> {
    return this.stopAfterWait(proc, timeoutMs);
  }

  private spawnExtraWorker(extra: ExtraWorkerConfig): void {
    const logPath = join(this.logDir, `${extra.id}.log`);
    const state = this.states.get(extra.id) ?? {
      pid: null,
      restartCount: 0,
      lastStartedAt: 0,
      restartTimer: null,
      alive: false,
      proc: null,
    };
    const args = [
      'bun',
      this.workerEntryPath,
      '--worker-id',
      extra.id,
      '--concurrency',
      String(extra.concurrency),
      '--storage-root',
      this.storageRoot,
    ];

    const proc = this.spawnWorkerProcess(args, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PENUMBRA_WORKER_PROJECT_ID: extra.project_id ?? '',
        PENUMBRA_WORKER_ISOLATION: extra.isolation,
        PENUMBRA_STORAGE_ROOT: this.storageRoot,
      },
    });
    state.proc = proc;
    state.pid = proc.pid;
    state.lastStartedAt = Date.now();
    state.alive = true;

    if (proc.exitCode === null && state.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    this.states.set(extra.id, state);

    if (!this.logDirEnsured) {
      mkdirSync(this.logDir, { recursive: true });
      this.logDirEnsured = true;
    }
    this.pipeStreamToLog(proc.stdout, logPath);
    this.pipeStreamToLog(proc.stderr, logPath);

    void proc.exited.then(() => {
      void this.onProcessExit(extra, proc, state);
    }).catch(() => {
      void this.onProcessExit(extra, proc, state);
    });
  }

  private async onProcessExit(
    extra: ExtraWorkerConfig,
    proc: ExtraWorkerSubprocess,
    state: ExtraWorkerProcessState,
  ): Promise<void> {
    if (state.proc !== proc) return;
    state.alive = false;

    if (this.stopped) return;
    const failed = proc.exitCode !== 0 || proc.signalCode != null;
    if (!failed) return;

    if (Date.now() - state.lastStartedAt >= STABLE_WORKER_LIFETIME_MS) {
      state.restartCount = 0;
    }
    const delay = Math.min(MAX_RESTART_DELAY_MS, BASE_RESTART_DELAY_MS * 2 ** state.restartCount);
    state.restartCount += 1;

    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
    }
    state.restartTimer = setTimeout(() => {
      if (this.stopped) return;
      state.restartTimer = null;
      this.spawnExtraWorker(extra);
    }, delay);

    this.log.warn(
      {
        event: 'extra_worker_crashed',
        worker_id: extra.id,
        delay_ms: delay,
        code: proc.exitCode,
        signal: proc.signalCode ?? undefined,
      },
      'extra worker crashed; scheduling restart',
    );
  }

  private async pipeStreamToLog(stream: ReadableStream<Uint8Array> | null | undefined, path: string): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value || chunk.value.length === 0) continue;
      try {
        appendFileSync(path, chunk.value);
      } catch {}
    }
  }
}
