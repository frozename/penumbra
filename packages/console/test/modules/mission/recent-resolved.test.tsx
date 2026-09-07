import "../../setup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { RecentResolved } from "@src/modules/mission/RecentResolved";
import { useDaemonStore } from "@src/stores/daemon-store";

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

describe("RecentResolved", () => {
  test("renders recently resolved chains with status dots", async () => {
    const fetchStub = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/chains") && url.includes("status=completed")) {
        return new Response(
          JSON.stringify({
            chains: [
              {
                conversation_id: "c-1",
                project_id: null,
                latest_status: "completed",
                latest_ts: "2026-05-08T22:00:00Z",
                earliest_ts: "2026-05-08T21:55:00Z",
                handoff_count: 5,
                root_handoff_id: "h-aa11bb22",
                to_agent: null,
                to_role: null,
              },
              {
                conversation_id: "c-2",
                project_id: null,
                latest_status: "failed",
                latest_ts: "2026-05-08T22:01:00Z",
                earliest_ts: "2026-05-08T21:58:00Z",
                handoff_count: 2,
                root_handoff_id: null,
                to_agent: null,
                to_role: null,
              },
            ],
            next_offset: 2,
            limit: 4,
            offset: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ chains: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <RecentResolved />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".rr-row")).toHaveLength(2);
    });

    const rows = container.querySelectorAll(".rr-row");
    const firstDot = rows[0]?.firstElementChild;
    const secondDot = rows[1]?.firstElementChild;
    expect(firstDot?.getAttribute("class") ?? "").toContain("dot-ok");
    expect(secondDot?.getAttribute("class") ?? "").toContain("dot-err");

    unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  });

  test("renders the empty state when no chains are resolved", async () => {
    const fetchStub = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/chains") && url.includes("status=completed")) {
        return new Response(
          JSON.stringify({
            chains: [],
            next_offset: 0,
            limit: 4,
            offset: 0,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ chains: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchStub as unknown as typeof globalThis.fetch;

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <RecentResolved />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("No resolved chains yet.");
    });

    unmount();
    client.clear();
    globalThis.fetch = originalFetch;
  });
});
