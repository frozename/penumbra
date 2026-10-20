import type { Logger } from "@penumbra/core";

import { existsSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join, resolve as pathResolve } from "node:path";

import type { OrphanHandoffRecoveryService } from "../services/orphan-handoff-recovery.js";
import type { ExtraWorkerConfig } from "./config.js";

const STABLE_WORKER_LIFETIME_MS = 120_000;
const BASE_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 60_000;
const STOP_GRACE_MS = 10_000;
const DEFAULT_WORKER_ENTRY = pathResolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "agentchat",
  "bin",
  "agentchat-worker.ts",
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
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

type SpawnFunction = (
  args: string[],
  options: {
    stdout: "pipe";
    stderr: "pipe";
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
  errors: { worker_id: string; message: string }[];
};

export interface ExtraWorkerSupervisorOptions {
  extras: ExtraWorkerConfig[];
  storageRoot: string;
  log: Logger;
  spawn?: SpawnFunction;
  workerEntryPath?: string;
  onConfigChange?: (extras: ExtraWorkerConfig[]) => void;
  // Intentionally unwired in serve(): this callback has no boot bound or
  // terminal-outbox drain and could rerun finished turns. F3b must use worker
  // boot reconciliation before extra-worker recovery can be enabled.
  orphanHandoffRecovery?: Pick<OrphanHandoffRecoveryService, "recoverForWorker">;
}

// SDK gap: Bun.spawn returns a Bun-specific Subprocess type that isn't part of
// the @types/bun shape we depend on here. The structural ExtraWorkerSubprocess
// captures only the surface we actually use; the single `as unknown as`
// crosses that documented gap once, inside this typed factory.
type BunSpawn = (
  args: string[],
  options: {
    stdout: "pipe";
    stderr: "pipe";
    env: Record<string, string | undefined>;
  },
) => unknown;

function defaultSpawn(
  args: string[],
  options: {
    stdout: "pipe";
    stderr: "pipe";
    env: Record<string, string | undefined>;
  },
): ExtraWorkerSubprocess {
  const spawn = Bun.spawn as unknown as BunSpawn;
  return spawn(args, options) as ExtraWorkerSubprocess;
}

export class ExtraWorkerSupervisor {
  private extras: ExtraWorkerConfig[];
  private readonly storageRoot: string;
  private readonly log: Logger;
  private readonly spawnWorkerProcess: SpawnFunction;
  private readonly logDir: string;
  private readonly workerEntryPath: string;
  private readonly onConfigChange?: (extras: ExtraWorkerConfig[]) => void;
  private readonly orphanHandoffRecovery?: Pick<OrphanHandoffRecoveryService, "recoverForWorker">;
  private logDirEnsured = false;
  private readonly states = new Map<string, ExtraWorkerProcessState>();
  private reconcileGate = Promise.resolve();
  private lifecycleInFlight = false;
  private started = false;
  private stopped = false;

  constructor(opts: ExtraWorkerSupervisorOptions) {
    this.extras = opts.extras;
    this.storageRoot = opts.storageRoot;
    this.log = opts.log;
    this.spawnWorkerProcess = opts.spawn ?? defaultSpawn;
    this.logDir = join(this.storageRoot, "workers");
    this.workerEntryPath = opts.workerEntryPath ?? DEFAULT_WORKER_ENTRY;
    this.onConfigChange = opts.onConfigChange;
    this.orphanHandoffRecovery = opts.orphanHandoffRecovery;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.started) return Promise.resolve();
    if (process.env.PENUMBRA_EXTRA_WORKERS_ENABLED === "0") {
      this.log.warn("extra workers disabled by PENUMBRA_EXTRA_WORKERS_ENABLED=0");
      this.started = true;
      return Promise.resolve();
    }

    this.started = true;
    for (const extra of this.extras) {
      try {
        this.spawnExtraWorker(extra);
      } catch (err: unknown) {
        this.log.error(
          {
            event: "extra_worker_spawn_failed",
            worker_id: extra.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "extra worker failed to spawn during start",
        );
      }
    }
    return Promise.resolve();
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
    return this.runLifecycleSerial(() => this.reconcileUnlocked(nextExtras));
  }

  // Single mutex for every lifecycle entry point (reconcile + restartWorkerById).
  // Sync-start when nothing is in flight so callers (and tests using fake timers)
  // can rely on internal setTimeouts being scheduled before they advance the clock;
  // otherwise chain behind the gate so concurrent entry points serialize.
  private runLifecycleSerial<T>(work: () => Promise<T>): Promise<T> {
    if (!this.lifecycleInFlight) {
      this.lifecycleInFlight = true;
      let run: Promise<T>;
      try {
        run = work();
      } catch (err) {
        this.lifecycleInFlight = false;
        throw err;
      }
      this.reconcileGate = run.then(
        () => undefined,
        () => undefined,
      );
      void run.finally(() => {
        this.lifecycleInFlight = false;
      });
      return run;
    }
    const prevGate = this.reconcileGate;
    const run = prevGate.then(async () => {
      this.lifecycleInFlight = true;
      try {
        return await work();
      } finally {
        this.lifecycleInFlight = false;
      }
    });
    this.reconcileGate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private trySpawnNew(nextExtra: ExtraWorkerConfig, summary: ReconcileSummary): void {
    try {
      this.spawnExtraWorker(nextExtra);
      summary.started.push(nextExtra.id);
    } catch (err: unknown) {
      summary.skipped.push(nextExtra.id);
      summary.errors.push({
        worker_id: nextExtra.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async tryRestartChanged(
    nextExtra: ExtraWorkerConfig,
    summary: ReconcileSummary,
  ): Promise<void> {
    try {
      await this.restartWorker(nextExtra);
      summary.restarted.push(nextExtra.id);
    } catch (err: unknown) {
      summary.skipped.push(nextExtra.id);
      summary.errors.push({
        worker_id: nextExtra.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private syncWorkerOrPlanRestart(
    nextExtra: ExtraWorkerConfig,
    current: ExtraWorkerConfig | undefined,
    summary: ReconcileSummary,
  ): boolean {
    const existingState = this.states.get(nextExtra.id);
    const alreadyRunning = existingState?.proc !== null && existingState?.proc !== undefined;
    if (!current || !alreadyRunning) {
      this.trySpawnNew(nextExtra, summary);
      return false;
    }
    return this.isWorkerChanged(current, nextExtra);
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
      const needsRestart = this.syncWorkerOrPlanRestart(nextExtra, currentById.get(id), summary);
      if (needsRestart) await this.tryRestartChanged(nextExtra, summary);
    }

    for (const [id, state] of this.states) {
      if (nextById.has(id)) continue;
      if (state.restartTimer) {
        clearTimeout(state.restartTimer);
        state.restartTimer = null;
      }
      if (state.proc) await this.stopWorker(state);
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

  public restartWorkerById(workerId: string): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return this.runLifecycleSerial(() => this.restartWorkerByIdUnlocked(workerId));
  }

  private async restartWorkerByIdUnlocked(workerId: string): Promise<boolean> {
    if (this.stopped) return false;
    const next = this.extras.find((extra) => extra.id === workerId);
    if (!next) return false;
    try {
      await this.restartWorker(next);
      return true;
    } catch (err) {
      this.log.warn(
        {
          event: "restart_worker_by_id_failed",
          worker_id: workerId,
          error: err instanceof Error ? err.message : String(err),
        },
        "restartWorkerById failed",
      );
      return false;
    }
  }

  private isWorkerChanged(current: ExtraWorkerConfig, next: ExtraWorkerConfig): boolean {
    return (
      current.concurrency !== next.concurrency ||
      current.project_id !== next.project_id ||
      current.isolation !== next.isolation
    );
  }

  private async stopWorker(state: ExtraWorkerProcessState): Promise<void> {
    if (!state.proc) return;
    const proc = state.proc;
    state.proc = null;
    state.alive = false;
    if (proc.exitCode !== null) {
      await proc.exited.catch(() => undefined);
      state.pid = null;
      return;
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already exited */
    }
    const exited = await this.waitForExitOrTimeout(proc, STOP_GRACE_MS);
    if (exited) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    await proc.exited.catch(() => undefined);
    state.pid = null;
  }

  private async stopAfterWait(proc: ExtraWorkerSubprocess, timeoutMs: number): Promise<boolean> {
    const finished = await Promise.race([
      proc.exited.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
    return finished;
  }

  private waitForExitOrTimeout(proc: ExtraWorkerSubprocess, timeoutMs: number): Promise<boolean> {
    return this.stopAfterWait(proc, timeoutMs);
  }

  private getOrInitWorkerState(workerId: string): ExtraWorkerProcessState {
    return (
      this.states.get(workerId) ?? {
        pid: null,
        restartCount: 0,
        lastStartedAt: 0,
        restartTimer: null,
        alive: false,
        proc: null,
      }
    );
  }

  private wireWorkerProcessLifecycle(
    extra: ExtraWorkerConfig,
    proc: ExtraWorkerSubprocess,
    state: ExtraWorkerProcessState,
    logPath: string,
  ): void {
    this.pipeStreamToLog(proc.stdout, logPath).catch((err: unknown) => {
      this.log.error(
        {
          event: "extra_worker_log_pipe_failed",
          worker_id: extra.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "extra worker log pipe failed",
      );
    });
    this.pipeStreamToLog(proc.stderr, logPath).catch((err: unknown) => {
      this.log.error(
        {
          event: "extra_worker_log_pipe_failed",
          worker_id: extra.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "extra worker log pipe failed",
      );
    });

    const describeError = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (value instanceof Error) return value.message;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return "[unserializable]";
      }
    };

    const handleExit = (exitErr: unknown): void => {
      this.onProcessExit(extra, proc, state).catch((handlerErr: unknown) => {
        this.log.error(
          {
            event: "extra_worker_exit_handler_failed",
            worker_id: extra.id,
            error: describeError(handlerErr),
            exit_error: describeError(exitErr),
          },
          "extra worker exit handler failed",
        );
      });
    };

    void proc.exited.then(
      () => {
        handleExit(undefined);
      },
      (err: unknown) => {
        handleExit(err);
      },
    );
  }

  private spawnExtraWorker(extra: ExtraWorkerConfig): void {
    const logPath = join(this.logDir, `${extra.id}.log`);
    const state = this.getOrInitWorkerState(extra.id);
    const args = [
      "bun",
      this.workerEntryPath,
      "--worker-id",
      extra.id,
      "--concurrency",
      String(extra.concurrency),
      "--storage-root",
      this.storageRoot,
    ];

    const proc = this.spawnWorkerProcess(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PENUMBRA_WORKER_PROJECT_ID: extra.project_id ?? "",
        PENUMBRA_WORKER_ISOLATION: extra.isolation,
        PENUMBRA_BOOT_RECONCILE: "0",
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

    this.wireWorkerProcessLifecycle(extra, proc, state, logPath);
  }

  private onProcessExit(
    extra: ExtraWorkerConfig,
    proc: ExtraWorkerSubprocess,
    state: ExtraWorkerProcessState,
  ): Promise<void> {
    if (state.proc !== proc) return Promise.resolve();
    state.alive = false;

    if (this.stopped) return Promise.resolve();
    const failed = proc.exitCode !== 0 || proc.signalCode !== null;
    if (!failed) return Promise.resolve();

    if (Date.now() - state.lastStartedAt >= STABLE_WORKER_LIFETIME_MS) {
      state.restartCount = 0;
    }
    const delay = this.scheduleExtraWorkerRestart(extra, state);

    this.log.warn(
      {
        event: "extra_worker_crashed",
        worker_id: extra.id,
        delay_ms: delay,
        code: proc.exitCode,
        signal: proc.signalCode ?? undefined,
      },
      "extra worker crashed; scheduling restart",
    );

    if (this.orphanHandoffRecovery) {
      this.orphanHandoffRecovery.recoverForWorker(extra.id, { workerKnownDead: true });
    }
    return Promise.resolve();
  }

  private scheduleExtraWorkerRestart(
    extra: ExtraWorkerConfig,
    state: ExtraWorkerProcessState,
  ): number {
    const delay = Math.min(MAX_RESTART_DELAY_MS, BASE_RESTART_DELAY_MS * 2 ** state.restartCount);
    state.restartCount += 1;

    if (state.restartTimer) {
      clearTimeout(state.restartTimer);
    }
    state.restartTimer = setTimeout(() => {
      if (this.stopped) return;
      state.restartTimer = null;
      try {
        this.spawnExtraWorker(extra);
      } catch (err: unknown) {
        this.log.error(
          {
            event: "extra_worker_spawn_failed",
            worker_id: extra.id,
            error: err instanceof Error ? err.message : String(err),
          },
          "extra worker failed to spawn during restart",
        );
        this.scheduleExtraWorkerRestart(extra, state);
      }
    }, delay);

    return delay;
  }

  private async pipeStreamToLog(
    stream: ReadableStream<Uint8Array> | null | undefined,
    path: string,
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.length === 0) continue;
      try {
        await appendFile(path, chunk.value);
      } catch {
        // log writes are best-effort; failures are intentionally swallowed
      }
    }
  }

  getKnownWorkerIds(): string[] {
    return [...this.states.keys()];
  }
}
