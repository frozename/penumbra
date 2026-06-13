import { describe, expect, test, vi } from "bun:test";
import { PassThrough } from "node:stream";
import { createAcpWarmPool, poolKeyFor } from "../../src/adapters/acp-warm-pool.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function handle(opts: { writable?: boolean; exited?: Promise<number | null> } = {}) {
  const stdin = new PassThrough();
  if (opts.writable === false) stdin.end();
  return {
    stdin,
    stdout: new PassThrough(),
    kill: vi.fn(),
    exited: opts.exited ?? new Promise<number | null>(() => {}),
    getStderrTail: () => "",
  };
}

const client = {} as any;
const key = poolKeyFor({ agent: "codex-acp-fast", cwd: "/repo" });

describe("AcpWarmPool", () => {
  test("returns null for an empty key and reuses an idle deposited entry once", () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    expect(pool.acquire("h1", key, "spec-a")).toBeNull();

    const h = handle();
    pool.deposit(key, { handle: h, client, sessionId: "s1", specHash: "spec-a" });

    const entry = pool.acquire("h1", key, "spec-a");
    expect(entry?.sessionId).toBe("s1");
    expect(pool.acquire("h2", key, "spec-a")).toBeNull();

    pool.release("h1", key);
    const reused = pool.acquire("h2", key, "spec-a");
    expect(reused?.sessionId).toBe("s1");
  });

  test("release marks lastReleaseAt and sweep evicts after grace", () => {
    let now = 1000;
    const pool = createAcpWarmPool({ now: () => now, graceMs: 5000 });
    const h = handle();
    pool.deposit(key, { handle: h, client, sessionId: "s1", specHash: "spec-a" });
    expect(pool.acquire("h1", key, "spec-a")).not.toBeNull();
    pool.release("h1", key);

    now = 5999;
    pool._sweep();
    expect(h.kill).not.toHaveBeenCalled();

    now = 6000;
    pool._sweep();
    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(pool.acquire("h2", key, "spec-a")).toBeNull();
  });

  test("evicts dead or non-writable entries at acquire", () => {
    const dead = handle();
    (dead as any).exitCode = 1;
    const pool = createAcpWarmPool();
    pool.deposit(key, { handle: dead, client, sessionId: "dead", specHash: "spec-a" });
    expect(pool.acquire("h1", key, "spec-a")).toBeNull();
    expect(dead.kill).toHaveBeenCalledTimes(1);

    const notWritable = handle({ writable: false });
    pool.deposit(key, {
      handle: notWritable,
      client,
      sessionId: "not-writable",
      specHash: "spec-a",
    });
    expect(pool.acquire("h2", key, "spec-a")).toBeNull();
    expect(notWritable.kill).toHaveBeenCalledTimes(1);
  });

  test("evicts oldest idle entry when maxEntries is full but returns null when all entries are held", () => {
    let now = 0;
    const pool = createAcpWarmPool({ now: () => now, maxEntries: 2 });
    const h1 = handle();
    const h2 = handle();
    pool.deposit(key, { handle: h1, client, sessionId: "s1", specHash: "spec-a" });
    pool.acquire("h1", key, "spec-a");
    now = 10;
    pool.release("h1", key);
    now = 20;
    pool.deposit(key, { handle: h2, client, sessionId: "s2", specHash: "spec-a" });

    now = 30;
    const h3 = handle();
    pool.deposit(key, { handle: h3, client, sessionId: "s3", specHash: "spec-a" });
    expect(h1.kill).toHaveBeenCalledTimes(1);

    const heldPool = createAcpWarmPool({ now: () => now, maxEntries: 2 });
    heldPool.deposit(key, { handle: handle(), client, sessionId: "held-1", specHash: "spec-a" });
    heldPool.deposit(key, { handle: handle(), client, sessionId: "held-2", specHash: "spec-a" });
    heldPool.acquire("h1", key, "spec-a");
    heldPool.acquire("h2", key, "spec-a");
    expect(heldPool.acquire("h3", key, "spec-a")).toBeNull();
  });

  test("evicts max-age and spec-hash mismatches at acquire", () => {
    let now = 0;
    const pool = createAcpWarmPool({ now: () => now, maxAgeMs: 1000 });
    const tooOld = handle();
    pool.deposit(key, { handle: tooOld, client, sessionId: "old", specHash: "spec-a" });
    now = 1001;
    expect(pool.acquire("h1", key, "spec-a")).toBeNull();
    expect(tooOld.kill).toHaveBeenCalledTimes(1);

    const mismatch = handle();
    pool.deposit(key, { handle: mismatch, client, sessionId: "mismatch", specHash: "spec-a" });
    expect(pool.acquire("h2", key, "spec-b")).toBeNull();
    expect(mismatch.kill).toHaveBeenCalledTimes(1);
  });

  test("idle handle exit self-evicts and double eviction is idempotent", async () => {
    const exit = deferred<number | null>();
    const pool = createAcpWarmPool();
    const h = handle({ exited: exit.promise });
    pool.deposit(key, { handle: h, client, sessionId: "s1", specHash: "spec-a" });

    exit.resolve(1);
    await Promise.resolve();
    expect(pool.acquire("h1", key, "spec-a")).toBeNull();
    pool.evict(key);
    expect(h.kill).toHaveBeenCalledTimes(1);
  });

  test("shutdown kills all entries and future acquire returns null", () => {
    const pool = createAcpWarmPool();
    const h = handle();
    pool.deposit(key, { handle: h, client, sessionId: "s1", specHash: "spec-a" });
    pool.shutdown();

    expect(h.kill).toHaveBeenCalledTimes(1);
    expect(pool.acquire("h1", key, "spec-a")).toBeNull();
  });

  test("size() counts live entries across keys and drops to zero on shutdown", () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    expect(pool.size()).toBe(0);

    const other = poolKeyFor({ agent: "codex-acp-fast", cwd: "/other" });
    pool.deposit(key, { handle: handle(), client, sessionId: "s1", specHash: "spec-a" });
    pool.deposit(other, { handle: handle(), client, sessionId: "s2", specHash: "spec-a" });
    expect(pool.size()).toBe(2);

    // A held (acquired) entry still counts as a live process.
    pool.acquire("h1", key, "spec-a");
    expect(pool.size()).toBe(2);

    pool.shutdown();
    expect(pool.size()).toBe(0);
  });

  test("has() is true only while a live entry exists for the key", () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    expect(pool.has(key)).toBe(false);
    pool.deposit(key, { handle: handle(), client, specHash: "spec-a" });
    expect(pool.has(key)).toBe(true);
    pool.shutdown();
    expect(pool.has(key)).toBe(false);
  });
});

describe("AcpWarmPool pinned (pre-warm) entries", () => {
  test("pinned entries survive the idle-grace sweep; non-pinned ones do not", () => {
    let now = 0;
    const other = poolKeyFor({ agent: "codex-acp-fast", cwd: "/other" });
    const pool = createAcpWarmPool({ now: () => now, graceMs: 5_000, maxAgeMs: 1_000_000 });
    const pinned = handle();
    const normal = handle();
    pool.deposit(key, { handle: pinned, client, specHash: "spec-a", pinned: true });
    pool.deposit(other, { handle: normal, client, specHash: "spec-a" });

    now = 6_000; // past idle grace
    pool._sweep();
    expect(pinned.kill).not.toHaveBeenCalled(); // kept warm on purpose
    expect(normal.kill).toHaveBeenCalledTimes(1); // ordinary idle entry reaped
  });

  test("pinned entries are still reaped once past max-age", () => {
    let now = 0;
    const pool = createAcpWarmPool({ now: () => now, graceMs: 5_000, maxAgeMs: 10_000 });
    const pinned = handle();
    pool.deposit(key, { handle: pinned, client, specHash: "spec-a", pinned: true });

    now = 9_999;
    pool._sweep();
    expect(pinned.kill).not.toHaveBeenCalled();

    now = 10_001;
    pool._sweep();
    expect(pinned.kill).toHaveBeenCalledTimes(1);
  });

  test("a pinned deposit replaces the existing IDLE pinned entry (no duplicate accumulation)", () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const first = handle();
    pool.deposit(key, { handle: first, client, specHash: "spec-a", pinned: true });
    expect(pool.size()).toBe(1);

    const second = handle();
    pool.deposit(key, { handle: second, client, specHash: "spec-a", pinned: true });
    expect(first.kill).toHaveBeenCalledTimes(1); // old idle pinned torn down
    expect(pool.size()).toBe(1); // replaced in place
    expect(pool.has(key)).toBe(true);
  });

  test("a pinned deposit does NOT evict an in-use pinned entry (a dispatch holds it)", () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const inUse = handle();
    pool.deposit(key, { handle: inUse, client, specHash: "spec-a", pinned: true });
    pool.acquire("h1", key, "spec-a"); // now held by a dispatch

    const fresh = handle();
    pool.deposit(key, { handle: fresh, client, specHash: "spec-a", pinned: true });
    expect(inUse.kill).not.toHaveBeenCalled();
    expect(pool.size()).toBe(2); // held one preserved + the fresh pinned entry
  });
});
