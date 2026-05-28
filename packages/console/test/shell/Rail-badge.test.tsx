import "../setup";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Rail } from "../../src/shell/Rail";
import { useUIStore } from "../../src/stores/ui-store";
import { useDaemonStore } from "../../src/stores/daemon-store";

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

function stubFetchHandoffs(rows: unknown[]): typeof globalThis.fetch {
  return mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/handoffs")) {
      return new Response(JSON.stringify({ handoffs: rows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

function fakeRow(id: string): Record<string, unknown> {
  return {
    handoff_id: id,
    ts: new Date().toISOString(),
    project_id: null,
    conversation_id: "conv-1",
    from_agent: "alpha",
    to_agent: "beta",
    to_role: null,
    message: "hi",
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: null,
    use_worktree: false,
    open_pr_on_review: null,
    branch_base: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  useUIStore.setState({ activeModule: "mission", explorerCollapsed: false });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "unknown",
    lastHealthAt: null,
  });
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useDaemonStore.setState({
    baseUrl: "",
    token: "",
    health: "unknown",
    lastHealthAt: null,
  });
});

describe("Rail mission pip badge", () => {
  test("renders pip with count when pending handoffs > 0", async () => {
    globalThis.fetch = stubFetchHandoffs([fakeRow("h-1"), fakeRow("h-2"), fakeRow("h-3")]);

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MemoryRouter initialEntries={["/mission"]}>
          <Rail />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() => {
      const pip = container.querySelector(".rail-btn .pip.warn");
      if (!pip) throw new Error("pip not yet rendered");
      expect(pip.textContent).toBe("3");
    });

    unmount();
    client.clear();
  });

  test("renders no pip when pending handoffs is 0", async () => {
    globalThis.fetch = stubFetchHandoffs([]);

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MemoryRouter initialEntries={["/mission"]}>
          <Rail />
        </MemoryRouter>
      </Wrapper>,
    );

    // Allow the initial poll to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector(".rail-btn .pip")).toBeNull();

    unmount();
    client.clear();
  });
});
