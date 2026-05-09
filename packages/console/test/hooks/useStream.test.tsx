import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  __resetBrokerForTests,
  type StreamMessage,
  type StreamTopic,
  type Subscription,
} from "../../src/api/streams";
import { useStream } from "../../src/hooks/useStream";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

describe("useStream", () => {
  beforeEach(() => {
    __resetBrokerForTests();
  });

  afterEach(() => {
    __resetBrokerForTests();
  });

  test("subscribes on mount and accumulates live messages", async () => {
    let emit!: (msg: StreamMessage<{ id: number }>) => void;
    const subscribeImpl = mock(((...args: any[]) => {
      const onMessage = args[1] as typeof emit;
      emit = onMessage;
      return {
        tail: () => [],
        unsubscribe: mock(() => {}),
      };
    }) as any) as SubscribeImpl;

    const { result } = renderHook(() =>
      useStream<{ id: number }>(
        "dispatch-events",
        {
          params: { a: "1", b: "2" },
          enabled: true,
        },
        { subscribeImpl },
      ),
    );

    expect(subscribeImpl).toHaveBeenCalledTimes(1);
    expect(result.current.reconnectCount).toBe(0);

    act(() => {
      emit({
        event: "message",
        data: { id: 1 },
        raw: { reconnect: false } as unknown as MessageEvent,
      });
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]!.data).toEqual({ id: 1 });
    expect(result.current.reconnectCount).toBe(0);
  });

  test("reconnect clears messages and increments reconnectCount per reconnect", async () => {
    let emit!: (msg: StreamMessage<{ id?: number }>) => void;
    const subscribeImpl = mock(((...args: any[]) => {
      const onMessage = args[1] as typeof emit;
      emit = onMessage;
      return {
        tail: () => [],
        unsubscribe: mock(() => {}),
      };
    }) as any) as SubscribeImpl;

    const { result } = renderHook(() =>
      useStream<{ id?: number }>(
        "dispatch-events",
        { enabled: true },
        { subscribeImpl },
      ),
    );

    act(() => {
      emit({
        event: "message",
        data: { id: 1 },
        raw: { reconnect: false } as unknown as MessageEvent,
      });
      emit({
        event: "__reconnect__",
        data: { reconnect: true } as any,
        raw: { reconnect: true },
      });
    });

    await waitFor(() => expect(result.current.reconnectCount).toBe(1));
    expect(result.current.messages).toHaveLength(0);

    act(() => {
      emit({
        event: "__reconnect__",
        data: { reconnect: true } as any,
        raw: { reconnect: true },
      });
    });

    await waitFor(() => expect(result.current.reconnectCount).toBe(2));
    expect(subscribeImpl).toHaveBeenCalledTimes(1);
  });

  test("unsubscribes on unmount", () => {
    const unsubscribe = mock(() => {});
    const subscribeImpl = mock(
      ((..._args: any[]) => ({
        tail: () => [],
        unsubscribe,
      })) as any,
    ) as SubscribeImpl;

    const { unmount } = renderHook(() =>
      useStream("dispatch-events", { enabled: true }, { subscribeImpl }),
    );

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("enabled false skips subscription, then enables once flipped", () => {
    const subscribeImpl = mock(
      ((..._args: any[]) => ({
        tail: () => [],
        unsubscribe: mock(() => {}),
      })) as any,
    ) as SubscribeImpl;

    const { rerender } = renderHook(
      ({ enabled }) =>
        useStream("dispatch-events", { enabled, params: { a: "1" } }, { subscribeImpl }),
      { initialProps: { enabled: false } },
    );

    expect(subscribeImpl).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(subscribeImpl).toHaveBeenCalledTimes(1);
  });

  test("bounds messages to default bufferSize (200), dropping oldest", async () => {
    let emit!: (msg: StreamMessage<{ i: number }>) => void;
    const subscribeImpl = mock(((...args: any[]) => {
      const onMessage = args[1] as typeof emit;
      emit = onMessage;
      return {
        tail: () => [],
        unsubscribe: mock(() => {}),
      };
    }) as any) as SubscribeImpl;

    const { result } = renderHook(() =>
      useStream<{ i: number }>(
        "dispatch-events",
        { enabled: true },
        { subscribeImpl },
      ),
    );

    act(() => {
      for (let i = 0; i < 250; i++) {
        emit({
          event: "message",
          data: { i },
          raw: { reconnect: false } as unknown as MessageEvent,
        });
      }
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(200));
    // Oldest 50 dropped — first kept is index 50, last is 249.
    expect(result.current.messages[0]!.data).toEqual({ i: 50 });
    expect(result.current.messages[199]!.data).toEqual({ i: 249 });
  });

  test("respects custom bufferSize option", async () => {
    let emit!: (msg: StreamMessage<{ i: number }>) => void;
    const subscribeImpl = mock(((...args: any[]) => {
      const onMessage = args[1] as typeof emit;
      emit = onMessage;
      return {
        tail: () => [],
        unsubscribe: mock(() => {}),
      };
    }) as any) as SubscribeImpl;

    const { result } = renderHook(() =>
      useStream<{ i: number }>(
        "dispatch-events",
        { enabled: true, bufferSize: 50 },
        { subscribeImpl },
      ),
    );

    act(() => {
      for (let i = 0; i < 100; i++) {
        emit({
          event: "message",
          data: { i },
          raw: { reconnect: false } as unknown as MessageEvent,
        });
      }
    });

    await waitFor(() => expect(result.current.messages).toHaveLength(50));
    expect(result.current.messages[0]!.data).toEqual({ i: 50 });
    expect(result.current.messages[49]!.data).toEqual({ i: 99 });
  });

  test("same params across rerender does not resubscribe", () => {
    const subscribeImpl = mock(
      ((..._args: any[]) => ({
        tail: () => [],
        unsubscribe: mock(() => {}),
      })) as any,
    ) as SubscribeImpl;

    const { rerender } = renderHook(
      ({ a }) =>
        useStream("dispatch-events", { params: { a, b: "2" } }, { subscribeImpl }),
      { initialProps: { a: "1" } },
    );

    expect(subscribeImpl).toHaveBeenCalledTimes(1);
    rerender({ a: "1" });
    expect(subscribeImpl).toHaveBeenCalledTimes(1);
  });
});
