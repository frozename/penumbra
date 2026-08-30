import { expect, test } from "bun:test";

import { InProcessSupervisor } from "../../src/supervisor/in-process.js";

test("start runs the tick function then reports running", async () => {
  const sup = new InProcessSupervisor();
  let count = 0;
  sup.register({
    name: "w",
    intervalMs: 1_000,
    tick: () => {
      count++;
      return Promise.resolve();
    },
  });
  await sup.startAll();
  expect(sup.status("w")).toBe("running");
  await Bun.sleep(5); // let the initial tick run
  expect(count).toBeGreaterThanOrEqual(1);
  sup.stopAll();
});

test("stopAll stops ticks and reports stopped", async () => {
  const sup = new InProcessSupervisor();
  let count = 0;
  sup.register({
    name: "w",
    intervalMs: 1_000,
    tick: () => {
      count++;
      return Promise.resolve();
    },
  });
  await sup.startAll();
  sup.stopAll();
  expect(sup.status("w")).toBe("stopped");
});

test("thrown tick errors are caught; next tick still runs", async () => {
  const sup = new InProcessSupervisor();
  let throws = true;
  let ran = 0;
  sup.register({
    name: "w",
    intervalMs: 5,
    tick: () => {
      ran++;
      if (throws) {
        throws = false;
        throw new Error("boom");
      }
      return Promise.resolve();
    },
  });
  await sup.startAll();
  await Bun.sleep(30);
  sup.stopAll();
  expect(ran).toBeGreaterThanOrEqual(2);
});

test("failing initial tick surfaces as errored, not running", async () => {
  const sup = new InProcessSupervisor();
  sup.register({
    name: "w",
    intervalMs: 10_000,
    tick: () => {
      throw new Error("initial fail");
    },
  });
  await sup.startAll();
  expect(sup.status("w")).toBe("errored");
  sup.stopAll();
});

test("tick failures are logged with the worker name", async () => {
  const warnings: { worker?: string; err?: string }[] = [];
  const sup = new InProcessSupervisor({
    log: {
      warn: (obj: unknown): void => {
        warnings.push(obj as { worker?: string; err?: string });
      },
    },
  });
  sup.register({
    name: "w",
    intervalMs: 10_000,
    tick: () => {
      throw new Error("boom");
    },
  });
  await sup.startAll();
  sup.stopAll();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.worker).toBe("w");
  expect(warnings[0]?.err).toContain("boom");
});

test("tick errors arriving after stopAll do not clobber stopped", async () => {
  const sup = new InProcessSupervisor();
  sup.register({
    name: "w",
    intervalMs: 10_000,
    tick: () => {
      throw new Error("boom");
    },
  });
  sup.stopAll();
  await sup.runOnceNow("w");
  expect(sup.status("w")).toBe("stopped");
});

test("overlapping interval firings are skipped while a tick is in flight", async () => {
  const sup = new InProcessSupervisor();
  let started = 0;
  let finished = 0;
  sup.register({
    name: "slow",
    intervalMs: 10,
    tick: async () => {
      started++;
      await Bun.sleep(50);
      finished++;
    },
  });
  await sup.startAll();
  // startAll awaits the initial tick: started=1, finished=1.
  // setInterval now fires every 10ms while tick takes 50ms — without the
  // re-entrance guard, many overlapping invocations would run concurrently.
  await Bun.sleep(120);
  sup.stopAll();
  // With the guard: each tick completes before the next can start, so
  // started - finished is 0 or 1 at any moment.
  expect(started - finished).toBeLessThanOrEqual(1);
  // And the total count stays proportional to (elapsed / tickDuration), not
  // (elapsed / intervalMs). Over ~120ms with 50ms ticks we expect ≤ 5 runs.
  expect(started).toBeLessThanOrEqual(5);
});
