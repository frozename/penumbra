import { createLogger, HeavyJobLock } from "@penumbra/core";
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setupWorkerJobResources } from "@src/worker/job-resources.js";

const log = createLogger({ component: "job-resources-test", level: "silent" });
const prime = (): Promise<{ available: false; reason: string }> =>
  Promise.resolve({ available: false, reason: "PENUMBRA_JOB_SCOPE=off" });
const meminfo =
  (gib: number): (() => Promise<string>) =>
  () =>
    Promise.resolve(`MemAvailable: ${String(gib * 1024 * 1024)} kB\n`);

function lock(name: string): HeavyJobLock {
  return new HeavyJobLock({ path: join(tmpdir(), `${name}.lock`), flockBin: null, log });
}

test("claims wait for the PENUMBRA_JOB_ADMIT_MIN_GIB floor and give up after the wait", async () => {
  const res = await setupWorkerJobResources(log, {
    env: { PENUMBRA_JOB_ADMIT_MIN_GIB: "20", PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-a"),
    memory: { platform: "linux", readMeminfo: meminfo(5) },
  });
  expect(await res.admitClaim({ handoff_id: "h1" }, new AbortController().signal)).toBe(false);
});

test("a host above the floor (or a 0 floor) admits at once", async () => {
  for (const [env, gib] of [
    [{ PENUMBRA_JOB_ADMIT_MIN_GIB: "20" }, 30],
    [{ PENUMBRA_JOB_ADMIT_MIN_GIB: "0" }, 1],
  ] as const) {
    const res = await setupWorkerJobResources(log, {
      env,
      prime,
      lock: lock("job-resources-b"),
      memory: { platform: "linux", readMeminfo: meminfo(gib) },
    });
    expect(await res.admitClaim({ handoff_id: "h1" }, new AbortController().signal)).toBe(true);
  }
});

test("the heavy-stage gate applies the same floor", async () => {
  const res = await setupWorkerJobResources(log, {
    env: { PENUMBRA_JOB_ADMIT_MIN_GIB: "20", PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-c"),
    memory: { platform: "linux", readMeminfo: meminfo(5) },
  });
  const entry = await res.heavyStageGate.enter("reconcile-tests");
  expect(entry.ok).toBe(false);
  expect(res.scope).toEqual({ available: false, reason: "PENUMBRA_JOB_SCOPE=off" });
});
