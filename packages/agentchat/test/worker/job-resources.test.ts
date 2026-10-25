import { createLogger, HeavyJobLock } from "@penumbra/core";
import { expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG,
  CLAIM_ADMISSION_TIMEOUT_MSG,
  setupWorkerJobResources,
} from "@src/worker/job-resources.js";

const log = createLogger({ component: "job-resources-test", level: "silent" });
const prime = (): Promise<{ available: false; reason: string }> =>
  Promise.resolve({ available: false, reason: "PENUMBRA_JOB_SCOPE=off" });
const meminfo =
  (gib: number): (() => Promise<string>) =>
  () =>
    Promise.resolve(`MemAvailable: ${String(gib * 1024 * 1024)} kB\n`);
const hostMeminfo =
  (totalGiB: number, availableGiB: number): (() => Promise<string>) =>
  () =>
    Promise.resolve(
      `MemTotal: ${String(totalGiB * 1024 * 1024)} kB\nMemAvailable: ${String(availableGiB * 1024 * 1024)} kB\n`,
    );

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

test("unset floor follows MemTotal: a 16 GiB host admits at 5 GiB free, a 124 GiB host does not", async () => {
  const host =
    (totalGiB: number, availableGiB: number): (() => Promise<string>) =>
    () =>
      Promise.resolve(
        `MemTotal: ${String(totalGiB * 1024 * 1024)} kB\nMemAvailable: ${String(availableGiB * 1024 * 1024)} kB\n`,
      );
  const small = await setupWorkerJobResources(log, {
    env: { PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-d"),
    memory: { platform: "linux", readMeminfo: host(16, 5) },
  });
  expect(await small.admitClaim({ handoff_id: "h1" }, new AbortController().signal)).toBe(true);
  const large = await setupWorkerJobResources(log, {
    env: { PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-e"),
    memory: { platform: "linux", readMeminfo: host(124, 15) },
  });
  expect(await large.admitClaim({ handoff_id: "h1" }, new AbortController().signal)).toBe(false);
});

test("boot warns when MemAvailable is below a derived floor", async () => {
  const l = createLogger({ component: "job-resources-test", level: "silent" });
  const warn = spyOn(l, "warn");
  await setupWorkerJobResources(l, {
    env: { PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-f"),
    memory: { platform: "linux", readMeminfo: hostMeminfo(124, 15) },
  });
  const calls = warn.mock.calls.filter((c) => c[1] === ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG);
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toMatchObject({
    admit_min_gib: 20,
    available_gib: 15,
    explicit: false,
    env_var: "PENUMBRA_JOB_ADMIT_MIN_GIB",
  });
  expect(ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG).toContain("PENUMBRA_JOB_ADMIT_MIN_GIB");
});

test("no boot warning for an explicit floor or a host above the derived floor", async () => {
  for (const [env, readMeminfo] of [
    [{ PENUMBRA_JOB_ADMIT_MIN_GIB: "20" }, meminfo(5)],
    [{}, hostMeminfo(124, 30)],
  ] as const) {
    const l = createLogger({ component: "job-resources-test", level: "silent" });
    const warn = spyOn(l, "warn");
    await setupWorkerJobResources(l, {
      env,
      prime,
      lock: lock("job-resources-g"),
      memory: { platform: "linux", readMeminfo },
    });
    const calls = warn.mock.calls.filter((c) => c[1] === ADMISSION_FLOOR_ABOVE_AVAILABLE_MSG);
    expect(calls.length).toBe(0);
  }
});

test("a claim whose admission wait times out warns with available vs floor", async () => {
  const l = createLogger({ component: "job-resources-test", level: "silent" });
  const warn = spyOn(l, "warn");
  const res = await setupWorkerJobResources(l, {
    env: { PENUMBRA_JOB_ADMIT_MIN_GIB: "20", PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-h"),
    memory: { platform: "linux", readMeminfo: meminfo(5) },
  });
  expect(await res.admitClaim({ handoff_id: "h1" }, new AbortController().signal)).toBe(false);
  const calls = warn.mock.calls.filter((c) => c[1] === CLAIM_ADMISSION_TIMEOUT_MSG);
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toMatchObject({
    handoff_id: "h1",
    available_gib: 5,
    min_gib: 20,
    explicit: true,
    env_var: "PENUMBRA_JOB_ADMIT_MIN_GIB",
  });
  expect(typeof (calls[0]?.[0] as { waited_s: unknown }).waited_s).toBe("number");
});

test("an aborted claim does not log the admission timeout", async () => {
  const l = createLogger({ component: "job-resources-test", level: "silent" });
  const warn = spyOn(l, "warn");
  const res = await setupWorkerJobResources(l, {
    env: { PENUMBRA_JOB_ADMIT_MIN_GIB: "20", PENUMBRA_JOB_ADMIT_WAIT_S: "0" },
    prime,
    lock: lock("job-resources-i"),
    memory: { platform: "linux", readMeminfo: meminfo(5) },
  });
  const controller = new AbortController();
  controller.abort();
  expect(await res.admitClaim({ handoff_id: "h1" }, controller.signal)).toBe(false);
  const calls = warn.mock.calls.filter((c) => c[1] === CLAIM_ADMISSION_TIMEOUT_MSG);
  expect(calls.length).toBe(0);
});
