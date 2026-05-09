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
      getSession: mock(async () => ({
        id: "no-session",
        project: { id: "none", name: "none" },
        started_at: new Date().toISOString(),
        budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0 },
        dispatched: 0,
        resolved: 0,
        failed: 0,
      })),
      getQuotaStatus: mock(async () => ({}) as Record<string, unknown>),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <StatRow client={stubClient} subscribeImpl={noopSubscribe()} />
      </Wrapper>,
    );

    const labels = Array.from(container.querySelectorAll(".lab")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      "Concurrent dispatches",
      "Resolved · session",
      "t0 events · last 5m",
      "Synthetic spend · session",
    ]);
    const values = Array.from(container.querySelectorAll(".val")).map(
      (el) => el.textContent,
    );
    expect(values).toEqual(["—", "—", "—", "—"]);
    const deltas = Array.from(container.querySelectorAll(".d")).map(
      (el) => el.textContent,
    );
    expect(deltas).toEqual(["—", "—", "—", "—"]);
    unmount();
    client.clear();
  });

  test("populates the prototype stat cards from the live session", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getSession: mock(async () => ({
        id: "session-1",
        project: { id: "project-1", name: "mission" },
        started_at: new Date().toISOString(),
        budget: { current: 3, max_concurrent: 6, soft_warn_pct: 0.8 },
        dispatched: 47,
        resolved: 41,
        failed: 2,
      })),
      getQuotaStatus: mock(async () => ({})),
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

    act(() => {
      const now = new Date().toISOString();
      emit({ event: "message", data: { ts: now }, raw: {} as MessageEvent });
      emit({ event: "message", data: { ts: now }, raw: {} as MessageEvent });
      emit({ event: "message", data: { ts: now }, raw: {} as MessageEvent });
    });

    await waitFor(() => {
      const values = Array.from(container.querySelectorAll(".val")).map(
        (el) => el.textContent ?? "",
      );
      expect(values).toEqual(["3/6", "41", "42", "3.94$"]);
      const deltas = Array.from(container.querySelectorAll(".d")).map(
        (el) => el.textContent ?? "",
      );
      expect(deltas).toEqual([
        "50% of cap",
        "47 dispatched · 2 failed",
        "▲ 8% vs 5m prior",
        "all-subscription lane",
      ]);
    });

    unmount();
    client.clear();
  });

  test("renders placeholders when the session is absent", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      getSession: mock(async () => ({
        id: "no-session",
        project: { id: "none", name: "none" },
        started_at: new Date().toISOString(),
        budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0 },
        dispatched: 0,
        resolved: 0,
        failed: 0,
      })),
      getQuotaStatus: mock(async () => ({})),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <StatRow client={stubClient} subscribeImpl={noopSubscribe()} />
      </Wrapper>,
    );

    await waitFor(() => {
      const values = Array.from(container.querySelectorAll(".val")).map(
        (el) => el.textContent ?? "",
      );
      expect(values).toEqual(["—", "—", "—", "—"]);
      const deltas = Array.from(container.querySelectorAll(".d")).map(
        (el) => el.textContent ?? "",
      );
      expect(deltas).toEqual(["—", "—", "—", "—"]);
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
