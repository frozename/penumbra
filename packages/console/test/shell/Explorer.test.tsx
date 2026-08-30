import "../setup";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react/pure";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Explorer } from "@src/shell/Explorer";
import { useDaemonStore } from "@src/stores/daemon-store";

const ORIGINAL_FETCH = globalThis.fetch;

function resetStores() {
  useDaemonStore.setState({
    baseUrl: "http://daemon.test",
    token: "t",
    health: "unknown",
    lastHealthAt: null,
  });
}

function installFetchStub(sessionId: string) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/session/current")) {
      return new Response(
        JSON.stringify({
          id: sessionId,
          project: { id: "none", name: "none" },
          started_at: new Date().toISOString(),
          budget: { current: 0, max_concurrent: 0, soft_warn_pct: 0 },
          dispatched: 0,
          resolved: 0,
          failed: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/handoffs")) {
      return new Response(JSON.stringify({ handoffs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/chains")) {
      return new Response(JSON.stringify({ chains: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/workspace")) {
      return new Response(JSON.stringify({ projectId: null, branch: null, dirty: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
  resetStores();
});

function renderExplorer() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/mission"]}>
        <Explorer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Explorer SESSION block", () => {
  test("does NOT render a live SESSION row for the 'no-session' sentinel", async () => {
    installFetchStub("no-session");
    const view = renderExplorer();

    // Wait for queries to settle: PENDING + IN-FLIGHT headers always render.
    await waitFor(() => {
      expect(view.container.textContent ?? "").toContain("PENDING");
      expect(view.container.textContent ?? "").toContain("IN-FLIGHT");
    });

    // The SESSION block must not render for the no-session sentinel.
    const text = view.container.textContent ?? "";
    expect(text).not.toContain("SESSION");
    expect(text).not.toContain("no-session");
  });

  test("renders the SESSION row for a real session id", async () => {
    installFetchStub("session-real-123");
    const view = renderExplorer();

    await waitFor(() => {
      expect(view.container.textContent ?? "").toContain("session-real-123");
    });
    expect(view.container.textContent ?? "").toContain("SESSION");
    expect(view.container.textContent ?? "").toContain("live");
  });
});
