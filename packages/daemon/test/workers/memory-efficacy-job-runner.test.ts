import { expect, mock, test } from 'bun:test';
import { createMemoryEfficacyJobRunner } from '../../src/workers/memory-efficacy-job-runner.js';

test('memory efficacy job runner heartbeats while the job is in flight', async () => {
  const heartbeatCalls: Array<{ jobId: string; workerId: string; now: string }> = [];
  const services = { memoryEfficacyRunnerHeartbeatAt: 0 } as any;

  const runner = createMemoryEfficacyJobRunner({
    db: {} as any,
    services,
    judgeChat: async () => '[]',
    model: 'test',
    intervalMs: 1,
    heartbeatIntervalMs: 5,
    claimNextJob: mock(
      () => ({ job_id: 'job-1', reviews_dir: '/tmp/reviews', since_iso: null }) as any,
    ),
    heartbeatJob: mock((_db: unknown, jobId: string, workerId: string, now: string) => {
      heartbeatCalls.push({ jobId, workerId, now });
      return true;
    }) as any,
    completeJob: mock(() => true) as any,
    buildMemoryEfficacyCache: mock(
      () =>
        new Promise<{ scanned: number; classified: number; skipped: number }>((resolve) =>
          setTimeout(() => resolve({ scanned: 1, classified: 1, skipped: 0 }), 40),
        ),
    ) as any,
  });

  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 70));
  runner.stop();

  expect(heartbeatCalls.length).toBeGreaterThan(0);
  expect(services.memoryEfficacyRunnerHeartbeatAt).toBeGreaterThan(0);
});
