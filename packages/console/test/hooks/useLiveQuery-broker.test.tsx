import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { expect, mock, test } from "bun:test";

import { createStreamBroker } from "@src/api/streams";
import { useLiveQuery } from "@src/hooks/useLiveQuery";
import { useUIStore } from "@src/stores/ui-store";

test("conversation changes detach callbacks, preserve peers and linger, and use the latest query key", () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  const sources: { url: string; closed: boolean; emit: () => void }[] = [];
  const broker = createStreamBroker({
    getConfig: () => ({ baseUrl: "http://test.local", token: "" }),
    scheduler: {
      setTimeout: ((fn: () => void, ms: number) => {
        const id = ++nextId;
        timers.set(id, { at: now + ms, fn });
        return id;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeout: ((id: number) => {
        timers.delete(id);
      }) as unknown as typeof globalThis.clearTimeout,
    },
    sourceFactory: (opts) => {
      const listeners: ((msg: { data: string; type: string }) => void)[] = [];
      const source = {
        url: opts.url,
        closed: false,
        emit: (): void => {
          for (const listener of listeners) listener({ data: "{}", type: "message" });
        },
      };
      sources.push(source);
      opts.onConnected?.();
      return {
        addEventListener: (event, listener): void => {
          if (event === "message") listeners.push(listener);
        },
        close: (): void => {
          source.closed = true;
        },
      };
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const invalidate = mock(async (_filters: { queryKey?: readonly unknown[] }) => {});
  client.invalidateQueries = invalidate as typeof client.invalidateQueries;
  const peer = mock(() => {});
  const peerSub = broker.subscribe("conversation", peer, { params: { id: "c1" } });
  const previousModule = useUIStore.getState().activeModule;
  useUIStore.setState({ activeModule: "mission" });
  const { rerender, unmount } = renderHook(
    ({ id, suffix }) =>
      useLiveQuery(
        {
          queryKey: ["conversation", id, suffix],
          queryFn: async () => 1,
          owner: "mission",
          topic: "conversation",
          params: { id },
        },
        { subscribeImpl: broker.subscribe },
      ),
    {
      initialProps: { id: "c1", suffix: "first" },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  try {
    expect(sources).toHaveLength(1);
    act(() => {
      rerender({ id: "c2", suffix: "first" });
    });
    expect(sources).toHaveLength(2);
    expect(sources[1]!.url).toBe("http://test.local/conversations/c2/stream");
    act(() => {
      sources[0]!.emit();
    });
    expect(peer).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
    advance(30_000);
    expect(sources[0]!.closed).toBe(false);
    peerSub.unsubscribe();
    advance(29_999);
    expect(sources[0]!.closed).toBe(false);
    advance(1);
    expect(sources[0]!.closed).toBe(true);
    expect(sources[1]!.closed).toBe(false);
    act(() => {
      rerender({ id: "c2", suffix: "latest" });
    });
    expect(sources).toHaveLength(2);
    act(() => {
      sources[1]!.emit();
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate.mock.calls[0]).toEqual([{ queryKey: ["conversation", "c2", "latest"] }]);
    unmount();
    act(() => {
      sources[1]!.emit();
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    advance(29_999);
    expect(sources[1]!.closed).toBe(false);
    advance(1);
    expect(sources[1]!.closed).toBe(true);
  } finally {
    unmount();
    broker.reset();
    client.clear();
    useUIStore.setState({ activeModule: previousModule });
  }
});
