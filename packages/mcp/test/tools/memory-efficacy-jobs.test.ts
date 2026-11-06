import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  memoryEfficacyJobsHandler,
  MemoryEfficacyJobsInputShape,
} from "@src/tools/memory-efficacy-jobs.js";

import { fakeDaemon } from "../helpers.js";

type JobsFn = DaemonClient["memoryEfficacyJobs"];

function newJobs(): JobsFn {
  return mock(() => Promise.resolve({ jobs: [] }));
}

// bun:test types report `.rejects.toThrow()` as returning `void`, but it is
// async at runtime. Avoid the chain entirely so no-confusing-void-expression
// and await-thenable have nothing to flag.
async function expectRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error("expected promise to reject but it resolved");
}

test("memoryEfficacyJobsHandler forwards {} for empty input", async () => {
  const jobs = newJobs();
  const handler = memoryEfficacyJobsHandler(fakeDaemon({ memoryEfficacyJobs: jobs }));

  await handler({});

  expect(jobs).toHaveBeenCalledTimes(1);
  expect(jobs).toHaveBeenCalledWith({});
});

test("memoryEfficacyJobsHandler forwards limit and status verbatim", async () => {
  const jobs = newJobs();
  const handler = memoryEfficacyJobsHandler(fakeDaemon({ memoryEfficacyJobs: jobs }));

  await handler({ limit: 5, status: "running" });

  expect(jobs).toHaveBeenCalledTimes(1);
  expect(jobs).toHaveBeenCalledWith({ limit: 5, status: "running" });
});

test("memoryEfficacyJobsHandler rejects unknown keys", async () => {
  const jobs = newJobs();
  const handler = memoryEfficacyJobsHandler(fakeDaemon({ memoryEfficacyJobs: jobs }));

  await expectRejection(handler({ bogus: 1 }));
  expect(jobs).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyJobsHandler rejects string limit", async () => {
  const jobs = newJobs();
  const handler = memoryEfficacyJobsHandler(fakeDaemon({ memoryEfficacyJobs: jobs }));

  await expectRejection(handler({ limit: "5" }));
  expect(jobs).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyJobsHandler rejects numeric status", async () => {
  const jobs = newJobs();
  const handler = memoryEfficacyJobsHandler(fakeDaemon({ memoryEfficacyJobs: jobs }));

  await expectRejection(handler({ status: 42 }));
  expect(jobs).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyJobsHandler returns daemon result as JSON text envelope", async () => {
  const jobs = newJobs();
  const handler = memoryEfficacyJobsHandler(fakeDaemon({ memoryEfficacyJobs: jobs }));

  const res = await handler({});

  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual({ jobs: [] });
});

test("MemoryEfficacyJobsInputShape has exactly limit and status keys", () => {
  expect(Object.keys(MemoryEfficacyJobsInputShape).sort()).toEqual(["limit", "status"]);
});
