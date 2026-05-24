import { afterEach, expect, test, vi } from 'bun:test';
import {
  createWorkerHealthController,
  WorkerHealthProbe,
  type WorkerHealthSignal,
} from '../../src/services/worker-health-probe.js';

const buildServices = (overrides: { workerIds?: string[]; clock?: () => Date } = {}) => {
  const workerIds = overrides.workerIds ?? ['worker-a'];
  const controlEvents: Array<{ type: string; worker_id: string; probe_id: string }> = [];
  const signals: WorkerHealthSignal[] = [];
  const recoverEventLog: string[] = [];

  let uuidSeed = 0;

  const services = {
    extraWorkerSupervisor: {
      getKnownWorkerIds: () => [...workerIds],
    },
    workerControl: {
      emit: (event: { type: string; worker_id: string; probe_id: string }) => {
        if (event.type === 'ping') {
          controlEvents.push(event);
        }
      },
    },
    clock: overrides.clock ?? (() => new Date()),
    log: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      child: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
    },
    uuid: () => `uuid-${++uuidSeed}`,
  } as const;

  const controller = {
    onSignal: (signal: WorkerHealthSignal) => {
      signals.push(signal);
      recoverEventLog.push(signal.worker_id);
    },
  };

  return { services, controlEvents, signals, recoverEventLog, controller };
};

const flushPending = async () => {
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  process.env.PENUMBRA_WORKER_PROBE_ENABLED = undefined;
});

test('tick emits one ping with unique probe_id and worker_id', async () => {
  vi.useFakeTimers();
  const { services, controlEvents, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 50,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(50);
  await flushPending();
  expect(controlEvents).toHaveLength(1);
  expect(controlEvents[0]).toMatchObject({ type: 'ping', worker_id: 'worker-a' });
  expect(controlEvents[0].probe_id).toContain('uuid-');

  advance(100);
  await flushPending();

  expect(controlEvents).toHaveLength(3);
  expect(controlEvents[0]).toMatchObject({ type: 'ping', worker_id: 'worker-a' });
  expect(controlEvents[0].probe_id).toContain('uuid-');
});

test('ACK clears pending + resets miss count', async () => {
  vi.useFakeTimers();
  const { services, controlEvents, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(100);
  await flushPending();
  expect(controlEvents).toHaveLength(1);
  const firstProbe = controlEvents.at(-1)!.probe_id;

  expect(probe.recordAck('worker-a', firstProbe)).toBe(true);
  advance(200);
  await flushPending();

  expect(probe.getMissCount('worker-a')).toBe(0);
});

test('no ACK increments miss count', async () => {
  vi.useFakeTimers();
  const { services, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(300);
  await flushPending();

  expect(probe.getMissCount('worker-a')).toBe(1);
});

test('3 consecutive misses triggers eviction and notifies controller', async () => {
  vi.useFakeTimers();
  const { services, signals, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(500);
  await flushPending();

  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    worker_id: 'worker-a',
    misses: 3,
    probe_interval_ms: 100,
  });
});

test('ACK at miss=2 resets to 0; next miss is 1', async () => {
  vi.useFakeTimers();
  const { services, signals, controlEvents, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(400);
  await flushPending();
  expect(controlEvents.length).toBe(4);

  expect(probe.getMissCount('worker-a')).toBe(2);
  expect(signals).toHaveLength(0);

  const latestProbe = controlEvents.at(-1)!.probe_id;
  probe.recordAck('worker-a', latestProbe);
  expect(probe.getMissCount('worker-a')).toBe(0);

  advance(100);
  await flushPending();
  expect(probe.getMissCount('worker-a')).toBe(1);
  expect(signals).toHaveLength(0);
});

test('prune() clears state for removed workers so stale misses do not leak on re-add', async () => {
  vi.useFakeTimers();
  const { services, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(400);
  await flushPending();
  expect(probe.getMissCount('worker-a')).toBe(2);

  probe.prune([]);
  expect(probe.getMissCount('worker-a')).toBe(0);

  advance(300);
  await flushPending();
  expect(probe.getMissCount('worker-a')).toBe(1);
});

test('PENUMBRA_WORKER_PROBE_ENABLED=0 makes start a no-op', async () => {
  process.env.PENUMBRA_WORKER_PROBE_ENABLED = '0';
  vi.useFakeTimers();
  const { services, controlEvents, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 50,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(500);
  await flushPending();

  expect(controlEvents).toHaveLength(0);
});

test('unknown probe_id in recordAck does not throw and does not reset miss count', async () => {
  vi.useFakeTimers();
  const { services, controller } = buildServices();
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 3,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(300);
  await flushPending();

  expect(probe.getMissCount('worker-a')).toBe(1);
  expect(probe.recordAck('worker-a', 'bogus-id')).toBe(false);
  expect(probe.getMissCount('worker-a')).toBe(1);
});

test('concurrent probes emit per worker and ACK only touches that worker', async () => {
  vi.useFakeTimers();
  const { services, controlEvents, signals, controller } = buildServices({
    workerIds: ['worker-a', 'worker-b'],
  });
  const advance = (ms: number) => {
    vi.advanceTimersByTime(ms);
  };
  const probe = new WorkerHealthProbe({
    services: services as any,
    intervalMs: 100,
    missThreshold: 5,
    controller: controller as any,
    log: (services as any).log,
  });

  probe.start();
  advance(100);
  await flushPending();
  expect(controlEvents.filter((event) => event.worker_id === 'worker-a')).toHaveLength(1);
  expect(controlEvents.filter((event) => event.worker_id === 'worker-b')).toHaveLength(1);

  advance(300);
  await flushPending();
  const workerAProbe = controlEvents
    .filter((event) => event.worker_id === 'worker-a')
    .at(-1)!
    .probe_id;
  expect(probe.getMissCount('worker-a')).toBe(2);
  expect(probe.getMissCount('worker-b')).toBe(2);
  expect(probe.recordAck('worker-a', workerAProbe)).toBe(true);
  expect(probe.getMissCount('worker-a')).toBe(0);

  advance(100);
  await flushPending();

  expect(probe.getMissCount('worker-a')).toBe(1);
  expect(probe.getMissCount('worker-b')).toBe(3);
  expect(signals).toHaveLength(0);
});

test('default worker health controller records forensic event and recovers worker once per signal', async () => {
  const recorded: Array<{ kind: string; worker_id: string; probe_id: string; misses: number; event: string }> = [];
  const recovered: string[] = [];
  const controller = createWorkerHealthController({
    dispatchEventLog: {
      record: (event) => {
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
      recoverForWorker: (workerId: string) => {
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
  });

  const signal = {
    kind: 'miss_threshold_exceeded' as const,
    worker_id: 'worker-a',
    probe_id: 'probe-1',
    misses: 3,
    probe_interval_ms: 100,
  };

  controller.onSignal(signal);
  expect(recorded).toHaveLength(1);
  expect(recovered).toEqual(['worker-a']);
  expect(recorded[0]).toEqual({
    kind: 'extra_worker_wedge_evicted',
    worker_id: 'worker-a',
    probe_id: 'probe-1',
    misses: 3,
    event: 'probe_timeout',
  });

  controller.onSignal(signal);
  expect(recorded).toHaveLength(2);
  expect(recovered).toHaveLength(2);
  expect(recovered[1]).toBe('worker-a');
});
