import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildServices, loadSqliteVec, migrate, type Services } from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { ExtraWorkerSupervisor } from "../../src/workers/supervisor.js";
import type { ExtraWorkerConfig } from "../../src/workers/config.js";
import { OrphanHandoffRecoveryService } from "../../src/services/orphan-handoff-recovery.js";
import { handoffsApproveRoute, handoffsCreateRoute } from "../../src/routes/handoffs.js";

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // ignore
}

type FakeSubprocess = {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  killCalls: string[];
  exited: Promise<number>;
  exit: (code: number, signal?: string | null) => void;
  kill: (signal: "SIGTERM" | "SIGKILL") => void;
  stdout: null;
  stderr: null;
};

type FakeReadableStream = {
  getReader: () => {
    read: () => Promise<{
      done: boolean;
      value?: Uint8Array;
    }>;
  };
};

type SpawnCall = {
  args: string[];
  options: {
    stdout: "pipe" | "inherit";
    stderr: "pipe" | "inherit";
    env: Record<string, string | undefined>;
  };
};

const homes: string[] = [];
let previousHome: string | undefined;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const root = mkdtempSync(join(tmpdir(), "penumbra-supervisor-recovery-"));
  return buildServices({
    env: {},
    input: {},
    storageRoot: root,
    worktreeRootDir: join(root, "worktrees"),
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-06-09T20:44:00Z"),
    uuid: (() => {
      let n = 0;
      return () => `e-${++n}`;
    })(),
  });
}

beforeEach(() => {
  previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "penumbra-extra-worker-supervisor-"));
  process.env.HOME = home;
  homes.push(home);
});

afterEach(() => {
  while (homes.length > 0) {
    rmSync(homes.pop()!, { recursive: true, force: true });
  }
  process.env.HOME = previousHome;
});

function createFakeProcess(nextPid: () => number): FakeSubprocess {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });

  const proc: FakeSubprocess = {
    pid: nextPid(),
    exitCode: null,
    signalCode: null,
    killCalls: [],
    exited,
    exit: (code: number, signal: string | null = null) => {
      if (proc.exitCode !== null) return;
      proc.exitCode = code;
      if (signal != null) proc.signalCode = signal;
      exit(code);
    },
    kill: (signal: "SIGTERM" | "SIGKILL") => {
      proc.killCalls.push(signal);
      if (signal === "SIGKILL" && proc.exitCode === null) {
        proc.exit(-9, signal);
      }
      if (signal === "SIGTERM") {
        proc.signalCode = signal;
      }
    },
    stdout: null,
    stderr: null,
  };
  return proc;
}

function createFailingStream(error: Error): FakeReadableStream {
  return {
    getReader: () => ({
      read: async () => {
        throw error;
      },
    }),
  };
}

function createChunkedStream(chunks: Array<Uint8Array | string>): FakeReadableStream {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index >= chunks.length) return { done: true };
        const value = chunks[index++];
        return {
          done: false,
          value: typeof value === "string" ? new TextEncoder().encode(value) : value,
        };
      },
    }),
  };
}

function createSupervisor(
  extras: ExtraWorkerConfig[],
  onSpawn?: (args: string[], options: SpawnCall["options"], proc: FakeSubprocess) => void,
  options?: {
    storageRoot?: string;
    spawnImpl?: (args: string[], options: SpawnCall["options"]) => FakeSubprocess;
  },
) {
  const spawnCalls: SpawnCall[] = [];
  const processes: FakeSubprocess[] = [];
  let pidSeq = 1;
  const spawnImpl = options?.spawnImpl ?? ((_args, _options) => createFakeProcess(() => pidSeq++));
  const spawn = vi.fn((args: string[], options: SpawnCall["options"]) => {
    const proc = spawnImpl(args, options);
    spawnCalls.push({ args, options });
    processes.push(proc);
    onSpawn?.(args, options, proc);
    return proc as unknown as any;
  });
  const warnSpy = vi.fn();
  const log: any = {
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: () => log,
  };
  const supervisor = new ExtraWorkerSupervisor({
    extras,
    storageRoot: options?.storageRoot ?? "/tmp/penumbra-storage",
    log,
    spawn,
  });

  return {
    supervisor,
    spawnCalls,
    processes,
    spawn,
    warnSpy,
    log,
  };
}

describe("extra worker supervisor", () => {
  test("start() with one extra", async () => {
    const { supervisor, spawnCalls } = createSupervisor([
      {
        id: "worker-a",
        concurrency: 6,
        isolation: "hard",
        project_id: "proj-a",
      },
    ]);

    await supervisor.start();

    expect(spawnCalls).toHaveLength(1);
    expect(isAbsolute(spawnCalls[0]!.args[1]!)).toBe(true);
    expect(existsSync(spawnCalls[0]!.args[1]!)).toBe(true);
    expect(spawnCalls[0]!.args).toEqual([
      "bun",
      spawnCalls[0]!.args[1]!,
      "--worker-id",
      "worker-a",
      "--concurrency",
      "6",
      "--storage-root",
      "/tmp/penumbra-storage",
    ]);
    expect(spawnCalls[0]!.options.env).toMatchObject({
      PENUMBRA_WORKER_PROJECT_ID: "proj-a",
      PENUMBRA_WORKER_ISOLATION: "hard",
      PENUMBRA_BOOT_RECONCILE: "0",
      PENUMBRA_STORAGE_ROOT: "/tmp/penumbra-storage",
    });
  });

  test("multiple extras", async () => {
    const { supervisor, spawnCalls, processes } = createSupervisor([
      {
        id: "worker-a",
        concurrency: 2,
        isolation: "shared",
      },
      {
        id: "worker-b",
        concurrency: 4,
        isolation: "sticky",
        project_id: "proj-b",
      },
    ]);

    await supervisor.start();

    expect(spawnCalls).toHaveLength(2);
    expect(processes).toHaveLength(2);
    expect(processes[0]!.pid).not.toBe(processes[1]!.pid);
    const states = (supervisor as any).states as Map<string, { pid: number | null }>;
    expect(states.get("worker-a")?.pid).toBe(processes[0]!.pid);
    expect(states.get("worker-b")?.pid).toBe(processes[1]!.pid);
  });

  test("crash restart with backoff", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes } = createSupervisor([
        { id: "worker-a", concurrency: 4, isolation: "shared" },
      ]);
      await supervisor.start();

      const first = processes[0]!;
      first.exit(1);
      await flushPromises();
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(processes).toHaveLength(2);

      const second = processes[1]!;
      second.exit(1);
      await flushPromises();
      vi.advanceTimersByTime(1999);
      await flushPromises();
      expect(processes).toHaveLength(2);
      vi.advanceTimersByTime(1);
      await flushPromises();
      expect(processes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("crash restart recovers when timer respawn throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      let failNextSpawn = false;
      let pidSeq = 1;
      const { supervisor, processes, log } = createSupervisor(
        [{ id: "worker-a", concurrency: 4, isolation: "shared" }],
        undefined,
        {
          spawnImpl: () => {
            if (failNextSpawn) {
              failNextSpawn = false;
              throw new Error("transient spawn failure");
            }
            return createFakeProcess(() => pidSeq++);
          },
        },
      );
      await supervisor.start();

      const first = processes[0]!;
      failNextSpawn = true;
      first.exit(1);
      await flushPromises();
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      await flushPromises();
      expect(processes).toHaveLength(1);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "extra_worker_spawn_failed",
          worker_id: "worker-a",
          error: "transient spawn failure",
        }),
        "extra worker failed to spawn during restart",
      );

      vi.advanceTimersByTime(1999);
      await flushPromises();
      expect(processes).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await flushPromises();
      expect(processes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("backoff reset after stable lifetime", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes } = createSupervisor([
        { id: "worker-a", concurrency: 1, isolation: "shared" },
      ]);
      await supervisor.start();

      const first = processes[0]!;
      first.exit(1);
      await flushPromises();
      vi.advanceTimersByTime(1000);
      await flushPromises();
      expect(processes).toHaveLength(2);

      vi.advanceTimersByTime(130_000);
      const second = processes[1]!;
      second.exit(1);
      await flushPromises();
      vi.advanceTimersByTime(999);
      await flushPromises();
      expect(processes).toHaveLength(2);
      vi.advanceTimersByTime(1);
      await flushPromises();
      expect(processes).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("backoff caps at 60000ms", async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const { supervisor, processes } = createSupervisor(
        [{ id: "worker-a", concurrency: 1, isolation: "shared" }],
        () => {
          starts.push(Date.now());
        },
      );

      await supervisor.start();
      expect(starts).toHaveLength(1);

      for (let i = 0; i < 10; i += 1) {
        const proc = processes[processes.length - 1]!;
        proc.exit(1);
        await flushPromises();
        const expectedDelay = Math.min(1_000 * 2 ** i, 60_000);
        vi.advanceTimersByTime(expectedDelay - 1);
        await flushPromises();
        expect(processes).toHaveLength(i + 1);
        vi.advanceTimersByTime(1);
        await flushPromises();
        expect(processes).toHaveLength(i + 2);
        const observedDelay = starts[starts.length - 1]! - starts[starts.length - 2]!;
        expect(observedDelay).toBe(expectedDelay);
      }
      const observedDelays = starts.slice(1).map((t, i) => t - starts[i]!);
      expect(observedDelays).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop() sends SIGTERM then SIGKILL when worker ignores SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes } = createSupervisor([
        { id: "worker-a", concurrency: 1, isolation: "shared" },
      ]);
      await supervisor.start();
      const stopPromise = supervisor.stop();
      await flushPromises();
      expect(processes[0]!.killCalls).toContain("SIGTERM");
      vi.advanceTimersByTime(10_000);
      await stopPromise;
      expect(processes[0]!.killCalls).toContain("SIGKILL");
      expect(processes).toHaveLength(1);
      vi.advanceTimersByTime(120_000);
      expect(processes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stop() skips signals when worker already exited", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes } = createSupervisor([
        { id: "worker-a", concurrency: 1, isolation: "shared" },
      ]);
      await supervisor.start();
      processes[0]!.exit(1);
      await flushPromises();
      const stopPromise = supervisor.stop();
      await stopPromise;
      expect(processes[0]!.killCalls).toEqual([]);
      vi.advanceTimersByTime(120_000);
      await flushPromises();
      expect(processes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("PENUMBRA_EXTRA_WORKERS_ENABLED=0 disables start and warns once", async () => {
    const previous = process.env.PENUMBRA_EXTRA_WORKERS_ENABLED;
    process.env.PENUMBRA_EXTRA_WORKERS_ENABLED = "0";
    const { supervisor, spawnCalls, warnSpy } = createSupervisor([
      { id: "worker-a", concurrency: 1, isolation: "shared" },
    ]);
    try {
      await supervisor.start();
      expect(spawnCalls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      process.env.PENUMBRA_EXTRA_WORKERS_ENABLED = previous;
    }
  });

  test("stop() is idempotent", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes } = createSupervisor([
        { id: "worker-a", concurrency: 1, isolation: "shared" },
      ]);
      await supervisor.start();
      const stopPromise = supervisor.stop();
      vi.advanceTimersByTime(10_000);
      await stopPromise;
      await supervisor.stop();
      const proc = processes[0]!;
      expect(proc.killCalls.filter((signal) => signal === "SIGTERM")).toHaveLength(1);
      expect(proc.killCalls.filter((signal) => signal === "SIGKILL")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("empty extras starts without spawning", async () => {
    const { supervisor, spawnCalls } = createSupervisor([]);
    await supervisor.start();
    expect(spawnCalls).toHaveLength(0);
  });

  test("pipeStreamToLog failures are logged and do not crash startup", async () => {
    const { supervisor, log } = createSupervisor(
      [
        {
          id: "worker-a",
          concurrency: 1,
          isolation: "shared",
        },
      ],
      (_args, _options, proc) => {
        (proc as unknown as { stdout: FakeReadableStream }).stdout = createFailingStream(
          new Error("reader failure"),
        );
        (proc as unknown as { stderr: FakeReadableStream }).stderr = createFailingStream(
          new Error("reader failure"),
        );
      },
    );

    await supervisor.start();
    await flushPromises();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "extra_worker_log_pipe_failed",
        worker_id: "worker-a",
        error: "reader failure",
      }),
      "extra worker log pipe failed",
    );
  });

  test("pipeStreamToLog preserves chunk order and flushes the final chunk", async () => {
    const { supervisor } = createSupervisor([
      {
        id: "worker-a",
        concurrency: 1,
        isolation: "shared",
      },
    ]);
    const logPath = join(process.env.HOME!, "ordered.log");
    writeFileSync(logPath, "start");

    await (supervisor as any).pipeStreamToLog(
      createChunkedStream(["-one", "-two", "-three"]),
      logPath,
    );

    expect(readFileSync(logPath, "utf8")).toBe("start-one-two-three");
  });

  test("log directory uses storageRoot", async () => {
    const storageRoot = "/tmp/penumbra-storage-log-dir";
    const { supervisor } = createSupervisor(
      [
        {
          id: "worker-a",
          concurrency: 2,
          isolation: "shared",
        },
      ],
      undefined,
      { storageRoot },
    );

    await supervisor.start();
    expect((supervisor as { logDir: string }).logDir).toBe(join(storageRoot, "workers"));
  });

  test("reconcile() adds extra workers", async () => {
    const { supervisor, spawnCalls } = createSupervisor([
      {
        id: "worker-a",
        concurrency: 2,
        isolation: "shared",
      },
    ]);
    await supervisor.start();
    expect(spawnCalls).toHaveLength(1);

    const summary = await supervisor.reconcile([
      {
        id: "worker-a",
        concurrency: 2,
        isolation: "shared",
      },
      {
        id: "worker-b",
        concurrency: 4,
        isolation: "hard",
      },
    ]);

    expect(summary).toEqual({
      started: ["worker-b"],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    });
    expect(spawnCalls).toHaveLength(2);
  });

  test("reconcile() removes extra workers", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes, spawnCalls } = createSupervisor([
        { id: "worker-a", concurrency: 2, isolation: "shared" },
        { id: "worker-b", concurrency: 2, isolation: "shared" },
      ]);
      await supervisor.start();
      expect(spawnCalls).toHaveLength(2);

      const summaryPromise = supervisor.reconcile([
        { id: "worker-a", concurrency: 2, isolation: "shared" },
      ]);
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      const summary = await summaryPromise;
      expect(summary).toEqual({
        started: [],
        restarted: [],
        stopped: ["worker-b"],
        skipped: [],
        errors: [],
      });
      expect(processes).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconcile() restarts worker when concurrency changes", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, processes, spawnCalls } = createSupervisor([
        { id: "worker-a", concurrency: 4, isolation: "shared" },
      ]);
      await supervisor.start();
      expect(spawnCalls).toHaveLength(1);

      const summaryPromise = supervisor.reconcile([
        { id: "worker-a", concurrency: 8, isolation: "shared" },
      ]);
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      const summary = await summaryPromise;

      expect(summary).toEqual({
        started: [],
        restarted: ["worker-a"],
        stopped: [],
        skipped: [],
        errors: [],
      });
      expect(spawnCalls).toHaveLength(2);
      expect(processes[1]).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconcile() restarts worker when project_id changes", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, spawnCalls } = createSupervisor([
        { id: "worker-a", concurrency: 4, isolation: "shared" },
      ]);
      await supervisor.start();

      const summaryPromise = supervisor.reconcile([
        { id: "worker-a", concurrency: 4, isolation: "shared", project_id: "project-a" },
      ]);
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      const summary = await summaryPromise;

      expect(summary).toEqual({
        started: [],
        restarted: ["worker-a"],
        stopped: [],
        skipped: [],
        errors: [],
      });
      expect(spawnCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconcile() restarts worker when isolation changes", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, spawnCalls } = createSupervisor([
        { id: "worker-a", concurrency: 4, isolation: "hard" },
      ]);
      await supervisor.start();

      const summaryPromise = supervisor.reconcile([
        { id: "worker-a", concurrency: 4, isolation: "shared" },
      ]);
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      const summary = await summaryPromise;

      expect(summary).toEqual({
        started: [],
        restarted: ["worker-a"],
        stopped: [],
        skipped: [],
        errors: [],
      });
      expect(spawnCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconcile() leaves unchanged extras untouched", async () => {
    const { supervisor, spawnCalls } = createSupervisor([
      { id: "worker-a", concurrency: 4, isolation: "shared" },
      { id: "worker-b", concurrency: 2, isolation: "hard", project_id: "project-b" },
    ]);
    await supervisor.start();

    const summary = await supervisor.reconcile([
      { id: "worker-a", concurrency: 4, isolation: "shared" },
      { id: "worker-b", concurrency: 2, isolation: "hard", project_id: "project-b" },
    ]);

    expect(summary).toEqual({
      started: [],
      restarted: [],
      stopped: [],
      skipped: [],
      errors: [],
    });
    expect(spawnCalls).toHaveLength(2);
  });

  test("reconcile() reports spawn errors and skips failed workers", async () => {
    const { supervisor } = createSupervisor(
      [
        { id: "worker-a", concurrency: 4, isolation: "shared" },
        { id: "worker-b", concurrency: 2, isolation: "hard" },
      ],
      undefined,
      {
        spawnImpl: (args) => {
          const isWorkerB = args[3] === "worker-b";
          if (isWorkerB) {
            throw new Error("failed spawn");
          }
          return createFakeProcess(() => 1);
        },
      },
    );
    await supervisor.start();

    const summary = await supervisor.reconcile([
      { id: "worker-a", concurrency: 4, isolation: "shared" },
      { id: "worker-b", concurrency: 2, isolation: "hard" },
    ]);
    expect(summary).toEqual({
      started: [],
      restarted: [],
      stopped: [],
      skipped: ["worker-b"],
      errors: [{ worker_id: "worker-b", message: "failed spawn" }],
    });
  });

  test("reconcile() serializes concurrent updates", async () => {
    const { supervisor, spawnCalls } = createSupervisor([
      { id: "worker-a", concurrency: 4, isolation: "shared" },
    ]);
    await supervisor.start();
    expect(spawnCalls).toHaveLength(1);

    vi.useFakeTimers();
    const first = supervisor.reconcile([{ id: "worker-a", concurrency: 8, isolation: "shared" }]);
    const second = supervisor.reconcile([{ id: "worker-a", concurrency: 8, isolation: "shared" }]);
    vi.advanceTimersByTime(10_000);
    await flushPromises();
    await first;
    await second;
    vi.useRealTimers();

    expect(spawnCalls).toHaveLength(2);
  });

  test("restartWorkerById returns false for unknown worker_id", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor } = createSupervisor([
        { id: "worker-a", concurrency: 1, isolation: "shared" },
      ]);
      await supervisor.start();

      const result = await supervisor.restartWorkerById("does-not-exist");

      expect(result).toBe(false);
      const stopPromise = supervisor.stop();
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      await stopPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  test("restartWorkerById spawns a replacement process for a known worker", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, spawnCalls } = createSupervisor([
        { id: "worker-a", concurrency: 1, isolation: "shared" },
      ]);
      await supervisor.start();
      expect(spawnCalls).toHaveLength(1);

      const restartPromise = supervisor.restartWorkerById("worker-a");
      await flushPromises();
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      const ok = await restartPromise;

      expect(ok).toBe(true);
      expect(spawnCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("restartWorkerById serializes with reconcile — no double spawn when reconcile does not change the worker", async () => {
    vi.useFakeTimers();
    try {
      const extras: ExtraWorkerConfig[] = [{ id: "alpha", concurrency: 4, isolation: "shared" }];
      const { supervisor, spawnCalls } = createSupervisor(extras);
      await supervisor.start();
      expect(spawnCalls).toHaveLength(1);

      const sameExtras: ExtraWorkerConfig[] = [
        { id: "alpha", concurrency: 4, isolation: "shared" },
      ];
      const reconcileP = supervisor.reconcile(sameExtras);
      const restartP = supervisor.restartWorkerById("alpha");
      await flushPromises();
      vi.advanceTimersByTime(10_000);
      await flushPromises();
      await Promise.all([reconcileP, restartP]);

      expect(spawnCalls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("restartWorkerById serializes with a concurrent reconcile — critical sections never overlap", async () => {
    vi.useFakeTimers();
    try {
      const { supervisor, spawnCalls } = createSupervisor([
        { id: "worker-a", concurrency: 4, isolation: "shared" },
      ]);
      await supervisor.start();
      expect(spawnCalls).toHaveLength(1);

      // Instrument restartWorker — the shared inner routine that mutates worker
      // process state. Both lifecycle entry points (reconcile when the worker
      // changed, and restartWorkerById) funnel through it, so an overlap here
      // means the gate let two passes interleave.
      let active = 0;
      let maxConcurrent = 0;
      const originalRestartWorker = (supervisor as any).restartWorker.bind(supervisor);
      (supervisor as any).restartWorker = async function (
        ...args: Parameters<typeof originalRestartWorker>
      ) {
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        try {
          // Yield once so a concurrent caller, if let through, has a chance to
          // enter and bump `active` to 2 before we decrement.
          await flushPromises();
          return await originalRestartWorker(...args);
        } finally {
          active -= 1;
        }
      };

      // Order matters: issue restartWorkerById FIRST so it queues behind the
      // (resolved) gate, then issue a reconcile that mutates the worker. Before
      // the fix, the restart chained off the gate without setting the in-flight
      // flag, and the reconcile took the synchronous-start path concurrently —
      // both ran restartWorker on the same worker in parallel.
      const restartP = supervisor.restartWorkerById("worker-a");
      const reconcileP = supervisor.reconcile([
        { id: "worker-a", concurrency: 8, isolation: "shared" },
      ]);

      // Two stopWorker grace timers will fire in sequence (one per restart),
      // so pump the clock + microtasks repeatedly until both lifecycle calls
      // resolve.
      for (let i = 0; i < 5; i += 1) {
        for (let j = 0; j < 20; j += 1) await flushPromises();
        vi.advanceTimersByTime(10_000);
      }
      for (let j = 0; j < 20; j += 1) await flushPromises();
      await Promise.all([restartP, reconcileP]);

      expect(maxConcurrent).toBe(1);
      expect(spawnCalls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("restartWorkerById returns false and does not throw when spawn fails", async () => {
    const { supervisor } = createSupervisor(
      [{ id: "alpha", concurrency: 4, isolation: "shared" }],
      undefined,
      {
        spawnImpl: () => {
          throw new Error("spawn exploded");
        },
      },
    );
    await supervisor.start();

    const result = await supervisor.restartWorkerById("alpha");

    expect(result).toBe(false);
  });

  test("logs onProcessExit failures instead of leaving an unhandled rejection", async () => {
    const { supervisor, processes, log } = createSupervisor([
      { id: "worker-a", concurrency: 1, isolation: "shared" },
    ]);
    const onProcessExit = vi.fn(async () => {
      throw new Error("boom");
    });
    (supervisor as any).onProcessExit = onProcessExit;

    await supervisor.start();
    processes[0]!.exit(1);
    await flushPromises();
    await flushPromises();

    expect(onProcessExit).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "extra_worker_exit_handler_failed",
        worker_id: "worker-a",
      }),
      "extra worker exit handler failed",
    );
  });

  test("crash recovery only requeues dispatched handoffs that have not started", async () => {
    const services = tempServices();
    const recovery = new OrphanHandoffRecoveryService(services, { staleMs: 0 });
    const supervisor = new ExtraWorkerSupervisor({
      extras: [{ id: "worker-a", concurrency: 1, isolation: "shared" }],
      storageRoot: "/tmp/penumbra-storage",
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        silent: vi.fn(),
        child: () => ({}) as any,
      } as any,
      spawn: (() => {
        let pid = 1;
        const proc = createFakeProcess(() => pid++);
        return vi.fn(() => proc as any);
      })() as any,
      orphanHandoffRecovery: recovery,
    });

    const noStart = await (
      await handoffsCreateRoute(
        new Request("http://x", {
          method: "POST",
          body: JSON.stringify({
            from: "a",
            to: "b",
            message: "m-1",
            conversation_id: "c-1",
            triggered_by_event_id: "e-1",
          }),
        }),
        services,
      )
    ).json();
    const started = await (
      await handoffsCreateRoute(
        new Request("http://x", {
          method: "POST",
          body: JSON.stringify({
            from: "a",
            to: "b",
            message: "m-2",
            conversation_id: "c-2",
            triggered_by_event_id: "e-2",
          }),
        }),
        services,
      )
    ).json();

    await handoffsApproveRoute(
      new Request("http://x", { method: "POST", body: "{}" }),
      noStart.handoff_id,
      services,
    );
    await handoffsApproveRoute(
      new Request("http://x", { method: "POST", body: "{}" }),
      started.handoff_id,
      services,
    );

    services.handoffWriter.claimDispatch(noStart.handoff_id, "worker-a");
    services.handoffWriter.claimDispatch(started.handoff_id, "worker-a");
    services.dispatchEventLog.record({
      handoff_id: started.handoff_id,
      worker_id: "worker-a",
      source: "worker",
      kind: "dispatch.start",
      ts: services.clock().toISOString(),
      meta: null,
    });

    await supervisor.start();
    const proc = (supervisor as any).states.get("worker-a").proc as FakeSubprocess;
    proc.exit(1);
    await flushPromises();
    await flushPromises();

    const requeued = services.handoffReader.get(noStart.handoff_id);
    const stillDispatched = services.handoffReader.get(started.handoff_id);
    expect(requeued?.status).toBe("approved");
    expect(requeued?.worker_id).toBeNull();
    expect(stillDispatched?.status).toBe("dispatched");
    expect(stillDispatched?.worker_id).toBe("worker-a");

    const events = services.dispatchEventLog.listByHandoff(noStart.handoff_id);
    expect(events.some((event) => event.kind === "worker.recovery.requeued")).toBe(true);
    expect(
      services.dispatchEventLog
        .listByHandoff(started.handoff_id)
        .some((event) => event.kind === "worker.recovery.requeued"),
    ).toBe(false);
  });
});
