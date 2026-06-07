import { describe, expect, test } from "vitest";
import { createPrewarmLoop, type PrewarmLoopClock } from "../../src/worker/prewarm-loop.js";
import type { PrewarmTarget } from "../../src/worker/prewarm-targets.js";

/**
 * Phase 4 — bounded-process invariant + crash-rate guard. The loop must never
 * push the worker above the cap, must not re-spawn a failed target faster than
 * its backoff, and must trip a per-agent breaker after repeated crashes so a
 * flaky binary cannot become a tight respawn loop.
 */

function fakeClock(start = 0) {
  let now = start;
  const clock: PrewarmLoopClock = {
    now: () => now,
    setInterval: (fn, ms) => ({ fn, ms, unref: () => {} }),
    clearInterval: () => {},
  };
  return {
    clock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("prewarm loop bounds (Phase 4)", () => {
  test("global cap limits pre-warm to min(eligible, cap) processes", async () => {
    const fc = fakeClock();
    const warmed: string[] = [];
    const targets: PrewarmTarget[] = Array.from({ length: 10 }, (_, i) => ({
      agent: `a${i}`,
      repoRoot: "/repos/penumbra",
    }));
    const loop = createPrewarmLoop({
      computeTargets: () => targets,
      prewarmOne: async (t) => {
        warmed.push(t.agent);
      },
      countEntries: () => warmed.length, // each successful warm = one live process
      clock: fc.clock,
      cap: 2,
      refreshIntervalMs: 100_000,
    });

    await loop.tick();

    expect(warmed.length).toBe(2);
    expect(warmed).toEqual(["a0", "a1"]); // stable, first-cap-many
  });

  test("cap counts ALL warm processes, including those deposited by cold dispatches", async () => {
    const fc = fakeClock();
    const prewarmed: string[] = [];
    let coldEntries = 2; // two processes already deposited by cold dispatches
    const loop = createPrewarmLoop({
      computeTargets: () => [
        { agent: "a0", repoRoot: "/r" },
        { agent: "a1", repoRoot: "/r" },
      ],
      prewarmOne: async (t) => {
        prewarmed.push(t.agent);
      },
      countEntries: () => coldEntries + prewarmed.length,
      clock: fc.clock,
      cap: 2,
      refreshIntervalMs: 100_000,
    });

    await loop.tick();
    expect(prewarmed).toEqual([]); // already at cap from cold entries → no first-warms

    coldEntries = 0; // cold processes drained
    await loop.tick();
    expect(prewarmed).toEqual(["a0", "a1"]); // headroom returned
  });

  test("a failed pre-warm is not retried faster than its exponential backoff", async () => {
    const fc = fakeClock();
    const attempts: number[] = [];
    const loop = createPrewarmLoop({
      computeTargets: () => [{ agent: "x", repoRoot: "/r" }],
      prewarmOne: async () => {
        attempts.push(fcNow());
        throw new Error("boom");
      },
      countEntries: () => 0,
      clock: fc.clock,
      cap: 5,
      refreshIntervalMs: 100_000,
      backoffBaseMs: 1_000,
      backoffMaxMs: 60_000,
    });
    function fcNow() {
      return fc.clock.now();
    }

    await loop.tick(); // fail @0 → backoff 1000
    fc.advance(999);
    await loop.tick(); // still inside backoff
    expect(attempts).toEqual([0]);

    fc.advance(1);
    await loop.tick(); // @1000 → retry, fail → backoff 2000
    expect(attempts).toEqual([0, 1_000]);

    fc.advance(1_999);
    await loop.tick(); // @2999 < 3000
    expect(attempts).toEqual([0, 1_000]);

    fc.advance(1);
    await loop.tick(); // @3000 → retry
    expect(attempts).toEqual([0, 1_000, 3_000]);
  });

  test("repeated crashes trip a per-agent breaker that stops further attempts", async () => {
    const fc = fakeClock();
    let attempts = 0;
    const loop = createPrewarmLoop({
      computeTargets: () => [{ agent: "x", repoRoot: "/r" }],
      prewarmOne: async () => {
        attempts += 1;
        throw new Error("boom");
      },
      countEntries: () => 0,
      clock: fc.clock,
      cap: 5,
      refreshIntervalMs: 100_000,
      backoffBaseMs: 1,
      backoffMaxMs: 10,
      breakerThreshold: 3,
    });

    await loop.tick();
    fc.advance(100);
    await loop.tick();
    fc.advance(100);
    await loop.tick(); // third failure trips the breaker
    expect(attempts).toBe(3);

    fc.advance(100);
    await loop.tick();
    fc.advance(100);
    await loop.tick();
    expect(attempts).toBe(3); // breaker holds; no tight respawn loop
  });
});
