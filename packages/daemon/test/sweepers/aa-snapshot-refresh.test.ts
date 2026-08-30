import { type AaSnapshotStore, type AaTransport, createAaSnapshotStore } from "@penumbra/core";
import {
  createAaSnapshotRefreshSweepState,
  DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS,
  runAaSnapshotRefreshSweep,
  startAaSnapshotRefreshSweeper,
} from "@src/sweepers/aa-snapshot-refresh.js";
import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function aaModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "aa:model:1",
    name: "Model 1",
    slug: "model-1",
    model_creator: {
      id: "creator:1",
      name: "Creator",
      slug: "creator",
    },
    evaluations: {
      artificial_analysis_intelligence_index: 74.2,
      artificial_analysis_coding_index: 61.5,
      livecodebench: 55.1,
    },
    pricing: {
      price_1m_blended_3_to_1: 3.25,
      price_1m_input_tokens: 1.2,
      price_1m_output_tokens: 7.9,
    },
    median_output_tokens_per_second: 88.4,
    median_time_to_first_token_seconds: 0.74,
    median_time_to_first_answer_token: 1.1,
    ...overrides,
  };
}

function aaResponseBody(data: Record<string, unknown>[] = [aaModel()]): Record<string, unknown> {
  return {
    status: "success",
    prompt_options: {
      data_version: "2026-08-24",
      benchmark_version: "bench-2026-08",
    },
    data,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function keyFilePath(dir: string): string {
  return join(dir, "artificial-analysis.key");
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("aa-snapshot-refresh sweeper", () => {
  test("round trip: stale/missing snapshot + valid transport response -> real store -> read() returns available, fresh, schema-parsed models", async () => {
    await withTempDir("aa-refresh-roundtrip-", async (dir) => {
      const keyPath = keyFilePath(dir);
      await Bun.write(keyPath, "test-aa-key\n");
      const snapshotPath = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path: snapshotPath,
        ttlSeconds: 3600,
        now: (): Date => new Date("2026-08-25T12:00:00.000Z"),
      });

      let requestCount = 0;
      const transport: AaTransport = {
        fetch(_input, init) {
          requestCount += 1;
          expect(new Headers(init?.headers).get("x-api-key")).toBe("test-aa-key");
          return jsonResponse(aaResponseBody());
        },
      };

      const result = await runAaSnapshotRefreshSweep(
        {
          aaSnapshotStore: store,
          transport,
          apiKeyPath: keyPath,
          now: () => new Date("2026-08-25T12:00:00.000Z"),
        },
        createAaSnapshotRefreshSweepState(),
      );

      expect(result.action).toBe("refreshed");
      expect(requestCount).toBe(1);

      const read = await store.read();
      expect(read.state).toBe("available");
      if (read.state !== "available") throw new Error("expected available snapshot");
      expect(read.stale).toBe(false);
      expect(read.snapshot.models).toHaveLength(1);
      expect(read.snapshot.models[0]?.slug).toBe("model-1");
      expect(read.snapshot.provenance.dataVersion).toBe("2026-08-24");
    });
  });

  test("fresh snapshot: no fetch attempted, no-op", async () => {
    await withTempDir("aa-refresh-fresh-", async (dir) => {
      const snapshotPath = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path: snapshotPath,
        ttlSeconds: 3600,
        now: (): Date => new Date("2026-08-25T12:00:00.000Z"),
      });
      await store.write({
        provenance: { collectedAt: "2026-08-25T11:50:00.000Z" },
        models: [aaModel()] as never,
      });

      let requestCount = 0;
      const transport: AaTransport = {
        fetch() {
          requestCount += 1;
          return jsonResponse(aaResponseBody());
        },
      };

      const result = await runAaSnapshotRefreshSweep(
        {
          aaSnapshotStore: store,
          transport,
          apiKeyPath: keyFilePath(dir),
          now: () => new Date("2026-08-25T12:00:00.000Z"),
        },
        createAaSnapshotRefreshSweepState(),
      );

      expect(result.action).toBe("fresh");
      expect(requestCount).toBe(0);
    });
  });

  test("unconfigured key: idles and logs exactly once across repeated ticks", async () => {
    await withTempDir("aa-refresh-unconfigured-", async (dir) => {
      const snapshotPath = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path: snapshotPath,
        ttlSeconds: 3600,
        now: (): Date => new Date("2026-08-25T12:00:00.000Z"),
      });

      let requestCount = 0;
      const transport: AaTransport = {
        fetch() {
          requestCount += 1;
          return jsonResponse(aaResponseBody());
        },
      };
      const warn = mock(() => undefined);
      const state = createAaSnapshotRefreshSweepState();
      const deps = {
        aaSnapshotStore: store,
        transport,
        apiKeyPath: join(dir, "missing.key"),
        now: (): Date => new Date("2026-08-25T12:00:00.000Z"),
        log: { warn },
      };

      const first = await runAaSnapshotRefreshSweep(deps, state);
      const second = await runAaSnapshotRefreshSweep(deps, state);

      expect(first.action).toBe("unconfigured");
      expect(second.action).toBe("unconfigured");
      expect(requestCount).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);

      const read = await store.read();
      expect(read.state).toBe("missing");
    });
  });

  test("fetch failure: last-known-good snapshot is preserved and the failure kind is logged", async () => {
    await withTempDir("aa-refresh-failure-", async (dir) => {
      const keyPath = keyFilePath(dir);
      await Bun.write(keyPath, "test-aa-key\n");
      const snapshotPath = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path: snapshotPath,
        ttlSeconds: 1,
        now: () => new Date("2026-08-25T12:00:00.000Z"),
      });
      await store.write(
        { provenance: { collectedAt: "2026-08-25T10:00:00.000Z" }, models: [aaModel()] as never },
        { fetchedAtIso: "2026-08-25T10:00:00.000Z" },
      );

      const transport: AaTransport = {
        fetch() {
          return jsonResponse({ error: "server exploded" }, { status: 500 });
        },
      };
      const warn = mock(() => undefined);

      const result = await runAaSnapshotRefreshSweep(
        {
          aaSnapshotStore: store,
          transport,
          apiKeyPath: keyPath,
          now: () => new Date("2026-08-25T12:00:00.000Z"),
          log: { warn },
          fetchOptions: { maxAttempts: 1 },
        },
        createAaSnapshotRefreshSweepState(),
      );

      expect(result.action).toBe("fetch_failed");
      expect(result.failureKind).toBe("http");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatchObject({ kind: "http" });

      const read = await store.read();
      expect(read.state).toBe("available");
      if (read.state !== "available") throw new Error("expected available snapshot");
      expect(read.snapshot.models[0]?.slug).toBe("model-1");
    });
  });

  test('fetch succeeds but persisting fails: action is not "refreshed", warn is logged, and backoff state is preserved', async () => {
    await withTempDir("aa-refresh-write-fail-", async (dir) => {
      const keyPath = keyFilePath(dir);
      await Bun.write(keyPath, "test-aa-key\n");
      // A regular file standing where the snapshot's parent directory must be
      // makes mkdir(dirname(path), { recursive: true }) fail (EEXIST/ENOTDIR),
      // simulating an unwritable store path without touching real permissions.
      const blockerPath = join(dir, "blocker");
      await Bun.write(blockerPath, "not a directory");
      const snapshotPath = join(blockerPath, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path: snapshotPath,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-25T12:00:00.000Z"),
      });

      const transport: AaTransport = {
        fetch() {
          return jsonResponse(aaResponseBody());
        },
      };
      const warn = mock(() => undefined);
      const state = createAaSnapshotRefreshSweepState();
      // A prior, already-elapsed backoff window: proves the write failure
      // does not clear existing backoff state.
      const priorBackoffUntilMs = new Date("2026-08-25T11:00:00.000Z").getTime();
      state.backoffUntilMs = priorBackoffUntilMs;

      const result = await runAaSnapshotRefreshSweep(
        {
          aaSnapshotStore: store,
          transport,
          apiKeyPath: keyPath,
          now: () => new Date("2026-08-25T12:00:00.000Z"),
          log: { warn },
        },
        state,
      );

      expect(result.action).toBe("store_write_failed");
      expect(result.action).not.toBe("refreshed");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(state.backoffUntilMs).toBe(priorBackoffUntilMs);

      const read = await store.read();
      expect(read.state).toBe("corrupt");
    });
  });

  test("429 rate limit: respects Retry-After and skips fetching entirely until the backoff elapses", async () => {
    await withTempDir("aa-refresh-429-", async (dir) => {
      const keyPath = keyFilePath(dir);
      await Bun.write(keyPath, "test-aa-key\n");
      const snapshotPath = join(dir, "aa-snapshot.json");
      const store = createAaSnapshotStore({
        path: snapshotPath,
        ttlSeconds: 3600,
        now: () => new Date("2026-08-25T12:00:00.000Z"),
      });

      let requestCount = 0;
      const transport: AaTransport = {
        fetch() {
          requestCount += 1;
          return jsonResponse(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": "120" } },
          );
        },
      };
      const state = createAaSnapshotRefreshSweepState();
      const baseDeps = {
        aaSnapshotStore: store,
        transport,
        apiKeyPath: keyPath,
        fetchOptions: { maxAttempts: 1 },
      };

      const first = await runAaSnapshotRefreshSweep(
        { ...baseDeps, now: () => new Date("2026-08-25T12:00:00.000Z") },
        state,
      );
      expect(first.action).toBe("fetch_failed");
      expect(first.failureKind).toBe("rate_limited");
      expect(requestCount).toBe(1);

      const secondRequestCountBefore = requestCount;
      const second = await runAaSnapshotRefreshSweep(
        { ...baseDeps, now: () => new Date("2026-08-25T12:00:30.000Z") },
        state,
      );
      expect(second.action).toBe("backoff");
      expect(requestCount).toBe(secondRequestCountBefore);

      const third = await runAaSnapshotRefreshSweep(
        { ...baseDeps, now: () => new Date("2026-08-25T12:02:01.000Z") },
        state,
      );
      expect(third.action).toBe("fetch_failed");
      expect(requestCount).toBe(secondRequestCountBefore + 1);

      // Clamp: a Retry-After far beyond the 1h policy ceiling must not produce
      // a backoff window longer than 1h, and the window must be computed from
      // the time AFTER the fetch attempt completes, not the tick-start time.
      const clampState = createAaSnapshotRefreshSweepState();
      const clampNowSequence = [
        new Date("2026-08-25T12:00:00.000Z"), // captured at tick start
        new Date("2026-08-25T12:00:05.000Z"), // re-read after the fetch attempt
      ];
      let clampNowCallCount = 0;
      const clampNow = (): Date => {
        const value = clampNowSequence[Math.min(clampNowCallCount, clampNowSequence.length - 1)]!;
        clampNowCallCount += 1;
        return value;
      };
      const oversizedRetryTransport: AaTransport = {
        fetch() {
          return jsonResponse(
            { error: "rate limited" },
            { status: 429, headers: { "retry-after": "7200" } },
          );
        },
      };
      const clampResult = await runAaSnapshotRefreshSweep(
        {
          aaSnapshotStore: store,
          transport: oversizedRetryTransport,
          apiKeyPath: keyPath,
          now: clampNow,
          fetchOptions: { maxAttempts: 1 },
        },
        clampState,
      );
      expect(clampResult.action).toBe("fetch_failed");
      expect(clampState.backoffUntilMs).toBe(
        new Date("2026-08-25T12:00:05.000Z").getTime() + 60 * 60 * 1000,
      );
    });
  });

  test("startAaSnapshotRefreshSweeper: ticks immediately, defers unref until the first tick settles, ticks again when the interval fires, and stop() clears the timer", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let registeredCb: (() => void) | null = null;
    let capturedIntervalMs: number | undefined;
    let unrefCallCount = 0;
    let timerId: { unref: () => void } | null = null;
    global.setInterval = ((cb: () => void, ms?: number) => {
      registeredCb = cb;
      capturedIntervalMs = ms;
      timerId = {
        unref: (): void => {
          unrefCallCount += 1;
        },
      };
      return timerId;
    }) as unknown as typeof global.setInterval;
    global.clearInterval = mock((id: { unref: () => void }) => {
      expect(id).toBe(timerId);
    }) as unknown as typeof global.clearInterval;

    try {
      await withTempDir("aa-refresh-timer-", async (dir) => {
        const realStore = createAaSnapshotStore({
          path: join(dir, "aa-snapshot.json"),
          ttlSeconds: 3600,
        });
        let readCallCount = 0;
        const store: AaSnapshotStore = {
          read: async () => {
            readCallCount += 1;
            return await realStore.read();
          },
          readSync: () => realStore.readSync(),
          write: (...args) => realStore.write(...args),
          refresh: (...args) => realStore.refresh(...args),
        };
        const transport: AaTransport = {
          fetch() {
            return jsonResponse(aaResponseBody());
          },
        };

        const stop = startAaSnapshotRefreshSweeper({
          aaSnapshotStore: store,
          transport,
          apiKeyPath: join(dir, "missing.key"),
        });

        expect(registeredCb).not.toBeNull();
        expect(capturedIntervalMs).toBe(DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS);
        // The initial tick is still in flight synchronously after start()
        // returns; unref must not fire until it settles (otherwise an
        // otherwise-idle process could exit mid-fetch).
        expect(unrefCallCount).toBe(0);

        // Let the immediate first tick run to completion.
        await waitFor(() => readCallCount >= 1);
        await waitFor(() => unrefCallCount >= 1);

        // Simulate the interval firing: a second sweep must run.
        registeredCb!();
        await waitFor(() => readCallCount >= 2);

        stop();
        expect(global.clearInterval).toHaveBeenCalledWith(timerId);
      });
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });

  test("startAaSnapshotRefreshSweeper: forwards the provided intervalMs to setInterval", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let capturedIntervalMs: number | undefined;
    let unrefCallCount = 0;
    let timerId: { unref: () => void } | null = null;
    global.setInterval = ((_cb: () => void, ms?: number) => {
      capturedIntervalMs = ms;
      timerId = {
        unref: (): void => {
          unrefCallCount += 1;
        },
      };
      return timerId;
    }) as unknown as typeof global.setInterval;
    global.clearInterval = mock(() => undefined);

    try {
      await withTempDir("aa-refresh-timer-custom-", async (dir) => {
        const store = createAaSnapshotStore({
          path: join(dir, "aa-snapshot.json"),
          ttlSeconds: 3600,
        });
        const transport: AaTransport = {
          fetch() {
            return jsonResponse(aaResponseBody());
          },
        };

        const stop = startAaSnapshotRefreshSweeper(
          {
            aaSnapshotStore: store,
            transport,
            apiKeyPath: join(dir, "missing.key"),
          },
          5000,
        );

        expect(capturedIntervalMs).toBe(5000);
        await waitFor(() => unrefCallCount >= 1);
        stop();
      });
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });

  test("startAaSnapshotRefreshSweeper: falls back to the default when intervalMs exceeds the int32 setInterval ceiling", async () => {
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    let capturedIntervalMs: number | undefined;
    let unrefCallCount = 0;
    let timerId: { unref: () => void } | null = null;
    global.setInterval = ((_cb: () => void, ms?: number) => {
      capturedIntervalMs = ms;
      timerId = {
        unref: (): void => {
          unrefCallCount += 1;
        },
      };
      return timerId;
    }) as unknown as typeof global.setInterval;
    global.clearInterval = mock(() => undefined);

    try {
      await withTempDir("aa-refresh-timer-oversized-", async (dir) => {
        const store = createAaSnapshotStore({
          path: join(dir, "aa-snapshot.json"),
          ttlSeconds: 3600,
        });
        const transport: AaTransport = {
          fetch() {
            return jsonResponse(aaResponseBody());
          },
        };

        // 2^31-1 is the largest ms delay setInterval honors; anything above
        // it is normalized to ~1ms by Node/Bun, causing a hot loop.
        const stop = startAaSnapshotRefreshSweeper(
          {
            aaSnapshotStore: store,
            transport,
            apiKeyPath: join(dir, "missing.key"),
          },
          2147483648,
        );

        expect(capturedIntervalMs).toBe(DEFAULT_AA_SNAPSHOT_REFRESH_INTERVAL_MS);
        await waitFor(() => unrefCallCount >= 1);
        stop();
      });
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});
