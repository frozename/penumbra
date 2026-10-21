import { describe, expect, test } from "bun:test";

import {
  parseMemAvailableGiB,
  readMemAvailableGiB,
  waitForMemory,
} from "@src/process/memory-admission.js";

function meminfo(availableGiB: number): string {
  return `MemTotal:       131072000 kB\nMemFree:          1000000 kB\nMemAvailable:   ${String(Math.round(availableGiB * 1024 * 1024))} kB\n`;
}

/** Fake clock + sleep: each sleep advances the clock by exactly the slept ms. */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    now: (): number => t,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe("parseMemAvailableGiB", () => {
  test("reads MemAvailable in GiB", () => {
    expect(parseMemAvailableGiB(meminfo(28))).toBeCloseTo(28, 3);
  });

  test("returns null when the field is missing", () => {
    expect(parseMemAvailableGiB("MemTotal: 1 kB\n")).toBeNull();
  });
});

describe("readMemAvailableGiB", () => {
  test("is a no-op off Linux", async () => {
    expect(
      await readMemAvailableGiB({
        platform: "darwin",
        readMeminfo: () => Promise.reject(new Error("must not read")),
      }),
    ).toBeNull();
  });
});

describe("waitForMemory", () => {
  test("admits immediately when MemAvailable is above the floor", async () => {
    const time = fakeTime();
    const res = await waitForMemory(20, {
      timeoutMs: 60_000,
      platform: "linux",
      readMeminfo: () => Promise.resolve(meminfo(25)),
      ...time,
    });
    expect(res).toMatchObject({ admitted: true, waitedMs: 0 });
    expect(time.slept).toEqual([]);
  });

  test("waits, polling, until memory frees up", async () => {
    const time = fakeTime();
    const readings = [12, 15, 21];
    const waits: number[] = [];
    const res = await waitForMemory(20, {
      timeoutMs: 60_000,
      pollMs: 10_000,
      platform: "linux",
      readMeminfo: () => Promise.resolve(meminfo(readings.shift() ?? 0)),
      onWait: (gib) => waits.push(Math.round(gib)),
      ...time,
    });
    expect(res).toMatchObject({ admitted: true, waitedMs: 20_000 });
    expect(time.slept).toEqual([10_000, 10_000]);
    expect(waits).toEqual([12]);
  });

  test("times out when the host stays below the floor", async () => {
    const time = fakeTime();
    const res = await waitForMemory(20, {
      timeoutMs: 25_000,
      pollMs: 10_000,
      platform: "linux",
      readMeminfo: () => Promise.resolve(meminfo(8)),
      ...time,
    });
    expect(res).toMatchObject({ admitted: false, reason: "timeout", waitedMs: 25_000 });
    expect(time.slept).toEqual([10_000, 10_000, 5_000]);
  });

  test("an abort ends the wait without admitting", async () => {
    const controller = new AbortController();
    const res = await waitForMemory(20, {
      timeoutMs: 60_000,
      platform: "linux",
      readMeminfo: () => Promise.resolve(meminfo(1)),
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    expect(res).toMatchObject({ admitted: false, reason: "aborted" });
  });

  test("admits without reading when the floor is 0, off Linux, or meminfo is unreadable", async () => {
    const reject = (): Promise<string> => Promise.reject(new Error("unreadable"));
    expect(
      await waitForMemory(0, { timeoutMs: 1, platform: "linux", readMeminfo: reject }),
    ).toMatchObject({ admitted: true, availableGiB: null });
    expect(
      await waitForMemory(20, { timeoutMs: 1, platform: "darwin", readMeminfo: reject }),
    ).toMatchObject({ admitted: true, availableGiB: null });
    expect(
      await waitForMemory(20, { timeoutMs: 1, platform: "linux", readMeminfo: reject }),
    ).toMatchObject({ admitted: true, availableGiB: null });
  });
});
