import { expect, mock, test } from 'bun:test';

const heartbeatCalls: Array<{ jobId: string; workerId: string; now: string }> = [];

mock.module('../../../core/src/readers/memory-efficacy-jobs.js', () => ({
  claimNextJob: mock(() => ({ job_id: 'job-1', reviews_dir: '/tmp/reviews', since_iso: null })),
  heartbeatJob: mock((_db: unknown, jobId: string, workerId: string, now: string) => {
    heartbeatCalls.push({ jobId, workerId, now });
    return true;
  }),
  completeJob: mock(() => {}),
}));

mock.module('../../../core/src/readers/memory-efficacy.js', () => ({
  buildMemoryEfficacyCache: mock(
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ scanned: 1, classified: 1, skipped: 0 }), 40),
      ),
  ),
}));

test('memory efficacy job runner heartbeats while the job is in flight', async () => {
  const { createMemoryEfficacyJobRunner } = await import('../../src/workers/memory-efficacy-job-runner.js');
  const services = { memoryEfficacyRunnerHeartbeatAt: 0 } as any;
  const runner = createMemoryEfficacyJobRunner({
    db: {} as any,
    services,
    siriusChat: async () => '[]',
    model: 'test',
    intervalMs: 1,
    heartbeatIntervalMs: 5,
  });

  runner.start();
  await new Promise((resolve) => setTimeout(resolve, 70));
  runner.stop();

  expect(heartbeatCalls.length).toBeGreaterThan(0);
  expect(services.memoryEfficacyRunnerHeartbeatAt).toBeGreaterThan(0);
});
