import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react/pure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MissionControl } from "@src/modules/mission";
import { useMissionStore } from "@src/modules/mission/store";
import { useDaemonStore } from "@src/stores/daemon-store";
import { __resetBrokerForTests, __setSourceFactory } from "@src/api/streams";
import type { EventSourceLike } from "@src/api/event-source-shim";

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

function installFetchStub(sessionBody: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/session/current")) {
      return jsonResponse(sessionBody);
    }
    if (url.includes("/handoffs") && url.includes("status=pending")) {
      return jsonResponse({ handoffs: [] });
    }
    if (url.includes("/usage/quota_status")) {
      return jsonResponse({ dispatched_count: 0, cap: 6 });
    }
    if (url.includes("/usage/subscription_pressure")) {
      return jsonResponse({ windows: [] });
    }
    if (url.includes("/chains")) {
      return jsonResponse({ chains: [] });
    }
    if (url.includes("/health")) {
      return jsonResponse({ status: "ok" });
    }
    return jsonResponse({});
  }) as typeof globalThis.fetch;
}

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

describe("MissionControl elapsed sentinel", () => {
  test("renders '0m' (not ~56yr) when session is the epoch-0 no-session sentinel", async () => {
    installFetchStub({
      id: "no-session",
      project: { id: "—", name: "no project" },
      started_at: new Date(0).toISOString(),
      dispatched: 0,
      resolved: 0,
      failed: 0,
      budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0.8 },
    });

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MissionControl />
      </Wrapper>,
    );

    await waitFor(() => {
      const lede = container.querySelector(".lede")?.textContent ?? "";
      expect(lede).toContain("Maestro session no-session");
      expect(lede).not.toMatch(/\b\d{2,}y\b/);
      expect(lede).not.toMatch(/\bin\.$/);
    });

    unmount();
    client.clear();
  });

  test("renders an elapsed clause when the session is real", async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    installFetchStub({
      id: "session-real",
      project: { id: "p", name: "p" },
      started_at: startedAt,
      dispatched: 0,
      resolved: 0,
      failed: 0,
      budget: { current: 0, max_concurrent: 6, soft_warn_pct: 0.8 },
    });

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MissionControl />
      </Wrapper>,
    );

    await waitFor(() => {
      const lede = container.querySelector(".lede")?.textContent ?? "";
      expect(lede).toContain("Maestro session session-real");
      expect(lede).toMatch(/, \dm in\.$/);
    });

    unmount();
    client.clear();
  });
});
