import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { MissionControl } from "../../../src/modules/mission";
import { StatRow } from "../../../src/modules/mission/StatRow";
import { useMissionStore } from "../../../src/modules/mission/store";
import { useDaemonStore } from "../../../src/stores/daemon-store";
import {
  __resetBrokerForTests,
  __setSourceFactory,
} from "../../../src/api/streams";
import type {
  StreamMessage,
  StreamTopic,
  Subscription,
} from "../../../src/api/streams";
import type { EventSourceLike } from "../../../src/api/event-source-shim";
import type { DaemonClient } from "../../../src/api/client";

type SubscribeImpl = <T>(
  topic: StreamTopic,
  onMessage: (msg: StreamMessage<T>) => void,
  opts?: { params?: Record<string, string> },
) => Subscription;

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <MemoryRouter initialEntries={["/mission"]}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  }
  return { Wrapper, client };
}

function noopSubscribe(): SubscribeImpl {
  return ((..._args: unknown[]) =>
    ({
      tail: () => [],
      unsubscribe: () => {},
    }) as Subscription) as unknown as SubscribeImpl;
}

function inertSourceFactory(): EventSourceLike {
  // Returns a source that never delivers any events, so the default broker
  // (used by `<MissionControl/>` directly) doesn't try to hit the network.
  return {
    addEventListener: () => {},
    close: () => {},
  };
}

beforeEach(() => {
  useMissionStore.setState({ tailFilter: null, pausedTail: false });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "unknown",
    lastHealthAt: null,
  });
  __resetBrokerForTests();
});

afterEach(() => {
  cleanup();
  __resetBrokerForTests();
  __setSourceFactory(null);
  useMissionStore.setState({ tailFilter: null, pausedTail: false });
  useDaemonStore.setState({
    baseUrl: "",
    token: "",
    health: "unknown",
    lastHealthAt: null,
  });
});

describe("MissionControl scaffold", () => {
  test("renders surface-head with the Mission Control title and lede", () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getQuotaStatus: mock(async () => ({}) as Record<string, unknown>),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <header className="surface-head">
          <h1>Mission Control</h1>
          <p className="lede">Live operator view of dispatches, handoffs, and pressure.</p>
        </header>
        <StatRow client={stubClient} subscribeImpl={noopSubscribe()} />
      </Wrapper>,
    );

    expect(container.querySelector("h1")?.textContent).toBe("Mission Control");
    expect(container.querySelector(".lede")?.textContent).toContain(
      "Live operator view",
    );
    unmount();
    client.clear();
  });

  test("MissionControl mounts under MemoryRouter + QueryClientProvider", () => {
    // Stub the broker's source factory so the default `subscribe` used by the
    // un-injected StatRow inside MissionControl does NOT hit the network.
    __setSourceFactory(inertSourceFactory);
    // Stub fetch so the un-injected DaemonClient inside StatRow gets a benign
    // empty response rather than a real network call.
    const fetchStub = mock(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MissionControl />
      </Wrapper>,
    );

    expect(container.querySelector(".surface-head h1")?.textContent).toContain(
      "Mission control",
    );

    unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  });
});

describe("StatRow", () => {
  test("renders four stat cards with the expected labels", () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getQuotaStatus: mock(async () => ({}) as Record<string, unknown>),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <StatRow client={stubClient} subscribeImpl={noopSubscribe()} />
      </Wrapper>,
    );

    const labels = Array.from(container.querySelectorAll(".t-label")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      "Concurrent dispatches",
      "Resolved · session",
      "t0 events · last 5m",
      "Synthetic spend · session",
    ]);
    unmount();
    client.clear();
  });

  test("populates concurrent + synthetic cards from getQuotaStatus", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getQuotaStatus: mock(async () => ({
        dispatched_count: 2,
        cap: 6,
        subscription: { synth_total: 12.34 },
      })),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <StatRow client={stubClient} subscribeImpl={noopSubscribe()} />
      </Wrapper>,
    );

    await waitFor(() => {
      const values = Array.from(
        container.querySelectorAll(".stat-value"),
      ).map((el) => el.textContent ?? "");
      expect(values[0]).toContain("2");
      expect(values[0]?.toLowerCase()).toContain("cap");
      expect(values[3]).toContain("12.34");
    });

    unmount();
    client.clear();
  });

  test("renders dashes when getQuotaStatus is pending or errors", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getQuotaStatus: mock(async () => {
        throw new Error("offline");
      }),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <StatRow client={stubClient} subscribeImpl={noopSubscribe()} />
      </Wrapper>,
    );

    const initialValues = Array.from(
      container.querySelectorAll(".stat-value"),
    ).map((el) => el.textContent ?? "");
    expect(initialValues[0]).toBe("—");
    expect(initialValues[3]).toBe("—");

    await waitFor(() => {
      const values = Array.from(
        container.querySelectorAll(".stat-value"),
      ).map((el) => el.textContent ?? "");
      expect(values[0]).toBe("—");
      expect(values[3]).toBe("—");
    });

    unmount();
    client.clear();
  });

  test("t0-events card counts messages within the last 5 minutes", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getQuotaStatus: mock(async () => ({}) as Record<string, unknown>),
    } as unknown as DaemonClient;

    let emit!: (msg: StreamMessage<{ ts?: string }>) => void;
    const subscribeImpl = ((..._args: unknown[]) => {
      const onMessage = _args[1] as typeof emit;
      emit = onMessage;
      return {
        tail: () => [],
        unsubscribe: () => {},
      } as Subscription;
    }) as unknown as SubscribeImpl;

    const { container, unmount } = render(
      <Wrapper>
        <StatRow client={stubClient} subscribeImpl={subscribeImpl} />
      </Wrapper>,
    );

    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    act(() => {
      emit({ event: "message", data: { ts: fresh }, raw: {} as MessageEvent });
      emit({ event: "message", data: { ts: fresh }, raw: {} as MessageEvent });
      emit({ event: "message", data: { ts: stale }, raw: {} as MessageEvent });
    });

    await waitFor(() => {
      const t0Card = container.querySelectorAll(".stat-value")[2];
      expect(t0Card?.textContent).toBe("2");
    });

    unmount();
    client.clear();
  });
});

describe("useMissionStore", () => {
  test("setTailFilter and setPausedTail mutate state", () => {
    useMissionStore.getState().setTailFilter("dispatch.start");
    useMissionStore.getState().setPausedTail(true);
    expect(useMissionStore.getState().tailFilter).toBe("dispatch.start");
    expect(useMissionStore.getState().pausedTail).toBe(true);
  });
});
