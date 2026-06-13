import { describe, expect, test } from "bun:test";
import { createPrewarmLoop, type PrewarmLoopClock } from "../../src/worker/prewarm-loop.js";
import type { PrewarmTarget } from "../../src/worker/prewarm-targets.js";

/**
 * Phase 3 — worker-local pre-warm loop. Pure + fully injected: a fake clock
 * controls time + scheduling, a fake prewarmOne records / fails spawns, and a
 * counter stands in for the registry entry count.
 */

function fakeClock(start = 0) {
  let now = start;
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const clock: PrewarmLoopClock = {
    now: () => now,
    setInterval: (fn, ms) => {
      const handle = { fn, ms, unref: () => {} };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      const i = intervals.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) intervals.splice(i, 1);
    },
  };
  return {
    clock,
    intervals,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const target = (agent: string, repoRoot = "/repos/penumbra"): PrewarmTarget => ({
  agent,
  repoRoot,
  slot: 0,
});

describe("createPrewarmLoop (Phase 3)", () => {
  test("(a) boot pass deposits exactly once per target, in order", async () => {
    const fc = fakeClock();
    const warmed: string[] = [];
    const loop = createPrewarmLoop({
      computeTargets: () => [target("codex-acp-fast"), target("claude-acp-sonnet")],
      prewarmOne: async (t) => {
        warmed.push(t.agent);
      },
      countEntries: () => warmed.length,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 100_000,
    });

    await loop.tick();

    expect(warmed).toEqual(["codex-acp-fast", "claude-acp-sonnet"]);
  });

  test("(b) a throwing prewarm backs off and does not crash the loop or block siblings", async () => {
    const fc = fakeClock();
    const attempts: string[] = [];
    const loop = createPrewarmLoop({
      computeTargets: () => [target("flaky"), target("ok")],
      prewarmOne: async (t) => {
        attempts.push(t.agent);
        if (t.agent === "flaky") throw new Error("spawn failed");
      },
      countEntries: () => 0,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 100_000,
      backoffBaseMs: 5_000,
    });

    await loop.tick(); // flaky throws; ok is still warmed in the same pass
    expect(attempts).toEqual(["flaky", "ok"]);

    attempts.length = 0;
    fc.advance(4_999); // still inside flaky's 5s backoff; ok still fresh
    await loop.tick();
    expect(attempts).toEqual([]);

    fc.advance(2); // backoff elapsed → flaky retried, ok still fresh
    await loop.tick();
    expect(attempts).toEqual(["flaky"]);
  });

  test("(c) refresh re-warms a target only after it ages past the refresh interval", async () => {
    const fc = fakeClock();
    const warmedAt: number[] = [];
    const loop = createPrewarmLoop({
      computeTargets: () => [target("codex-acp-fast")],
      prewarmOne: async () => {
        warmedAt.push(fc.clock.now());
      },
      countEntries: () => warmedAt.length,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 1_000,
    });

    await loop.tick(); // now=0
    expect(warmedAt).toEqual([0]);

    fc.advance(999);
    await loop.tick(); // not yet aged
    expect(warmedAt).toEqual([0]);

    fc.advance(1);
    await loop.tick(); // now=1000 → aged → refreshed
    expect(warmedAt).toEqual([0, 1_000]);
  });

  test("(d) flag off (no targets) ⇒ zero prewarm calls", async () => {
    const fc = fakeClock();
    const warmed: string[] = [];
    const loop = createPrewarmLoop({
      computeTargets: () => [],
      prewarmOne: async (t) => {
        warmed.push(t.agent);
      },
      countEntries: () => 0,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 1_000,
    });

    await loop.tick();
    await loop.start(); // also runs a boot pass

    expect(warmed).toEqual([]);
  });

  test("(e) reload stops warming a de-flagged agent and prunes its state", async () => {
    const fc = fakeClock();
    const warmed: string[] = [];
    let targets = [target("codex-acp-fast")];
    const loop = createPrewarmLoop({
      computeTargets: () => targets,
      prewarmOne: async (t) => {
        warmed.push(t.agent);
      },
      countEntries: () => 0,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 1_000,
    });

    await loop.tick();
    expect(warmed).toEqual(["codex-acp-fast"]);

    targets = []; // de-flagged via config reload
    warmed.length = 0;
    await loop.reload();
    expect(warmed).toEqual([]);

    // Re-flagged at the same instant: because state was pruned, it is treated as
    // a fresh first-warm (not a still-fresh refresh that would be skipped).
    targets = [target("codex-acp-fast")];
    await loop.reload();
    expect(warmed).toEqual(["codex-acp-fast"]);
  });

  test("start schedules an unref'd refresh interval; stop clears it", async () => {
    const fc = fakeClock();
    const loop = createPrewarmLoop({
      computeTargets: () => [],
      prewarmOne: async () => {},
      countEntries: () => 0,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 1_000,
    });

    await loop.start();
    expect(fc.intervals.length).toBe(1);

    loop.stop();
    expect(fc.intervals.length).toBe(0);
  });

  test("a slow pass is single-flight: overlapping ticks do not double-warm", async () => {
    const fc = fakeClock();
    let resolveOne: () => void = () => {};
    const warmed: string[] = [];
    const loop = createPrewarmLoop({
      computeTargets: () => [target("codex-acp-fast")],
      prewarmOne: async (t) => {
        warmed.push(t.agent);
        await new Promise<void>((r) => {
          resolveOne = r;
        });
      },
      countEntries: () => warmed.length,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 100_000,
    });

    const first = loop.tick(); // starts, blocks inside prewarmOne
    await loop.tick(); // re-entrant: must no-op while first is running
    expect(warmed).toEqual(["codex-acp-fast"]);
    resolveOne?.();
    await first;
    expect(warmed).toEqual(["codex-acp-fast"]);
  });

  test("self-heal: re-warms a target whose live entry vanished, even before it ages", async () => {
    const fc = fakeClock();
    const warmedAt: number[] = [];
    let alive = false;
    const loop = createPrewarmLoop({
      computeTargets: () => [target("codex-acp-fast")],
      prewarmOne: async () => {
        warmedAt.push(fc.clock.now());
        alive = true;
      },
      countEntries: () => (alive ? 1 : 0),
      hasLiveEntry: () => alive,
      clock: fc.clock,
      cap: 10,
      refreshIntervalMs: 100_000, // long: aging cannot explain a re-warm here
    });

    await loop.tick(); // now=0: first warm
    expect(warmedAt).toEqual([0]);

    fc.advance(10);
    await loop.tick(); // live + not aged → skip
    expect(warmedAt).toEqual([0]);

    alive = false; // the pre-warmed child crashed
    fc.advance(10);
    await loop.tick(); // missing entry → re-warm despite not being aged
    expect(warmedAt).toEqual([0, 20]);
  });
});
