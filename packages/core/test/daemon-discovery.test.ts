import { expect, test } from "bun:test";
import { resolveDaemonStorageRoot, waitForDaemonStorageRoot } from "../src/daemon-discovery.js";

test("resolveDaemonStorageRoot prefers PENUMBRA_STORAGE_ROOT over autodiscovery", () => {
  const root = resolveDaemonStorageRoot({ env: { PENUMBRA_STORAGE_ROOT: "/custom/env" } });
  expect(root).toBe("/custom/env");
});

test("resolveDaemonStorageRoot honors explicit opts.explicit override", () => {
  const root = resolveDaemonStorageRoot({
    explicit: "/explicit/path",
    env: { PENUMBRA_STORAGE_ROOT: "/custom/env" },
  });
  expect(root).toBe("/explicit/path");
});

test("resolveDaemonStorageRoot treats explicit:'' (empty string) as not-set", () => {
  const root = resolveDaemonStorageRoot({
    explicit: "",
    env: { PENUMBRA_STORAGE_ROOT: "/custom/env" },
  });
  expect(root).toBe("/custom/env");
});

test("resolveDaemonStorageRoot returns explicit:'/path/that/does/not/exist' as-is, even when the path is invalid", () => {
  const root = resolveDaemonStorageRoot({
    explicit: "/path/that/does/not/exist",
    env: { PENUMBRA_STORAGE_ROOT: "/custom/env" },
  });
  expect(root).toBe("/path/that/does/not/exist");
});

test("resolveDaemonStorageRoot picks the first candidate path with port+token files", () => {
  const root = resolveDaemonStorageRoot({
    env: {},
    candidates: ["/cand1", "/cand2"],
    existsSync: (path) => path.startsWith("/cand2/port") || path.startsWith("/cand2/token"),
  });
  expect(root).toBe("/cand2");
});

test("resolveDaemonStorageRoot lists every checked candidate when nothing is running", () => {
  expect(() => {
    resolveDaemonStorageRoot({
      env: {},
      candidates: ["/cand1", "/cand2"],
      existsSync: () => false,
    });
  }).toThrow(/penumbra daemon not found\. Checked candidate paths: \/cand1, \/cand2/);
});

test("waitForDaemonStorageRoot returns immediately when the daemon is already up", async () => {
  const root = await waitForDaemonStorageRoot({
    env: {},
    candidates: ["/cand1"],
    existsSync: () => true,
    timeoutMs: 100,
    intervalMs: 10,
  });
  expect(root).toBe("/cand1");
});

test("waitForDaemonStorageRoot polls and resolves when the daemon comes up mid-wait", async () => {
  let now = 0;
  let daemonUpAt = 30; // ms
  const sleeps: number[] = [];
  let onWaitingCalls = 0;

  const root = await waitForDaemonStorageRoot({
    env: {},
    candidates: ["/cand1"],
    existsSync: () => now >= daemonUpAt,
    timeoutMs: 1000,
    intervalMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
    onWaiting: () => {
      onWaitingCalls++;
    },
  });

  expect(root).toBe("/cand1");
  expect(onWaitingCalls).toBe(1);
  // 3 ten-ms sleeps to reach 30ms.
  expect(sleeps).toEqual([10, 10, 10]);
});

test("waitForDaemonStorageRoot throws after timeoutMs when the daemon never appears", async () => {
  let now = 0;
  await expect(
    waitForDaemonStorageRoot({
      env: {},
      candidates: ["/cand1", "/cand2"],
      existsSync: () => false,
      timeoutMs: 50,
      intervalMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    }),
  ).rejects.toThrow(/penumbra daemon not found\. Checked candidate paths: \/cand1, \/cand2/);
});

test("waitForDaemonStorageRoot does not call onWaiting when daemon is already up", async () => {
  let onWaitingCalls = 0;
  await waitForDaemonStorageRoot({
    env: {},
    candidates: ["/cand1"],
    existsSync: () => true,
    timeoutMs: 100,
    intervalMs: 10,
    onWaiting: () => {
      onWaitingCalls++;
    },
  });
  expect(onWaitingCalls).toBe(0);
});

test("waitForDaemonStorageRoot honors explicit override (no waiting)", async () => {
  const root = await waitForDaemonStorageRoot({
    explicit: "/explicit/path",
    timeoutMs: 100,
    intervalMs: 10,
  });
  expect(root).toBe("/explicit/path");
});
