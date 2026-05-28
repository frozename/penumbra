import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react/pure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MissionControl } from "../../../src/modules/mission";
import { useMissionStore } from "../../../src/modules/mission/store";
import { useDaemonStore } from "../../../src/stores/daemon-store";
import { __resetBrokerForTests, __setSourceFactory } from "../../../src/api/streams";
import type { EventSourceLike } from "../../../src/api/event-source-shim";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

function inertSourceFactory(): EventSourceLike {
  return {
    addEventListener: () => {},
    close: () => {},
  };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "ok",
    lastHealthAt: null,
  });
  useMissionStore.setState({ tailFilter: null, pausedTail: false });
  __resetBrokerForTests();
  __setSourceFactory(inertSourceFactory);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/handoffs") && url.includes("status=pending")) {
      return jsonResponse({ handoffs: [] });
    }
    if (url.includes("/session/current")) {
      return jsonResponse({
        id: "no-session",
        project: { id: "—", name: "no project" },
        started_at: "2026-05-09T00:00:00.000Z",
        dispatched: 0,
        resolved: 0,
        failed: 0,
        budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0.8 },
      });
    }
    if (url.includes("/usage/quota_status")) {
      return jsonResponse({ dispatched_count: 0, cap: 6 });
    }
    if (url.includes("/usage/subscription_pressure")) {
      return jsonResponse({ windows: [] });
    }
    if (url.includes("/chains") && url.includes("status=dispatched")) {
      return jsonResponse({ chains: [] });
    }
    if (url.includes("/chains") && url.includes("status=completed")) {
      return jsonResponse({ chains: [] });
    }
    if (url.includes("/health")) {
      return jsonResponse({ status: "ok" });
    }
    return jsonResponse({});
  }) as typeof globalThis.fetch;
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
  globalThis.fetch = originalFetch;
});

describe("MissionControl compose", () => {
  test("renders all six panels with their card titles", async () => {
    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MissionControl />
      </Wrapper>,
    );

    expect(container.querySelector(".surface-head h1")?.textContent).toContain("Mission control");

    const labels = Array.from(container.querySelectorAll(".lab")).map((el) => el.textContent ?? "");
    expect(labels).toContain("Concurrent dispatches");

    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".card-head h3")).map((el) =>
        (el.textContent ?? "").trim(),
      );
      expect(titles).toContain("Pending handoffs");
      expect(titles).toContain("Pressure");
      expect(titles).toContain("In-flight chains");
      expect(titles).toContain("t0 events");
      expect(titles).toContain("Recently resolved");
    });

    unmount();
    client.clear();
  });

  test("renders the two grid rows with the mc-row class", () => {
    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MissionControl />
      </Wrapper>,
    );

    const rows = container.querySelectorAll(".mc-row");
    expect(rows.length).toBe(2);

    unmount();
    client.clear();
  });

  test("settles into empty-state copy across panels", async () => {
    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MissionControl />
      </Wrapper>,
    );

    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("No handoffs awaiting approval.");
      expect(text).toContain("No pressure data available.");
      expect(text).toContain("No chains running.");
      expect(text).toContain("No resolved chains yet.");
    });

    unmount();
    client.clear();
  });
});
