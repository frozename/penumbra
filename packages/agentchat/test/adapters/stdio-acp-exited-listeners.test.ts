import type { DispatchEventInput } from "@penumbra/core";

import { describe, expect, it, vi } from "bun:test";

import type { StdioAcpClient } from "../../src/adapters/stdio-acp-client.js";
import type { DispatchInput } from "../../src/sdk/adapter.js";

import { createAcpWarmPool } from "../../src/adapters/acp-warm-pool.js";
import { StdioAcpAdapter, type StdioAcpOptions } from "../../src/adapters/stdio-acp.js";
import {
  makeMockAcpClient,
  makeMockAcpHandle,
  type MockAcpHandle,
} from "../helpers/stdio-acp-fixtures.js";

/**
 * Under warm-pool reuse the shared server.exited promise MUST accrue at most
 * a constant number of .then handlers regardless of how many dispatches ride
 * the same pooled process. Before the fix, setupServerLifecycleHandles wired
 * two per-dispatch .then closures — each capturing a fresh DispatchState with
 * accumulatedText — turning the pool's max-age window into an unbounded heap
 * leak (1 + 2N handlers for N reuses). The fix moves listener installation to
 * a per-connection registry so retained state is O(active dispatches).
 */

function makeExitedThenSpy(): {
  exited: Promise<number | null>;
  thenCallCount: () => number;
} {
  const inner = new Promise<number | null>(() => {
    /* never resolves — pool holds the entry for the whole test */
  });
  let count = 0;
  const originalThen = inner.then.bind(inner);
  const wrapper = Object.create(inner) as Promise<number | null>;
  // Replace .then on the wrapper only; the inner promise is untouched so any
  // real handler code still fires (never, since it never resolves).
  (wrapper as unknown as { then: Promise<number | null>["then"] }).then = ((
    ...args: Parameters<Promise<number | null>["then"]>
  ): ReturnType<Promise<number | null>["then"]> => {
    count++;
    return originalThen(...args);
  }) as Promise<number | null>["then"];
  return { exited: wrapper, thenCallCount: (): number => count };
}

function makeServerWithSpy(): { server: MockAcpHandle; thenCallCount: () => number } {
  const { exited, thenCallCount } = makeExitedThenSpy();
  const server = makeMockAcpHandle({ pid: 4242, exited });
  return { server, thenCallCount };
}

function makeTrackedRequest(): StdioAcpClient["request"] {
  let sessionCounter = 0;
  return vi.fn<(method: string, params?: unknown) => Promise<unknown>>((method) => {
    if (method === "initialize") {
      return Promise.resolve({ protocolVersion: 1, authMethods: [] });
    }
    if (method === "session/new") {
      sessionCounter++;
      return Promise.resolve({ sessionId: `session-${String(sessionCounter)}` });
    }
    if (method === "session/prompt") {
      return Promise.resolve({ stopReason: "end_turn" });
    }
    return Promise.resolve({});
  });
}

function makeDispatchInput(handoffId: string, events: DispatchEventInput[]): DispatchInput {
  return {
    prompt: handoffId,
    conversation: { id: handoffId, project_id: null },
    config: {},
    signal: new AbortController().signal,
    handoff_id: handoffId,
    eventContext: { handoffId, workerId: "w1" },
    onEvent: (event): void => {
      events.push(event);
    },
  };
}

describe("StdioAcpAdapter server.exited listener count", () => {
  it("attaches at most a constant number of .then handlers across N pooled reuses", async () => {
    const pool = createAcpWarmPool({ now: () => 0 });
    const { server, thenCallCount } = makeServerWithSpy();
    const startServer = vi.fn().mockResolvedValue(server);
    const request = makeTrackedRequest();
    const opts: StdioAcpOptions = { binary: "mock-acp", warmPool: true };
    const adapter = new StdioAcpAdapter(opts, {
      startServer,
      createClient: (): StdioAcpClient =>
        makeMockAcpClient({ onRequest: vi.fn(), on: vi.fn(), request }),
      pool,
    });

    const events: DispatchEventInput[] = [];
    const N = 25;
    for (let i = 0; i < N; i++) {
      await adapter.dispatch(makeDispatchInput(`h-${String(i)}`, events));
    }

    expect(startServer).toHaveBeenCalledTimes(1);
    // Constant handler count — bounded, does NOT grow with N.
    expect(thenCallCount()).toBeLessThanOrEqual(3);
  });
});
