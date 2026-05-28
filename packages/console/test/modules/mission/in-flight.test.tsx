import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InFlightChains } from "../../../src/modules/mission/InFlightChains";
import { useDaemonStore } from "../../../src/stores/daemon-store";

function makeWrapper(): {
  Wrapper: ({ children }: { children: React.ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  function Wrapper({ children }: { children: React.ReactNode }): JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { Wrapper, client };
}

beforeEach(() => {
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "t",
    health: "ok",
    lastHealthAt: 0,
  });
});

afterEach(() => {
  cleanup();
  useDaemonStore.setState({
    baseUrl: "",
    token: "",
    health: "unknown",
    lastHealthAt: null,
  });
});

describe("InFlightChains", () => {
  test("renders live chain cards from the daemon", async () => {
    const fetchStub = mock(
      async () =>
        new Response(
          JSON.stringify({
            chains: [
              {
                conversation_id: "c-1",
                project_id: null,
                latest_status: "dispatched",
                latest_ts: "2026-05-08T22:00:00Z",
                earliest_ts: "2026-05-08T21:55:00Z",
                handoff_count: 3,
                root_handoff_id: "h-abc12345",
                to_agent: null,
                to_role: null,
              },
              {
                conversation_id: "c-2",
                project_id: null,
                latest_status: "dispatched",
                latest_ts: "2026-05-08T22:01:00Z",
                earliest_ts: "2026-05-08T21:58:00Z",
                handoff_count: 1,
                root_handoff_id: null,
                to_agent: null,
                to_role: null,
              },
            ],
            next_offset: 2,
            limit: 2,
            offset: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <InFlightChains />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".chain-card")).toHaveLength(2);
    });

    expect(container.textContent).toContain("h-abc1234");
    expect(container.textContent).toContain("3 hops");
    expect(container.textContent).toContain("dispatched");
    expect(container.textContent).toContain("c-1");

    unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  });

  test("renders the empty state when no chains are running", async () => {
    const fetchStub = mock(
      async () =>
        new Response(
          JSON.stringify({
            chains: [],
            next_offset: 0,
            limit: 50,
            offset: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <InFlightChains />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("No chains running.");
    });

    unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  });

  test("does not render the disabled P1 open button", async () => {
    const fetchStub = mock(
      async () =>
        new Response(
          JSON.stringify({
            chains: [
              {
                conversation_id: "c-1",
                project_id: null,
                latest_status: "dispatched",
                latest_ts: "2026-05-08T22:00:00Z",
                earliest_ts: "2026-05-08T21:55:00Z",
                handoff_count: 3,
                root_handoff_id: "h-abc12345",
                to_agent: null,
                to_role: null,
              },
            ],
            next_offset: 1,
            limit: 1,
            offset: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <InFlightChains />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".chain-card")).toHaveLength(1);
    });

    expect(container.querySelector("button[aria-label='Open chain (P1)']")).toBeNull();

    unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  });
});
