import "../../setup";
import type { HandoffRow } from "@penumbra/api-contract";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import type { EventSourceLike, ShimOpts } from "@src/api/event-source-shim";
import { __resetBrokerForTests, __setSourceFactory } from "@src/api/streams";
import { HandoffList } from "@src/modules/handoffs/HandoffList";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

function makeWrapper(initialRoute = "/handoffs"): {
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
            <MemoryRouter initialEntries={[initialRoute]}>{children}</MemoryRouter>
          </ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

const TS = "2026-09-07T10:00:00.000Z";

function makeHandoff(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoff_id: "h-1",
    ts: TS,
    project_id: null,
    conversation_id: "c-1",
    from_agent: "alpha",
    to_agent: "beta",
    to_role: null,
    message: "test handoff",
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
    ...overrides,
  };
}

let emitMessage: ((raw: { data: string; type: string }) => void) | null = null;

beforeEach(() => {
  useUIStore.setState({ activeModule: "handoffs", explorerCollapsed: false });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "unknown",
    lastHealthAt: null,
    sessionInvalid: false,
  });
  __resetBrokerForTests();
  emitMessage = null;
  __setSourceFactory((opts: ShimOpts): EventSourceLike => {
    opts.onConnected?.();
    return {
      addEventListener: (
        _event: string,
        handler: (msg: { data: string; type: string }) => void,
      ): void => {
        emitMessage = handler;
      },
      close: (): void => {
        emitMessage = null;
      },
    };
  });
});

afterEach(() => {
  cleanup();
  __setSourceFactory(null);
  __resetBrokerForTests();
  emitMessage = null;
});

describe("HandoffList", () => {
  test("paginates recent handoffs without mutating the response", async () => {
    const rows = Array.from({ length: 105 }, (_, i) =>
      makeHandoff({
        handoff_id: `h-page-${i}`,
        message: `row ${i}`,
        ts: new Date(Date.parse(TS) + i * 60_000).toISOString(),
      }),
    );
    const client = {
      handoffs: { list: mock(async () => ({ handoffs: rows })) },
    } as unknown as DaemonClient;
    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <HandoffList client={client} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(50);
    });
    expect(view.container.querySelector("a.handoff-row")?.getAttribute("href")).toBe(
      "/handoffs/h-page-104",
    );
    expect(rows[0]?.handoff_id).toBe("h-page-0");
    fireEvent.click(view.getByRole("button", { name: "Next handoff page" }));
    expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(50);
    expect(view.container.querySelector("a.handoff-row")?.getAttribute("href")).toBe(
      "/handoffs/h-page-54",
    );
    fireEvent.click(view.getByRole("button", { name: "Next handoff page" }));
    expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(5);
    expect(view.getByRole("button", { name: "Next handoff page" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(view.getByRole("button", { name: "Previous handoff page" }));
    expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(50);
    view.unmount();
  });

  test("changing status or agent returns to the first handoff page", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => makeHandoff({ handoff_id: `h-filter-${i}` }));
    const list = mock<DaemonClient["handoffs"]["list"]>(async () => ({ handoffs: rows }));
    const client = { handoffs: { list } } as unknown as DaemonClient;
    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <HandoffList client={client} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(50);
    });
    fireEvent.click(view.getByRole("button", { name: "Next handoff page" }));
    expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(10);
    fireEvent.click(view.getByRole("tab", { name: "Failed" }));
    await waitFor(() => {
      expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(50);
    });
    fireEvent.click(view.getByRole("button", { name: "Next handoff page" }));
    const input = view.getByLabelText("Agent filter");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.input(input, { target: { value: "alpha" } });
    fireEvent.keyUp(input, { key: "a" });
    await waitFor(() => {
      expect(list).toHaveBeenCalledWith({ status: "failed", agent: "alpha" });
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll("a.handoff-row")).toHaveLength(50);
    });
    expect(
      view.getByRole("button", { name: "Previous handoff page" }).hasAttribute("disabled"),
    ).toBe(true);
    view.unmount();
  });

  test("status tab failed calls handoffs.list({status:'failed'}); the agent filter passes agent", async () => {
    const handoffsList = mock<DaemonClient["handoffs"]["list"]>(async () => ({ handoffs: [] }));
    const client = {
      handoffs: { list: handoffsList },
    } as unknown as DaemonClient;

    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <HandoffList client={client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(handoffsList).toHaveBeenCalledTimes(1);
    });
    expect(handoffsList.mock.calls[0]![0]).toEqual({ status: "pending", agent: undefined });

    const failedTab = view.getAllByRole("tab").find((t) => t.textContent === "Failed")!;
    await act(async () => {
      fireEvent.click(failedTab);
    });

    await waitFor(() => {
      const failedCalls = handoffsList.mock.calls.filter((c) => c[0]?.status === "failed");
      expect(failedCalls.length).toBeGreaterThanOrEqual(1);
    });
    const failedCall = handoffsList.mock.calls.find((c) => c[0]?.status === "failed")!;
    expect(failedCall[0]).toEqual({ status: "failed", agent: undefined });

    const agentInput = view.getByLabelText("Agent filter") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(agentInput);
      fireEvent.keyDown(agentInput, { key: "e" });
      fireEvent.input(agentInput, { target: { value: "claude" } });
      fireEvent.keyUp(agentInput, { key: "e" });
    });

    await waitFor(
      () => {
        const agentCalls = handoffsList.mock.calls.filter(
          (c) => c[0]?.agent === "claude" && c[0]?.status === "failed",
        );
        expect(agentCalls.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000 },
    );

    view.unmount();
  });

  test("a handoff-events frame invalidates the active tab's key", async () => {
    let callCount = 0;
    const handoffsList = mock(async () => {
      callCount += 1;
      return {
        handoffs:
          callCount === 1
            ? [makeHandoff({ handoff_id: "h-first", message: "first" })]
            : [makeHandoff({ handoff_id: "h-second", message: "second" })],
      };
    });
    const client = {
      handoffs: { list: handoffsList },
    } as unknown as DaemonClient;

    const { Wrapper } = makeWrapper();
    const view = render(
      <Wrapper>
        <HandoffList client={client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.container.textContent).toContain("first");
    });
    expect(handoffsList).toHaveBeenCalledTimes(1);

    act(() => {
      if (!emitMessage) throw new Error("stream not connected");
      emitMessage({ data: JSON.stringify({ type: "handoff_updated" }), type: "message" });
    });

    await waitFor(() => {
      expect(handoffsList).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      expect(view.container.textContent).toContain("second");
    });

    view.unmount();
  });
});
