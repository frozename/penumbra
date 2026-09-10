import "../setup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";

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

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

function installFetchStubWithHandoff(handoffId: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/session/current")) {
      return new Response(
        JSON.stringify({
          id: "session-real",
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
    if (url.includes("/handoffs") && url.includes("status=pending")) {
      return new Response(
        JSON.stringify({
          handoffs: [
            {
              handoff_id: handoffId,
              ts: "2026-09-07T10:00:00.000Z",
              project_id: null,
              conversation_id: "c-1",
              from_agent: "alpha",
              to_agent: "beta",
              to_role: null,
              message: "navigate test handoff",
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
              error_message: null,
              cancel_requested_at: null,
              worker_id: null,
              parent_handoff_id: null,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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

describe("Explorer mission sidebar handoff navigation", () => {
  test("mission sidebar handoff rows navigate to /handoffs/<id>", async () => {
    installFetchStubWithHandoff("h-navtest123");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/mission"]}>
          <Explorer />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(view.container.textContent ?? "").toContain("navigate test handoff");
    });

    const pendingSection = Array.from(view.container.querySelectorAll(".exp-section")).find((s) =>
      s.textContent?.includes("PENDING"),
    );
    expect(pendingSection).toBeTruthy();

    const handoffRow = pendingSection!.querySelector(".exp-row") as HTMLElement;
    expect(handoffRow).toBeTruthy();
    expect(handoffRow.tagName).toBe("BUTTON");
    expect(handoffRow.getAttribute("type")).toBe("button");

    fireEvent.click(handoffRow);

    await waitFor(() => {
      expect(view.getByTestId("location-probe").textContent).toBe("/handoffs/h-navtest123");
    });
  });
});
