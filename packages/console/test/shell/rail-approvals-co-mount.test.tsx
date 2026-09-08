import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { ApprovalsInbox } from "@src/modules/approvals/ApprovalsInbox";
import { PendingHandoffs } from "@src/modules/mission/PendingHandoffs";
import { Rail } from "@src/shell/Rail";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ConfirmDialogProvider>
            <MemoryRouter initialEntries={["/mission"]}>{children}</MemoryRouter>
          </ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

function fakeHandoffRow(id: string): Record<string, unknown> {
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
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
  };
}

function stubFetch(data: {
  handoffs: unknown[];
  permissions: unknown[];
  drafts: unknown[];
}): typeof globalThis.fetch {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method === "POST" && url.includes("/handoffs/") && url.includes("/approve")) {
      return new Response(JSON.stringify({ handoff_id: "h-1", status: "approved" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/session-notes/drafts")) {
      return new Response(JSON.stringify({ drafts: data.drafts }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/permissions")) {
      return new Response(JSON.stringify({ permissions: data.permissions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/handoffs")) {
      return new Response(JSON.stringify({ handoffs: data.handoffs }), {
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

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  useUIStore.setState({ activeModule: "approvals", explorerCollapsed: false });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "unknown",
    lastHealthAt: null,
    sessionInvalid: false,
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
    sessionInvalid: false,
  });
});

describe("Rail + PendingHandoffs co-mount", () => {
  test("Rail's approvals pip and PendingHandoffs render together under one QueryClient without corrupting each other", async () => {
    globalThis.fetch = stubFetch({
      handoffs: [fakeHandoffRow("h-1")],
      permissions: [],
      drafts: [],
    });

    const { Wrapper, client: queryClient } = makeWrapper();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const { container, unmount } = render(
      <Wrapper>
        <Rail />
        <PendingHandoffs />
        <ApprovalsInbox />
      </Wrapper>,
    );

    await waitFor(() => {
      const approvalsBtn = container.querySelector('button[title="Approvals"]');
      if (!approvalsBtn) throw new Error("Approvals button not rendered");
      const pip = approvalsBtn.querySelector(".pip");
      if (!pip) throw new Error("pip not yet rendered");
      expect(pip.textContent).toBe("1");
    });

    await waitFor(() => {
      const rows = container.querySelectorAll('[data-testid="pending-handoff-row"]');
      expect(rows.length).toBe(1);
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="approval-row"]').length).toBe(1);
    });

    const approveBtn = container.querySelector(
      '[data-testid="approval-row"] button.btn-primary',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]);
      expect(
        invalidatedKeys.some(
          (k) => JSON.stringify(k) === JSON.stringify({ queryKey: ["handoffs", "pending"] }),
        ),
      ).toBe(true);
    });

    unmount();
    queryClient.clear();
  });

  test("a PendingHandoffs-side approve clears the Rail approvals pip via cross-key invalidation, not the poll", async () => {
    const seed = {
      handoffs: [fakeHandoffRow("h-1")],
      permissions: [] as unknown[],
      drafts: [] as unknown[],
    };
    globalThis.fetch = stubFetch(seed);

    const { Wrapper, client: queryClient } = makeWrapper();

    const { container, unmount } = render(
      <Wrapper>
        <Rail />
        <PendingHandoffs />
      </Wrapper>,
    );

    const railPip = (): Element | null => container.querySelector('button[title="Approvals"] .pip');

    await waitFor(() => {
      expect(railPip()?.textContent).toBe("1");
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="pending-handoff-row"]').length).toBe(1);
    });

    const missionRow = container.querySelector('[data-testid="pending-handoff-row"]');
    if (!missionRow) throw new Error("pending-handoff-row not rendered");
    const approveButtons = missionRow.querySelectorAll("button.btn-ok");
    expect(approveButtons.length).toBe(1);
    const approveBtn = approveButtons.item(0);
    expect(approveBtn.textContent).toBe("Approve");

    await act(async () => {
      fireEvent.click(approveBtn);
      // The daemon resolves the handoff, so the next fetch drains the queue.
      // stubFetch reads seed.handoffs at request time; assigning here lands
      // before the invalidation-triggered refetch issues its request.
      seed.handoffs = [];
    });

    // The pip's own poll is COOL_POLL_MS (30s) and no timer is advanced, so the
    // pip can only clear if the mission-side approve invalidated the
    // approvalsHandoffs() key the Rail observes.
    await waitFor(() => {
      expect(railPip()).toBeNull();
    });

    unmount();
    queryClient.clear();
  });
});
