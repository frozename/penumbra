import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __resetBrokerForTests,
  type StreamMessage,
  type StreamTopic,
  type Subscription,
} from "@src/api/streams";
import { useLiveQuery } from "@src/hooks/useLiveQuery";
import { useUIStore } from "@src/stores/ui-store";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

interface Harness {
  emit: (msg: StreamMessage<unknown>) => void;
  subscribeImpl: SubscribeImpl;
  subscribeCalls: () => number;
  lastParams: () => Record<string, string> | undefined;
  unsubCalls: () => number;
}

function makeHarness(): Harness {
  let emitter: ((msg: StreamMessage<unknown>) => void) | null = null;
  let calls = 0;
  let lastP: Record<string, string> | undefined;
  let unsubs = 0;
  const subscribeImpl = ((...args: any[]) => {
    calls += 1;
    emitter = args[1] as (msg: StreamMessage<unknown>) => void;
    const opts = args[2] as { params?: Record<string, string> } | undefined;
    lastP = opts?.params;
    return {
      tail: () => [],
      unsubscribe: () => {
        unsubs += 1;
        emitter = null;
      },
    } satisfies Subscription;
  }) as unknown as SubscribeImpl;
  return {
    emit: (msg) => {
      if (emitter) emitter(msg);
    },
    subscribeImpl,
    subscribeCalls: () => calls,
    lastParams: () => lastP,
    unsubCalls: () => unsubs,
  };
}

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper, client };
}

function frameMsg(data: unknown): StreamMessage<unknown> {
  return { event: "message", data, raw: { data: JSON.stringify(data), type: "message" } };
}

function resyncMsg(): StreamMessage<unknown> {
  return { event: ": resync", data: ": resync", raw: { data: ": resync", type: ": resync" } };
}

function reconnectMsg(): StreamMessage<unknown> {
  return { event: "__reconnect__", data: { reconnect: true }, raw: { reconnect: true } };
}

describe("useLiveQuery", () => {
  beforeEach(() => {
    __resetBrokerForTests();
    useUIStore.setState({ activeModule: "mission", explorerCollapsed: false });
  });

  afterEach(() => {
    __resetBrokerForTests();
    useUIStore.setState({ activeModule: "mission", explorerCollapsed: false });
  });

  test("a frame invalidates the key exactly once per frame; a ': resync' comment counts as a frame", async () => {
    const harness = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const origInvalidate = client.invalidateQueries.bind(client);
    const invalidateSpy = mock((...args: any[]) => origInvalidate(...args));
    client.invalidateQueries = invalidateSpy as typeof client.invalidateQueries;

    const queryFn = mock(async () => 42);

    const { result } = renderHook(
      () =>
        useLiveQuery<number>(
          { queryKey: ["test"], queryFn, owner: "mission", topic: "dispatch-events" },
          { subscribeImpl: harness.subscribeImpl },
        ),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toBe(42);
    });
    const callsBefore = invalidateSpy.mock.calls.length;

    act(() => {
      harness.emit(frameMsg({ a: 1 }));
      harness.emit(frameMsg({ b: 2 }));
      harness.emit(resyncMsg());
    });

    await waitFor(() => {
      expect(invalidateSpy.mock.calls.length).toBe(callsBefore + 3);
    });
    for (const call of invalidateSpy.mock.calls.slice(callsBefore)) {
      expect(call[0]).toEqual({ queryKey: ["test"] });
    }
  });

  test("__reconnect__ invalidates", async () => {
    const harness = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const origInvalidate = client.invalidateQueries.bind(client);
    const invalidateSpy = mock((...args: any[]) => origInvalidate(...args));
    client.invalidateQueries = invalidateSpy as typeof client.invalidateQueries;

    const queryFn = mock(async () => "ok");

    const { result } = renderHook(
      () =>
        useLiveQuery<string>(
          { queryKey: ["recon"], queryFn, owner: "mission", topic: "dispatch-events" },
          { subscribeImpl: harness.subscribeImpl },
        ),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toBe("ok");
    });
    const callsBefore = invalidateSpy.mock.calls.length;

    act(() => {
      harness.emit(reconnectMsg());
    });

    await waitFor(() => {
      expect(invalidateSpy.mock.calls.length).toBe(callsBefore + 1);
    });
    expect(invalidateSpy.mock.calls[callsBefore]![0]).toEqual({ queryKey: ["recon"] });
  });

  test("with no topic it polls at pollMs; while connected refetchInterval is false (fake timers)", async () => {
    // Part A: no topic → refetchInterval = pollMs. Verify via the query cache
    // options (deterministic — no reliance on real setInterval under load).
    const pollHarness = makeHarness();
    const { Wrapper: WrapperA, client: clientA } = makeWrapper();
    const queryFnA = mock(async () => ({ n: 1 }));

    const { unmount: unmountA } = renderHook(
      () =>
        useLiveQuery<{ n: number }>(
          { queryKey: ["poll"], queryFn: queryFnA, owner: "mission", pollMs: 50 },
          { subscribeImpl: pollHarness.subscribeImpl },
        ),
      { wrapper: WrapperA },
    );

    await waitFor(() => {
      expect(queryFnA).toHaveBeenCalledTimes(1);
    });
    expect(pollHarness.subscribeCalls()).toBe(0);
    const pollQuery = clientA.getQueryCache().find({ queryKey: ["poll"] });
    expect((pollQuery?.options as { refetchInterval?: unknown }).refetchInterval).toBe(50);
    unmountA();

    // Part B: with topic → refetchInterval is false (no polling, only invalidation).
    const topicHarness = makeHarness();
    const { Wrapper: WrapperB, client: clientB } = makeWrapper();
    const queryFnB = mock(async () => "val");

    const { result: resultB } = renderHook(
      () =>
        useLiveQuery<string>(
          {
            queryKey: ["topic-poll"],
            queryFn: queryFnB,
            owner: "mission",
            topic: "dispatch-events",
          },
          { subscribeImpl: topicHarness.subscribeImpl },
        ),
      { wrapper: WrapperB },
    );

    await waitFor(() => {
      expect(resultB.current.data).toBe("val");
    });
    expect(topicHarness.subscribeCalls()).toBe(1);
    const topicQuery = clientB.getQueryCache().find({ queryKey: ["topic-poll"] });
    expect((topicQuery?.options as { refetchInterval?: unknown }).refetchInterval).toBe(false);

    const callsAfterInitial = queryFnB.mock.calls.length;

    // An invalidation triggers a refetch — proving the subscription drives
    // updates, not a refetchInterval.
    act(() => {
      topicHarness.emit(frameMsg({ x: 1 }));
    });
    await waitFor(() => {
      expect(queryFnB.mock.calls.length).toBeGreaterThan(callsAfterInitial);
    });
  });

  test("when activeModule ≠ owner it opens zero subscriptions and does not poll", async () => {
    useUIStore.setState({ activeModule: "sessions" });

    const harness = makeHarness();
    const { Wrapper, client } = makeWrapper();
    const queryFn = mock(async () => "never");

    const { result } = renderHook(
      () =>
        useLiveQuery<string>(
          {
            queryKey: ["inactive"],
            queryFn,
            owner: "mission",
            topic: "dispatch-events",
            pollMs: 50,
          },
          { subscribeImpl: harness.subscribeImpl },
        ),
      { wrapper: Wrapper },
    );

    await new Promise((r) => setTimeout(r, 80));
    expect(harness.subscribeCalls()).toBe(0);
    expect(queryFn).not.toHaveBeenCalled();
    expect(result.current.live).toBe("off");
  });

  test("an options object with patch:true throws at runtime", () => {
    const { Wrapper } = makeWrapper();
    expect(() =>
      renderHook(
        () =>
          useLiveQuery<number>(
            {
              queryKey: ["patch"],
              queryFn: async () => 1,
              owner: "mission",
              patch: true,
            } as unknown as Parameters<typeof useLiveQuery<number>>[0],
            { subscribeImpl: makeHarness().subscribeImpl },
          ),
        { wrapper: Wrapper },
      ),
    ).toThrow("useLiveQuery: patch mode is not supported");
  });

  test("forwards params into subscribe", async () => {
    const harness = makeHarness();
    const { Wrapper } = makeWrapper();
    const queryFn = mock(async () => 42);

    renderHook(
      () =>
        useLiveQuery<number>(
          {
            queryKey: ["params-test"],
            queryFn,
            owner: "mission",
            topic: "dispatch-events",
            params: { kind: "a" },
          },
          { subscribeImpl: harness.subscribeImpl },
        ),
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect(harness.subscribeCalls()).toBe(1);
    });
    expect(harness.lastParams()).toEqual({ kind: "a" });
  });

  test("changed params resubscribe; equal params (new object) do not", async () => {
    const harness = makeHarness();
    const { Wrapper } = makeWrapper();
    const queryFn = mock(async () => 42);

    const { rerender } = renderHook(
      ({ params }) =>
        useLiveQuery<number>(
          {
            queryKey: ["params-change"],
            queryFn,
            owner: "mission",
            topic: "dispatch-events",
            params,
          },
          { subscribeImpl: harness.subscribeImpl },
        ),
      { wrapper: Wrapper, initialProps: { params: { kind: "a" } } },
    );

    await waitFor(() => {
      expect(harness.subscribeCalls()).toBe(1);
    });

    // Changed params → resubscribe
    act(() => {
      rerender({ params: { kind: "b" } });
    });
    await waitFor(() => {
      expect(harness.subscribeCalls()).toBe(2);
    });
    expect(harness.unsubCalls()).toBe(1);
    expect(harness.lastParams()).toEqual({ kind: "b" });

    // Equal params (new object, same values) → no resubscribe
    act(() => {
      rerender({ params: { kind: "b" } });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.subscribeCalls()).toBe(2);
  });
});
