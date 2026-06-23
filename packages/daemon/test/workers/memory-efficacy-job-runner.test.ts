import type { JudgeChatFn, Services } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { expect, mock, test } from "bun:test";

import type {
  MemoryEfficacyJobRunnerCollaborators,
  MemoryEfficacyJobRunnerOpts,
} from "../../src/workers/memory-efficacy-job-runner.js";

import { createMemoryEfficacyJobRunner } from "../../src/workers/memory-efficacy-job-runner.js";

// The runner only mutates services.memoryEfficacyRunnerHeartbeatAt and forwards
// `db` to mocked collaborators, so we narrow to that surface and document the
// gap with a single test-local helper rather than spreading casts across every
// fixture.
interface TestServices {
  memoryEfficacyRunnerHeartbeatAt: number;
}

function asServices(s: TestServices): Services {
  return s as unknown as Services;
}

function fakeDb(): Database {
  return {} as unknown as Database;
}

const noopJudge: JudgeChatFn = () => Promise.resolve("[]");

type ClaimNextJobFn = MemoryEfficacyJobRunnerCollaborators["claimNextJob"];
type HeartbeatJobFn = MemoryEfficacyJobRunnerCollaborators["heartbeatJob"];
type CompleteJobFn = MemoryEfficacyJobRunnerCollaborators["completeJob"];
type BuildMemoryEfficacyCacheFn = MemoryEfficacyJobRunnerCollaborators["buildMemoryEfficacyCache"];

const heartbeatTrue: HeartbeatJobFn = () => true;
const completeTrue: CompleteJobFn = () => true;

function buildRunner(
  services: TestServices,
  collaborators: Partial<MemoryEfficacyJobRunnerCollaborators>,
  extra: Partial<Omit<MemoryEfficacyJobRunnerOpts, "db" | "services" | "judgeChat" | "model">> = {},
): ReturnType<typeof createMemoryEfficacyJobRunner> {
  return createMemoryEfficacyJobRunner({
    db: fakeDb(),
    services: asServices(services),
    judgeChat: noopJudge,
    model: "test",
    intervalMs: 1,
    ...extra,
    collaborators,
  });
}

test("memory efficacy job runner heartbeats while the job is in flight", async () => {
  const heartbeatCalls: { jobId: string; workerId: string; now: string }[] = [];
  let claimed = false;
  const services: TestServices = { memoryEfficacyRunnerHeartbeatAt: 0 };

  const claimNextJob = mock<ClaimNextJobFn>(() => {
    if (claimed) return null;
    claimed = true;
    return { job_id: "job-1", reviews_dir: "/tmp/reviews", since_iso: null };
  });
  const heartbeatJob = mock<HeartbeatJobFn>((_db, jobId, workerId, now) => {
    heartbeatCalls.push({ jobId, workerId, now });
    return true;
  });
  const completeJob = mock<CompleteJobFn>(completeTrue);
  const buildMemoryEfficacyCache = mock<BuildMemoryEfficacyCacheFn>(
    () =>
      new Promise<{ scanned: number; classified: number; skipped: number }>((resolve) => {
        setTimeout(() => {
          resolve({ scanned: 1, classified: 1, skipped: 0 });
        }, 40);
      }),
  );

  const runner = buildRunner(
    services,
    { claimNextJob, heartbeatJob, completeJob, buildMemoryEfficacyCache },
    { heartbeatIntervalMs: 5 },
  );

  runner.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 70));
  runner.stop();

  expect(heartbeatCalls.length).toBeGreaterThan(0);
  expect(services.memoryEfficacyRunnerHeartbeatAt).toBeGreaterThan(0);
});

test("memory efficacy job runner completes failed jobs with an error payload when the judge backend is unreachable", async () => {
  const completeCalls: { result: unknown }[] = [];
  let claimed = false;
  const services: TestServices = { memoryEfficacyRunnerHeartbeatAt: 0 };

  const claimNextJob = mock<ClaimNextJobFn>(() => {
    if (claimed) return null;
    claimed = true;
    return { job_id: "job-1", reviews_dir: "/tmp/reviews", since_iso: null };
  });
  const completeJob = mock<CompleteJobFn>((_db, _jobId, result) => {
    completeCalls.push({ result });
    return true;
  });
  const buildMemoryEfficacyCache = mock<BuildMemoryEfficacyCacheFn>(() => {
    throw new Error("judge backend unreachable");
  });

  const runner = buildRunner(services, {
    claimNextJob,
    heartbeatJob: heartbeatTrue,
    completeJob,
    buildMemoryEfficacyCache,
  });

  runner.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  runner.stop();

  expect(completeCalls).toHaveLength(1);
  expect(completeCalls[0]?.result).toEqual({ error: "judge backend unreachable" });
});

test("memory-efficacy-job-runner: defers tick when pressure guard enabled and provider is over threshold", async () => {
  let claimCallCount = 0;
  const services: TestServices = { memoryEfficacyRunnerHeartbeatAt: 0 };

  const claimNextJob = mock<ClaimNextJobFn>(() => {
    claimCallCount++;
    return null;
  });
  const buildMemoryEfficacyCache = mock<BuildMemoryEfficacyCacheFn>(() =>
    Promise.resolve({ scanned: 0, classified: 0, skipped: 0 }),
  );

  const runner = buildRunner(
    services,
    {
      claimNextJob,
      heartbeatJob: heartbeatTrue,
      completeJob: completeTrue,
      buildMemoryEfficacyCache,
      checkPressure: () => true,
    },
    { pressureGuardEnabled: true },
  );

  runner.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  runner.stop();

  expect(claimCallCount).toBe(0);
});

test("memory-efficacy-job-runner: runs normally when pressure guard enabled but pressure is low", async () => {
  let claimed = false;
  const services: TestServices = { memoryEfficacyRunnerHeartbeatAt: 0 };

  const claimNextJob = mock<ClaimNextJobFn>(() => {
    if (claimed) return null;
    claimed = true;
    return { job_id: "job-1", reviews_dir: "/tmp/reviews", since_iso: null };
  });
  const buildMemoryEfficacyCache = mock<BuildMemoryEfficacyCacheFn>(() =>
    Promise.resolve({ scanned: 0, classified: 0, skipped: 0 }),
  );

  const runner = buildRunner(
    services,
    {
      claimNextJob,
      heartbeatJob: heartbeatTrue,
      completeJob: completeTrue,
      buildMemoryEfficacyCache,
      checkPressure: () => false,
    },
    { pressureGuardEnabled: true },
  );

  runner.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  runner.stop();

  expect(claimed).toBe(true);
});

test("memory-efficacy-job-runner: always runs when pressure guard flag is off, even if checkPressure returns true", async () => {
  let claimed = false;
  const services: TestServices = { memoryEfficacyRunnerHeartbeatAt: 0 };

  const claimNextJob = mock<ClaimNextJobFn>(() => {
    if (claimed) return null;
    claimed = true;
    return { job_id: "job-1", reviews_dir: "/tmp/reviews", since_iso: null };
  });
  const buildMemoryEfficacyCache = mock<BuildMemoryEfficacyCacheFn>(() =>
    Promise.resolve({ scanned: 0, classified: 0, skipped: 0 }),
  );

  const runner = buildRunner(services, {
    claimNextJob,
    heartbeatJob: heartbeatTrue,
    completeJob: completeTrue,
    buildMemoryEfficacyCache,
    checkPressure: () => true,
  });

  runner.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  runner.stop();

  expect(claimed).toBe(true);
});
