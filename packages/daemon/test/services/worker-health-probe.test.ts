import { afterEach, expect, test, vi } from "bun:test";

import {
  createWorkerHealthController,
  type WorkerHealthController,
  type WorkerHealthControllerDeps,
  WorkerHealthProbe,
  type WorkerHealthSignal,
} from "../../src/services/worker-health-probe.js";

type ProbeConstructorOpts = ConstructorParameters<typeof WorkerHealthProbe>[0];
type ProbeServices = ProbeConstructorOpts["services"];
type ProbeLog = ProbeConstructorOpts["log"];

interface ControlEvent {
  type: string;
  worker_id: string;
  probe_id: string;
}

interface BuildServicesResult {
  services: ProbeServices;
  controlEvents: ControlEvent[];
  signals: WorkerHealthSignal[];
  recoverEventLog: string[];
  controller: { onSignal: (signal: WorkerHealthSignal) => void };
}

const noopLog = (): void => undefined;

const makeLogStub = (): ProbeLog => {
  const stub = {
    error: noopLog,
    warn: noopLog,
    info: noopLog,
    debug: noopLog,
    child: (): {
      error: () => void;
      warn: () => void;
      info: () => void;
      debug: () => void;
    } => ({
      error: noopLog,
      warn: noopLog,
      info: noopLog,
      debug: noopLog,
    }),
  };
  // Test-only logger stub; cast bridges the partial mock to the full Logger contract.
  return stub as unknown as ProbeLog;
};

const buildServices = (
  overrides: { workerIds?: string[]; clock?: () => Date } = {},
): BuildServicesResult => {
  const workerIds = overrides.workerIds ?? ["worker-a"];
  const controlEvents: ControlEvent[] = [];
  const signals: WorkerHealthSignal[] = [];
  const recoverEventLog: string[] = [];

  let uuidSeed = 0;

  const servicesStub = {
    extraWorkerSupervisor: {
      getKnownWorkerIds: (): string[] => [...workerIds],
    },
    workerControl: {
      emit: (event: ControlEvent): void => {
        if (event.type === "ping") {
          controlEvents.push(event);
        }
      },
    },
    clock: overrides.clock ?? ((): Date => new Date()),
    log: makeLogStub(),
    uuid: (): string => `uuid-${String(++uuidSeed)}`,
  };

  // Test-only Services stub; cast covers the full Services surface the probe does not touch.
  const services = servicesStub as unknown as ProbeServices;

  const controller = {
    onSignal: (signal: WorkerHealthSignal): void => {
      signals.push(signal);
      recoverEventLog.push(signal.worker_id);
    },
  };

  return { services, controlEvents, signals, recoverEventLog, controller };
};

const flushPending = async (): Promise<void> => {
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  process.env.PENUMBRA_WORKER_PROBE_ENABLED = undefined;
});

test("tick emits one ping with unique probe_id and worker_id", async () => {
  vi.useFakeTimers();
  const { services, controlEvents, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 50,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(50);
  await flushPending();
  expect(controlEvents).toHaveLength(1);
  expect(controlEvents[0]).toMatchObject({ type: "ping", worker_id: "worker-a" });
  expect(controlEvents[0].probe_id).toContain("uuid-");

  advance(100);
  await flushPending();

  expect(controlEvents).toHaveLength(3);
  expect(controlEvents[0]).toMatchObject({ type: "ping", worker_id: "worker-a" });
  expect(controlEvents[0].probe_id).toContain("uuid-");
});

test("ACK clears pending + resets miss count", async () => {
  vi.useFakeTimers();
  const { services, controlEvents, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(100);
  await flushPending();
  expect(controlEvents).toHaveLength(1);
  const firstProbe = controlEvents.at(-1)!.probe_id;

  expect(probe.recordAck("worker-a", firstProbe)).toBe(true);
  advance(200);
  await flushPending();

  expect(probe.getMissCount("worker-a")).toBe(0);
});

test("no ACK increments miss count", async () => {
  vi.useFakeTimers();
  const { services, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(300);
  await flushPending();

  expect(probe.getMissCount("worker-a")).toBe(1);
});

test("3 consecutive misses triggers eviction and notifies controller", async () => {
  vi.useFakeTimers();
  const { services, signals, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(500);
  await flushPending();

  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    worker_id: "worker-a",
    misses: 3,
    probe_interval_ms: 100,
  });
});

test("ACK at miss=2 resets to 0; next miss is 1", async () => {
  vi.useFakeTimers();
  const { services, signals, controlEvents, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(400);
  await flushPending();
  expect(controlEvents.length).toBe(4);

  expect(probe.getMissCount("worker-a")).toBe(2);
  expect(signals).toHaveLength(0);

  const latestProbe = controlEvents.at(-1)!.probe_id;
  probe.recordAck("worker-a", latestProbe);
  expect(probe.getMissCount("worker-a")).toBe(0);

  advance(100);
  await flushPending();
  expect(probe.getMissCount("worker-a")).toBe(1);
  expect(signals).toHaveLength(0);
});

test("prune() clears state for removed workers so stale misses do not leak on re-add", async () => {
  vi.useFakeTimers();
  const { services, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(400);
  await flushPending();
  expect(probe.getMissCount("worker-a")).toBe(2);

  probe.prune([]);
  expect(probe.getMissCount("worker-a")).toBe(0);

  advance(300);
  await flushPending();
  expect(probe.getMissCount("worker-a")).toBe(1);
});

test("PENUMBRA_WORKER_PROBE_ENABLED=0 makes start a no-op", async () => {
  process.env.PENUMBRA_WORKER_PROBE_ENABLED = "0";
  vi.useFakeTimers();
  const { services, controlEvents, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 50,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(500);
  await flushPending();

  expect(controlEvents).toHaveLength(0);
});

test("unknown probe_id in recordAck does not throw and does not reset miss count", async () => {
  vi.useFakeTimers();
  const { services, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log: services.log,
  });

  probe.start();
  advance(300);
  await flushPending();

  expect(probe.getMissCount("worker-a")).toBe(1);
  expect(probe.recordAck("worker-a", "bogus-id")).toBe(false);
  expect(probe.getMissCount("worker-a")).toBe(1);
});

test("concurrent probes emit per worker and ACK only touches that worker", async () => {
  vi.useFakeTimers();
  const { services, controlEvents, signals, controller } = buildServices({
    workerIds: ["worker-a", "worker-b"],
  });
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 5,
    controller,
    log: services.log,
  });

  probe.start();
  advance(100);
  await flushPending();
  expect(controlEvents.filter((event) => event.worker_id === "worker-a")).toHaveLength(1);
  expect(controlEvents.filter((event) => event.worker_id === "worker-b")).toHaveLength(1);

  advance(300);
  await flushPending();
  const workerAProbe = controlEvents
    .filter((event) => event.worker_id === "worker-a")
    .at(-1)!.probe_id;
  expect(probe.getMissCount("worker-a")).toBe(2);
  expect(probe.getMissCount("worker-b")).toBe(2);
  expect(probe.recordAck("worker-a", workerAProbe)).toBe(true);
  expect(probe.getMissCount("worker-a")).toBe(0);

  advance(100);
  await flushPending();

  expect(probe.getMissCount("worker-a")).toBe(1);
  expect(probe.getMissCount("worker-b")).toBe(3);
  expect(signals).toHaveLength(0);
});

interface RecordedDispatchRow {
  kind: string;
  worker_id: string;
  probe_id: string;
  misses: number;
  event: string;
}

test("default worker health controller evicts wedged worker before orphan recovery on threshold miss", async () => {
  const recorded: RecordedDispatchRow[] = [];
  const recovered: string[] = [];
  const actions: string[] = [];
  const knownWorkers = new Set<string>(["worker-a"]);

  const deps: WorkerHealthControllerDeps = {
    extraWorkerSupervisor: {
      restartWorkerById: (workerId: string): Promise<boolean> => {
        actions.push(`restart:${workerId}`);
        knownWorkers.delete(workerId);
        return Promise.resolve(true);
      },
    },
    dispatchEventLog: {
      record: (event): void => {
        recorded.push({
          kind: event.kind,
          worker_id: event.worker_id,
          probe_id: event.meta.probe_id,
          misses: event.meta.misses,
          event: event.meta.event,
        });
      },
    },
    orphanHandoffRecovery: {
      recoverForWorker: (
        workerId: string,
        opts?: { workerKnownDead?: boolean },
      ): {
        requeued: number;
        exhausted: number;
        requeuedRowIds: string[];
        exhaustedRowIds: string[];
        _requeuedRows: unknown[];
        _exhaustedRows: unknown[];
      } => {
        actions.push(`recover:${workerId}:${String(Boolean(opts?.workerKnownDead))}`);
        recovered.push(workerId);
        return {
          requeued: 0,
          exhausted: 0,
          requeuedRowIds: [],
          exhaustedRowIds: [],
          _requeuedRows: [],
          _exhaustedRows: [],
        };
      },
    },
  };

  const controller = createWorkerHealthController(deps);

  const signal: WorkerHealthSignal = {
    kind: "miss_threshold_exceeded",
    worker_id: "worker-a",
    probe_id: "probe-1",
    misses: 3,
    probe_interval_ms: 100,
  };

  await controller.onSignal(signal);
  expect(recorded).toHaveLength(1);
  expect(recovered).toEqual(["worker-a"]);
  expect(recorded[0]).toEqual({
    kind: "extra_worker_wedge_evicted",
    worker_id: "worker-a",
    probe_id: "probe-1",
    misses: 3,
    event: "probe_timeout",
  });
  expect(actions).toEqual(["restart:worker-a", "recover:worker-a:true"]);
  expect(knownWorkers.has("worker-a")).toBe(false);

  await controller.onSignal(signal);
  expect(recorded).toHaveLength(2);
  expect(recovered).toHaveLength(2);
  expect(recovered[1]).toBe("worker-a");
  expect(actions).toEqual([
    "restart:worker-a",
    "recover:worker-a:true",
    "restart:worker-a",
    "recover:worker-a:true",
  ]);
});

test("async onSignal rejection is logged and allows re-signal on next tick", async () => {
  vi.useFakeTimers();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };

  const errorLogs: Array<{ err: Error; worker_id: string }> = [];
  const log = makeLogStub();
  log.error = ((obj: { err: unknown; worker_id?: string }) => {
    errorLogs.push({
      err: obj.err as Error,
      worker_id: (obj as { worker_id: string }).worker_id ?? "",
    });
  }) as unknown as ProbeLog["error"];

  let signalCount = 0;
  let shouldFail = true;
  const controller: WorkerHealthController = {
    onSignal: async (): Promise<void> => {
      signalCount++;
      if (shouldFail) {
        shouldFail = false;
        throw new Error("simulated eviction failure");
      }
    },
  };

  const { services } = buildServices();
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    controller,
    log,
  });

  probe.start();
  advance(500);
  await flushPending();

  // First signal reached threshold then rejected — log.error must have been called.
  expect(signalCount).toBe(1);
  expect(errorLogs).toHaveLength(1);
  expect(errorLogs[0].err.message).toBe("simulated eviction failure");
  expect(errorLogs[0].worker_id).toBe("worker-a");

  // Because recoveredThisStreak was NOT set on failure, the next tick re-signals.
  advance(200);
  await flushPending();
  expect(signalCount).toBe(2);

  // After a successful signal, recoveredThisStreak IS set — no more signals.
  advance(500);
  await flushPending();
  expect(signalCount).toBe(2);
});

test("in-flight onSignal is not re-dispatched inside the recovery window", async () => {
  vi.useFakeTimers();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };

  let signalCount = 0;
  const controller: WorkerHealthController = {
    onSignal: (): Promise<void> => {
      signalCount++;
      return new Promise<void>(() => {
        // Never resolves — simulates a slow restart+recover that outlasts the probe interval.
      });
    },
  };

  const { services } = buildServices();
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    recoveryAckTimeoutMs: 10_000,
    controller,
    log: services.log,
  });

  probe.start();
  // Enough ticks to cross the threshold and then keep firing while onSignal is pending.
  advance(1000);
  await flushPending();

  expect(signalCount).toBe(1);
});

test("in-flight onSignal with no ACK re-emits after the recovery window", async () => {
  vi.useFakeTimers();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };

  let signalCount = 0;
  const controller: WorkerHealthController = {
    onSignal: (): Promise<void> => {
      signalCount++;
      return new Promise<void>(() => {
        // Never resolves — a wedged restart path that also never ACKs.
      });
    },
  };

  const { services } = buildServices();
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    recoveryAckTimeoutMs: 300,
    controller,
    log: services.log,
  });

  probe.start();
  advance(500);
  await flushPending();
  expect(signalCount).toBe(1);

  advance(1000);
  await flushPending();
  expect(signalCount).toBeGreaterThanOrEqual(2);
});

test("failed recovery (onSignal resolved, no ACK) re-emits after the recovery window", async () => {
  vi.useFakeTimers();
  const { services, signals, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    recoveryAckTimeoutMs: 300,
    controller,
    log: services.log,
  });

  probe.start();
  advance(500);
  await flushPending();
  // First eviction signal fired and onSignal resolved (default controller resolves synchronously).
  expect(signals).toHaveLength(1);

  // No ACK ever arrives: the restarted worker never came back. Once the recovery
  // window elapses, further misses must re-emit an eviction signal instead of
  // silencing the dead worker forever.
  advance(1000);
  await flushPending();
  expect(signals.length).toBeGreaterThanOrEqual(2);
});

test("ACK inside the recovery window clears suppression and prevents duplicate signals", async () => {
  vi.useFakeTimers();
  const { services, signals, controlEvents, controller } = buildServices();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    recoveryAckTimeoutMs: 300,
    controller,
    log: services.log,
  });

  probe.start();
  advance(500);
  await flushPending();
  expect(signals).toHaveLength(1);

  // Worker recovers and keeps acking every probe: no further eviction signals,
  // even well past the recovery window.
  for (let i = 0; i < 20; i++) {
    advance(100);
    await flushPending();
    const latest = controlEvents.at(-1)!.probe_id;
    probe.recordAck("worker-a", latest);
  }

  expect(signals).toHaveLength(1);
  expect(probe.getMissCount("worker-a")).toBe(0);
});

test("onSignal rejection clears suppression immediately so the same streak can re-signal", async () => {
  vi.useFakeTimers();
  const advance = (ms: number): void => {
    vi.advanceTimersByTime(ms);
  };

  let signalCount = 0;
  const controller: WorkerHealthController = {
    onSignal: (): Promise<void> => {
      signalCount++;
      return Promise.reject(new Error("eviction failed"));
    },
  };

  const { services } = buildServices();
  const probe = new WorkerHealthProbe({
    services,
    intervalMs: 100,
    missThreshold: 3,
    // Large window so any re-signal is due to rejection-clear, not window expiry.
    recoveryAckTimeoutMs: 10_000_000,
    controller,
    log: services.log,
  });

  probe.start();
  advance(500);
  await flushPending();
  expect(signalCount).toBe(1);

  // Rejection cleared suppression immediately, so the next miss re-signals.
  advance(200);
  await flushPending();
  expect(signalCount).toBeGreaterThanOrEqual(2);
});
