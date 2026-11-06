import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import {
  memoryEfficacyJobStatusHandler,
  MemoryEfficacyJobStatusInputShape,
} from "@src/tools/memory-efficacy-job-status.js";

import { fakeDaemon } from "../helpers.js";

type JobStatusFn = DaemonClient["memoryEfficacyJobStatus"];

function newJobStatus(): JobStatusFn {
  return mock(() => Promise.resolve({ job_id: "job-1", status: "completed" }));
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

test("memoryEfficacyJobStatusHandler forwards job_id verbatim", async () => {
  const jobStatus = newJobStatus();
  const handler = memoryEfficacyJobStatusHandler(
    fakeDaemon({ memoryEfficacyJobStatus: jobStatus }),
  );

  await handler({ job_id: "job-1" });

  expect(jobStatus).toHaveBeenCalledTimes(1);
  expect(jobStatus).toHaveBeenCalledWith({ job_id: "job-1" });
});

test("memoryEfficacyJobStatusHandler rejects missing job_id", async () => {
  const jobStatus = newJobStatus();
  const handler = memoryEfficacyJobStatusHandler(
    fakeDaemon({ memoryEfficacyJobStatus: jobStatus }),
  );

  await expectRejection(handler({}));
  expect(jobStatus).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyJobStatusHandler rejects numeric job_id", async () => {
  const jobStatus = newJobStatus();
  const handler = memoryEfficacyJobStatusHandler(
    fakeDaemon({ memoryEfficacyJobStatus: jobStatus }),
  );

  await expectRejection(handler({ job_id: 42 }));
  expect(jobStatus).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyJobStatusHandler rejects extra keys", async () => {
  const jobStatus = newJobStatus();
  const handler = memoryEfficacyJobStatusHandler(
    fakeDaemon({ memoryEfficacyJobStatus: jobStatus }),
  );

  await expectRejection(handler({ job_id: "job-1", bogus: 1 }));
  expect(jobStatus).toHaveBeenCalledTimes(0);
});

test("memoryEfficacyJobStatusHandler returns daemon result as JSON text envelope", async () => {
  const jobStatus = newJobStatus();
  const handler = memoryEfficacyJobStatusHandler(
    fakeDaemon({ memoryEfficacyJobStatus: jobStatus }),
  );

  const res = await handler({ job_id: "job-1" });

  const block = res.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  expect(block.type).toBe("text");
  expect(JSON.parse(block.text)).toEqual({ job_id: "job-1", status: "completed" });
});

test("MemoryEfficacyJobStatusInputShape has exactly job_id key", () => {
  expect(Object.keys(MemoryEfficacyJobStatusInputShape)).toEqual(["job_id"]);
});
