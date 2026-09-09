import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { Rail } from "@src/shell/Rail";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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

function fakePermissionRow(id: string): Record<string, unknown> {
  return {
    permission_id: id,
    parent_handoff_id: "h-parent",
    conversation_id: "conv-1",
    agent_name: "claude",
    tool_name: "shell.run",
    raw_input_json: "{}",
    status: "pending",
    remember_scope: null,
    decision_reason: null,
    decided_by: null,
    ttl_at: "2026-09-07T11:00:00.000Z",
    created_at: new Date().toISOString(),
    decided_at: null,
  };
}

function fakeDraftRow(id: string): Record<string, unknown> {
  return {
    draft_id: id,
    session_id: "s-1",
    project_id: "penumbra",
    period_key: "2026-09-01-am",
    skeleton_path: "/notes/skeleton.md",
    draft_path: "/notes/draft.md",
    note_path: "/notes/note.md",
    handoff_id: null,
    status: "awaiting_approval",
    composed_at: new Date().toISOString(),
    reviewed_at: null,
    composed_event_id: 1,
    review_event_id: null,
  };
}

function stubFetchAll(data: {
  handoffs: unknown[];
  permissions: unknown[];
  drafts: unknown[];
}): typeof globalThis.fetch {
  return mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
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
  useUIStore.setState({ activeModule: "mission", explorerCollapsed: false });
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

describe("Rail approvals pip badge", () => {
  test("approvals pip = pending handoffs + pending permissions + awaiting drafts (2+1+1 → '4')", async () => {
    globalThis.fetch = stubFetchAll({
      handoffs: [fakeHandoffRow("h-1"), fakeHandoffRow("h-2")],
      permissions: [fakePermissionRow("p-1")],
      drafts: [fakeDraftRow("d-1")],
    });

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MemoryRouter initialEntries={["/mission"]}>
          <Rail />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() => {
      const approvalsBtn = container.querySelector('button[title="Approvals"]');
      if (!approvalsBtn) throw new Error("Approvals button not rendered");
      const pip = approvalsBtn.querySelector(".pip");
      if (!pip) throw new Error("pip not yet rendered");
      expect(pip.textContent).toBe("4");
    });

    const missionBtn = container.querySelector('button[title="Mission control"]');
    expect(missionBtn?.querySelector(".pip")).toBeNull();

    unmount();
    client.clear();
  });

  test("no pip when all three queues are empty", async () => {
    globalThis.fetch = stubFetchAll({ handoffs: [], permissions: [], drafts: [] });

    const { Wrapper, client } = makeWrapper();
    const { container, unmount } = render(
      <Wrapper>
        <MemoryRouter initialEntries={["/mission"]}>
          <Rail />
        </MemoryRouter>
      </Wrapper>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector(".rail-btn .pip")).toBeNull();

    unmount();
    client.clear();
  });
});
