import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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

export type ReconcileSummary = {
  started: string[];
  restarted: string[];
  stopped: string[];
  skipped: string[];
  errors: Array<{ worker_id: string; message: string }>;
};

export interface ExtraWorkerSupervisorOptions {
  extras: ExtraWorkerConfig[];
  storageRoot: string;
  log: Logger;
  spawn?: SpawnFunction;
  workerEntryPath?: string;
  onConfigChange?: (extras: ExtraWorkerConfig[]) => void;
}

export class ExtraWorkerSupervisor {
  private extras: ExtraWorkerConfig[];
  private readonly storageRoot: string;
  private readonly log: Logger;
  private readonly spawnWorkerProcess: SpawnFunction;
  private readonly logDir: string;
  private readonly workerEntryPath: string;
  private readonly onConfigChange?: (extras: ExtraWorkerConfig[]) => void;
  private logDirEnsured = false;
  private readonly states: Map<string, ExtraWorkerProcessState> = new Map();
  private reconcileGate = Promise.resolve();
  private reconcileInFlight = false;
  private started = false;
  private stopped = false;

  constructor(opts: ExtraWorkerSupervisorOptions) {
    this.extras = opts.extras;
    this.storageRoot = opts.storageRoot;
    this.log = opts.log;
    this.spawnWorkerProcess = opts.spawn ?? ((args, options) =>
      Bun.spawn(args as any, options) as unknown as ExtraWorkerSubprocess
    );
    this.logDir = join(this.storageRoot, 'workers');
    this.workerEntryPath = opts.workerEntryPath ?? DEFAULT_WORKER_ENTRY;
    this.onConfigChange = opts.onConfigChange;
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
      try {
        this.spawnExtraWorker(extra);
      } catch (err: unknown) {
        this.log.error(
          {
            event: 'extra_worker_spawn_failed',
            worker_id: extra.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'extra worker failed to spawn during start',
        );
      }
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

  public reconcile(nextExtras: ExtraWorkerConfig[]): Promise<ReconcileSummary> {
    // Start the new pass synchronously when no prior pass is in flight so callers
    // (and tests using fake timers) can rely on internal setTimeouts being
    // scheduled before they advance the clock. When a prior pass IS in flight,
    // chain off the gate to preserve serialization.
    const prevGate = this.reconcileGate;
    if (this.reconcileInFlight) {
      const run = prevGate.then(() => this.reconcileUnlocked(nextExtras));
      this.reconcileGate = run.then(() => undefined, () => undefined);
      return run;
    }
    this.reconcileInFlight = true;
    const run = this.reconcileUnlocked(nextExtras);
    this.reconcileGate = run.then(() => undefined, () => undefined);
    run.finally(() => { this.reconcileInFlight = false; });
    return run;
  }

  private async reconcileUnlocked(nextExtras: ExtraWorkerConfig[]): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    };
    if (this.stopped) return summary;

    const currentById = new Map(this.extras.map((extra) => [extra.id, extra]));
    const nextById = new Map(nextExtras.map((extra) => [extra.id, extra]));

    for (const [id, nextExtra] of nextById) {
      const current = currentById.get(id);
      const alreadyRunning = this.states.get(id)?.proc != null;
      if (!current || !alreadyRunning) {
        try {
          this.spawnExtraWorker(nextExtra);
          summary.started.push(id);
        } catch (err: unknown) {
          summary.skipped.push(id);
          summary.errors.push({
            worker_id: id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      if (this.isWorkerChanged(current, nextExtra)) {
        try {
          await this.restartWorker(nextExtra);
          summary.restarted.push(id);
        } catch (err: unknown) {
          summary.skipped.push(id);
          summary.errors.push({
            worker_id: id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const [id, state] of this.states) {
      if (nextById.has(id)) continue;
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.proc) {
        await this.stopWorker(state);
      }
      this.states.delete(id);
      summary.stopped.push(id);
    }

    this.extras = [...nextExtras];
    this.onConfigChange?.(this.extras);
    return summary;
  }

  private async restartWorker(nextExtra: ExtraWorkerConfig): Promise<void> {
    const state = this.states.get(nextExtra.id);
    if (state?.restartTimer) {
      clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state?.proc) {
      await this.stopWorker(state);
      state.proc = null;
    }

    this.spawnExtraWorker(nextExtra);
  }

  private isWorkerChanged(current: ExtraWorkerConfig, next: ExtraWorkerConfig): boolean {
    return current.concurrency !== next.concurrency
      || current.project_id !== next.project_id
      || current.isolation !== next.isolation;
  }

  private async stopWorker(state: ExtraWorkerProcessState): Promise<void> {
    if (!state.proc) return;
    const proc = state.proc;
    state.proc = null;
    state.alive = false;
    if (proc.exitCode !== null) {
      await proc.exited.catch(() => {});
      state.pid = null;
      return;
    }
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    const exited = await this.waitForExitOrTimeout(proc, STOP_GRACE_MS);
    if (exited) return;
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    await proc.exited.catch(() => {});
    state.pid = null;
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
    this.pipeStreamToLog(proc.stdout, logPath).catch((err) => {
      this.log.error(
        {
          event: 'extra_worker_log_pipe_failed',
          worker_id: extra.id,
          error: err instanceof Error ? err.message : String(err),
        },
        'extra worker log pipe failed',
      );
    });
    this.pipeStreamToLog(proc.stderr, logPath).catch((err) => {
      this.log.error(
        {
          event: 'extra_worker_log_pipe_failed',
          worker_id: extra.id,
          error: err instanceof Error ? err.message : String(err),
        },
        'extra worker log pipe failed',
      );
    });

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
