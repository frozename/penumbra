import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { T0Tail } from "@src/modules/mission/T0Tail";
import { useMissionStore } from "@src/modules/mission/store";
import { __resetBrokerForTests, __setSourceFactory } from "@src/api/streams";
import type { StreamMessage, StreamTopic, Subscription } from "@src/api/streams";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

interface Harness {
  emit: (msg: StreamMessage<unknown>) => void;
  subscribeImpl: SubscribeImpl;
}

function makeHarness(): Harness {
  let emitter: ((msg: StreamMessage<unknown>) => void) | null = null;
  const subscribeImpl = ((..._args: unknown[]) => {
    emitter = _args[1] as (msg: StreamMessage<unknown>) => void;
    return {
      tail: () => [],
      unsubscribe: () => {
        emitter = null;
      },
    } satisfies Subscription;
  }) as unknown as SubscribeImpl;
  return {
    emit: (msg) => {
      if (emitter) emitter(msg);
    },
    subscribeImpl,
  };
}

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper, client };
}

function rawMsg(): MessageEvent {
  return { reconnect: false } as unknown as MessageEvent;
}

class FakeResizeObserver {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.cb(
      [
        {
          target,
          contentRect: {
            width: 600,
            height: 280,
            top: 0,
            left: 0,
            right: 600,
            bottom: 280,
            x: 0,
            y: 0,
          } as DOMRectReadOnly,
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

let originalResizeObserver: typeof ResizeObserver | undefined;
let offsetHeightDescriptor: PropertyDescriptor | undefined;
let offsetWidthDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  useMissionStore.setState({ tailFilter: null, pausedTail: false });
  __resetBrokerForTests();

  originalResizeObserver = (globalThis as { ResizeObserver?: typeof ResizeObserver })
    .ResizeObserver;
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;

  offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  offsetWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains("t0-tail-scroll")) return 280;
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
});

afterEach(() => {
  cleanup();
  __resetBrokerForTests();
  __setSourceFactory(null);
  useMissionStore.setState({ tailFilter: null, pausedTail: false });

  if (originalResizeObserver) {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = originalResizeObserver;
  } else {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  }
  if (offsetHeightDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
  }
  if (offsetWidthDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthDescriptor);
  }
});

describe("T0Tail", () => {
  test("renders a row per event from the stream", async () => {
    const { emit, subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );

    // Stub layout for happy-dom so virtualizer sees nonzero size.
    const scroll = container.querySelector(".t0-tail-scroll") as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 280,
        top: 0,
        left: 0,
        right: 600,
        bottom: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const ts = new Date().toISOString();
    act(() => {
      emit({
        event: "agent.thought",
        data: {
          kind: "agent.thought",
          handoff_id: "h1",
          source: "worker",
          ts,
          worker_id: null,
          meta: null,
        },
        raw: rawMsg(),
      });
      emit({
        event: "claim",
        data: {
          kind: "claim",
          handoff_id: "h2",
          source: "daemon",
          ts,
          worker_id: null,
          meta: null,
        },
        raw: rawMsg(),
      });
      emit({
        event: "watchdog.tick",
        data: {
          kind: "watchdog.tick",
          handoff_id: "h3",
          source: "daemon",
          ts,
          worker_id: null,
          meta: null,
        },
        raw: rawMsg(),
      });
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="t0-row"]');
      expect(rows.length).toBe(3);
    });

    unmount();
    client.clear();
  });

  test("tailFilter narrows the visible rows (case-insensitive substring)", async () => {
    const { emit, subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );
    const scroll = container.querySelector(".t0-tail-scroll") as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 280,
        top: 0,
        left: 0,
        right: 600,
        bottom: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      useMissionStore.setState({ tailFilter: "agent.thought" });
    });

    const ts = new Date().toISOString();
    act(() => {
      for (let i = 0; i < 3; i += 1) {
        emit({
          event: "agent.thought",
          data: {
            kind: "agent.thought",
            handoff_id: `t${i}`,
            source: "worker",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
      for (let i = 0; i < 2; i += 1) {
        emit({
          event: "dispatch.start",
          data: {
            kind: "dispatch.start",
            handoff_id: `d${i}`,
            source: "daemon",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="t0-row"]');
      expect(rows.length).toBe(3);
    });

    unmount();
    client.clear();
  });

  test("pausedTail freezes the snapshot — new events do not change the count", async () => {
    const { emit, subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );
    const scroll = container.querySelector(".t0-tail-scroll") as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 280,
        top: 0,
        left: 0,
        right: 600,
        bottom: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const ts = new Date().toISOString();
    act(() => {
      for (let i = 0; i < 2; i += 1) {
        emit({
          event: "claim",
          data: {
            kind: "claim",
            handoff_id: `h${i}`,
            source: "daemon",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="t0-row"]');
      expect(rows.length).toBe(2);
    });

    act(() => {
      useMissionStore.setState({ pausedTail: true });
    });

    act(() => {
      for (let i = 0; i < 2; i += 1) {
        emit({
          event: "claim",
          data: {
            kind: "claim",
            handoff_id: `n${i}`,
            source: "daemon",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
    });

    // After pause flipped on, the row count should remain at 2.
    const rowsAfter = container.querySelectorAll('[data-testid="t0-row"]');
    expect(rowsAfter.length).toBe(2);

    unmount();
    client.clear();
  });

  test("__reconnect__ synthetic surfaces a reconnected banner", async () => {
    const { emit, subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );
    const scroll = container.querySelector(".t0-tail-scroll") as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 280,
        top: 0,
        left: 0,
        right: 600,
        bottom: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    act(() => {
      emit({
        event: "__reconnect__",
        data: { reconnect: true } as unknown,
        raw: { reconnect: true },
      });
    });

    await waitFor(() => {
      expect(container.textContent).toContain("reconnected");
    });

    unmount();
    client.clear();
  });

  test("resume after pause surfaces events that arrived during the pause", async () => {
    const { emit, subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );
    const scroll = container.querySelector(".t0-tail-scroll") as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 280,
        top: 0,
        left: 0,
        right: 600,
        bottom: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const ts = new Date().toISOString();
    act(() => {
      emit({
        event: "claim",
        data: {
          kind: "claim",
          handoff_id: "pre-1",
          source: "daemon",
          ts,
          worker_id: null,
          meta: null,
        },
        raw: rawMsg(),
      });
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="t0-row"]');
      expect(rows.length).toBe(1);
    });

    act(() => {
      useMissionStore.setState({ pausedTail: true });
    });

    act(() => {
      for (let i = 0; i < 3; i += 1) {
        emit({
          event: "claim",
          data: {
            kind: "claim",
            handoff_id: `mid-${i}`,
            source: "daemon",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
    });

    // Still paused: count stays frozen at the pre-pause snapshot.
    expect(container.querySelectorAll('[data-testid="t0-row"]').length).toBe(1);

    act(() => {
      useMissionStore.setState({ pausedTail: false });
    });

    // After resume, the 3 during-pause events are now visible alongside the
    // pre-pause row.
    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="t0-row"]');
      expect(rows.length).toBe(4);
    });

    unmount();
    client.clear();
  });

  test("pause invariant survives an SSE reconnect (frozen view stays frozen)", async () => {
    const { emit, subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );
    const scroll = container.querySelector(".t0-tail-scroll") as HTMLElement;
    scroll.getBoundingClientRect = () =>
      ({
        width: 600,
        height: 280,
        top: 0,
        left: 0,
        right: 600,
        bottom: 280,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const ts = new Date().toISOString();
    act(() => {
      for (let i = 0; i < 2; i += 1) {
        emit({
          event: "claim",
          data: {
            kind: "claim",
            handoff_id: `pre-${i}`,
            source: "daemon",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="t0-row"]');
      expect(rows.length).toBe(2);
    });

    act(() => {
      useMissionStore.setState({ pausedTail: true });
    });

    // Reconnect lands while paused — useStream resets its buffer and bumps
    // reconnectCount. Without the pause-invariant fix, frozenRef would be
    // nulled and the memo would fall through to the (now-live) stream,
    // letting post-reconnect events leak into the display while paused.
    act(() => {
      emit({
        event: "__reconnect__",
        data: { reconnect: true } as unknown,
        raw: { reconnect: true },
      });
    });

    act(() => {
      for (let i = 0; i < 3; i += 1) {
        emit({
          event: "claim",
          data: {
            kind: "claim",
            handoff_id: `post-${i}`,
            source: "daemon",
            ts,
            worker_id: null,
            meta: null,
          },
          raw: rawMsg(),
        });
      }
    });

    // Pause invariant: while paused, the row count must not grow even after
    // a reconnect + subsequent events. The frozen view holds whatever was
    // captured at the reconnect tick (post-reset, so the count goes to 0).
    const rowsAfter = container.querySelectorAll('[data-testid="t0-row"]');
    expect(rowsAfter.length).toBe(0);

    unmount();
    client.clear();
  });

  test("pause button toggles useMissionStore.pausedTail", async () => {
    const { subscribeImpl } = makeHarness();
    const { Wrapper, client } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <T0Tail subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );

    const findButton = (): HTMLButtonElement => {
      const btns = Array.from(container.querySelectorAll("button"));
      const btn = btns.find((b) => /pause|resume/i.test(b.textContent ?? ""));
      if (!btn) throw new Error("pause/resume button not found");
      return btn as HTMLButtonElement;
    };

    expect(useMissionStore.getState().pausedTail).toBe(false);

    act(() => {
      fireEvent.click(findButton());
    });
    expect(useMissionStore.getState().pausedTail).toBe(true);

    act(() => {
      fireEvent.click(findButton());
    });
    expect(useMissionStore.getState().pausedTail).toBe(false);

    unmount();
    client.clear();
  });
});
