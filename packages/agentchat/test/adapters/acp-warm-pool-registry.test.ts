import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";

import {
  acpWarmPoolHasLiveEntry,
  acpWarmPoolLiveEntryCount,
  drainAgent,
  evictOldestIdleAcrossPools,
  evictOldestPrewarmAcrossPools,
  getOrCreateAcpWarmPool,
  resetAcpWarmPoolRegistryForTest,
  resolveWarmPrewarmCap,
  totalAcpWarmPoolEntryCount,
} from "@src/adapters/acp-warm-pool-registry.js";
import type { AcpWarmPoolPrewarmEviction } from "@src/adapters/acp-warm-pool.js";
import type { StdioAcpClient } from "@src/adapters/stdio-acp-client.js";

import { makeMockAcpHandle, type MockAcpHandle } from "../helpers/stdio-acp-fixtures.js";

type WarmPool = ReturnType<typeof getOrCreateAcpWarmPool>;

function asStdioAcpClient(value: unknown): StdioAcpClient {
  return value as StdioAcpClient;
}

// The pool captures `this.now = deps.now ?? Date.now` at construction, so the
// spy must be installed in beforeEach before any getOrCreateAcpWarmPool call.
let now = 0;
let nowSpy: { mockRestore(): void } | undefined;

beforeEach(() => {
  resetAcpWarmPoolRegistryForTest();
  delete process.env.PENUMBRA_WARM_PREWARM_CAP;
  now = 0;
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  resetAcpWarmPoolRegistryForTest();
  delete process.env.PENUMBRA_WARM_PREWARM_CAP;
  nowSpy?.mockRestore();
});

function depositIdleEntry(pool: WarmPool, key: string, at: number): MockAcpHandle {
  now = at;
  const handle = makeMockAcpHandle();
  pool.deposit(key, {
    handle,
    client: asStdioAcpClient({}),
    specHash: "spec-a",
  });
  return handle;
}

function depositPrewarmEntry(pool: WarmPool, key: string, at: number): MockAcpHandle {
  now = at;
  const handle = makeMockAcpHandle();
  pool.deposit(key, {
    handle,
    client: asStdioAcpClient({}),
    specHash: "spec-a",
    pinned: true,
    prewarm: true,
  });
  return handle;
}

describe("resolveWarmPrewarmCap", () => {
  test("falls back to the default cap when PENUMBRA_WARM_PREWARM_CAP is unset", () => {
    expect(resolveWarmPrewarmCap()).toBe(4);
  });

  test("reads PENUMBRA_WARM_PREWARM_CAP at call time", () => {
    expect(resolveWarmPrewarmCap()).toBe(4);
    process.env.PENUMBRA_WARM_PREWARM_CAP = "7";
    expect(resolveWarmPrewarmCap()).toBe(7);
  });

  test.each(["0", "-3", "2.5", "abc", ""])(
    "falls back to the default cap for invalid value %s",
    (value) => {
      process.env.PENUMBRA_WARM_PREWARM_CAP = value;
      expect(resolveWarmPrewarmCap()).toBe(4);
    },
  );
});

describe("resolveMaxEntries clamp (via getOrCreateAcpWarmPool)", () => {
  test("uses warmPoolMaxEntries when it is below the env cap", () => {
    const pool = getOrCreateAcpWarmPool("a", { warmPoolMaxEntries: 1 });

    const h1 = makeMockAcpHandle();
    now = 10;
    expect(
      pool.deposit("a\0/one", { handle: h1, client: asStdioAcpClient({}), specHash: "spec-a" }),
    ).not.toBeNull();

    const h2 = makeMockAcpHandle();
    now = 20;
    expect(
      pool.deposit("a\0/two", { handle: h2, client: asStdioAcpClient({}), specHash: "spec-a" }),
    ).not.toBeNull();

    expect(h1.kill).toHaveBeenCalledTimes(1);
    expect(h2.kill).not.toHaveBeenCalled();
    expect(totalAcpWarmPoolEntryCount()).toBe(1);
    expect(acpWarmPoolHasLiveEntry("a", "a\0/one")).toBe(false);
  });

  test("bounds warmPoolMaxEntries by the env cap before cross-pool prewarm eviction", () => {
    process.env.PENUMBRA_WARM_PREWARM_CAP = "2";
    const pool = getOrCreateAcpWarmPool("a", { warmPoolMaxEntries: 3 });

    const p1 = depositPrewarmEntry(pool, "x\0/1", 10);
    const p2 = depositPrewarmEntry(pool, "x\0/2", 20);

    const r = makeMockAcpHandle();
    now = 30;
    expect(
      pool.deposit("a\0/repo", { handle: r, client: asStdioAcpClient({}), specHash: "spec-a" }),
    ).toBeNull();

    expect(p1.kill).not.toHaveBeenCalled();
    expect(p2.kill).not.toHaveBeenCalled();
    expect(r.kill).toHaveBeenCalledTimes(1);
    expect(totalAcpWarmPoolEntryCount()).toBe(2);
  });
});

describe("evictOldestIdleAcrossPools", () => {
  test("evicts the oldest idle entry across pools regardless of pool insertion order", () => {
    const a = getOrCreateAcpWarmPool("a", {});
    const b = getOrCreateAcpWarmPool("b", {});
    const c = getOrCreateAcpWarmPool("c", {});

    // Oldest deposit lives in the middle-created pool: age order (b, c, a)
    // differs from Map insertion order (a, b, c).
    const hb = depositIdleEntry(b, "b\0/repo", 10);
    const hc = depositIdleEntry(c, "c\0/repo", 20);
    const ha = depositIdleEntry(a, "a\0/repo", 30);

    expect(evictOldestIdleAcrossPools()).toBe(true);

    expect(hb.kill).toHaveBeenCalledTimes(1);
    expect(ha.kill).not.toHaveBeenCalled();
    expect(hc.kill).not.toHaveBeenCalled();
    expect(totalAcpWarmPoolEntryCount()).toBe(2);
    expect(acpWarmPoolHasLiveEntry("b", "b\0/repo")).toBe(false);
    expect(acpWarmPoolHasLiveEntry("a", "a\0/repo")).toBe(true);
    expect(acpWarmPoolHasLiveEntry("c", "c\0/repo")).toBe(true);
  });

  test("ages a released entry from its release time, not its spawn time", () => {
    const a = getOrCreateAcpWarmPool("a", {});
    const b = getOrCreateAcpWarmPool("b", {});

    const ha = depositIdleEntry(a, "a\0/repo", 5);
    expect(a.acquire("h", "a\0/repo", "spec-a")).not.toBeNull();
    now = 40;
    a.release("h", "a\0/repo");

    const hb = depositIdleEntry(b, "b\0/repo", 20);

    expect(evictOldestIdleAcrossPools()).toBe(true);

    expect(hb.kill).toHaveBeenCalledTimes(1);
    expect(ha.kill).not.toHaveBeenCalled();
  });

  test("returns false when no pool holds an evictable idle entry", () => {
    expect(evictOldestIdleAcrossPools()).toBe(false);

    const a = getOrCreateAcpWarmPool("a", {});
    const ha = makeMockAcpHandle();
    a.deposit("a\0/pinned", {
      handle: ha,
      client: asStdioAcpClient({}),
      specHash: "spec-a",
      pinned: true,
    });

    const b = getOrCreateAcpWarmPool("b", {});
    const hb = depositIdleEntry(b, "b\0/held", 10);
    expect(b.acquire("h", "b\0/held", "spec-a")).not.toBeNull();

    expect(evictOldestIdleAcrossPools()).toBe(false);

    expect(ha.kill).not.toHaveBeenCalled();
    expect(hb.kill).not.toHaveBeenCalled();
    expect(totalAcpWarmPoolEntryCount()).toBe(2);
  });
});

describe("evictOldestPrewarmAcrossPools", () => {
  test("evicts the oldest other-agent prewarm across pools and emits the event", () => {
    const p = getOrCreateAcpWarmPool("p", {});
    const q = getOrCreateAcpWarmPool("q", {});
    const r = getOrCreateAcpWarmPool("r", {});

    // Oldest prewarm lives in the middle-created pool: age order (q, r, p)
    // differs from Map insertion order (p, q, r).
    const hp = depositPrewarmEntry(p, "p\0/repo", 30);
    const hq = depositPrewarmEntry(q, "q\0/repo", 10);
    const hr = depositPrewarmEntry(r, "r\0/repo", 20);

    now = 100;
    const events: AcpWarmPoolPrewarmEviction[] = [];
    expect(
      evictOldestPrewarmAcrossPools("d", (event) => {
        events.push(event);
      }),
    ).toBe(true);

    expect(hq.kill).toHaveBeenCalledTimes(1);
    expect(hp.kill).not.toHaveBeenCalled();
    expect(hr.kill).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        evictedAgent: "q",
        evictedRepoRoot: "/repo",
        depositorAgent: "d",
        idleMs: 90,
      },
    ]);
  });

  test("returns false without invoking the callback when no prewarm is eligible", () => {
    const o = getOrCreateAcpWarmPool("o", {});
    const ho = depositIdleEntry(o, "o\0/repo", 10);

    const onEvicted = vi.fn<(event: AcpWarmPoolPrewarmEviction) => void>();
    expect(evictOldestPrewarmAcrossPools("d", onEvicted)).toBe(false);

    expect(onEvicted).not.toHaveBeenCalled();
    expect(ho.kill).not.toHaveBeenCalled();
  });
});

describe("live-entry helpers", () => {
  test("acpWarmPoolHasLiveEntry reports only the owning agent's pool", () => {
    const a = getOrCreateAcpWarmPool("a", {});
    depositIdleEntry(a, "a\0/repo", 10);

    expect(acpWarmPoolHasLiveEntry("a", "a\0/repo")).toBe(true);
    expect(acpWarmPoolHasLiveEntry("b", "a\0/repo")).toBe(false);
    expect(acpWarmPoolHasLiveEntry("a", "a\0/other")).toBe(false);
  });

  test("acpWarmPoolLiveEntryCount counts running entries per key", () => {
    const a = getOrCreateAcpWarmPool("a", { warmPoolSize: 2 });
    const h1 = depositIdleEntry(a, "a\0/repo", 10);
    depositIdleEntry(a, "a\0/repo", 20);

    expect(acpWarmPoolLiveEntryCount("a", "a\0/repo")).toBe(2);

    h1.stdin.end();
    expect(acpWarmPoolLiveEntryCount("a", "a\0/repo")).toBe(1);

    expect(acpWarmPoolLiveEntryCount("unknown", "a\0/repo")).toBe(0);
  });

  test("drainAgent clears the live-entry helpers for that agent", () => {
    const a = getOrCreateAcpWarmPool("a", {});
    depositIdleEntry(a, "a\0/repo", 10);

    drainAgent("a");

    expect(acpWarmPoolHasLiveEntry("a", "a\0/repo")).toBe(false);
    expect(acpWarmPoolLiveEntryCount("a", "a\0/repo")).toBe(0);
  });
});
