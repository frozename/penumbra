import "../../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getByLabelText, getByRole } from "@testing-library/dom";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { DaemonClient, HandoffsListResponse } from "@src/api/client";
import { PendingHandoffs } from "@src/modules/mission/PendingHandoffs";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

function fakeRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    handoff_id: "handoff-id-1",
    ts: new Date().toISOString(),
    project_id: null,
    conversation_id: "conv-1",
    from_agent: "alpha",
    to_agent: "beta",
    to_role: "reviewer",
    message: "please review the attached patch",
    status: "pending",
    resolved_by: null,
    resolved_at: null,
    redirected_to: null,
    resolution_reason: null,
    triggered_by_event_id: null,
    chain_max_hops: null,
    chain_trust_mode: null,
    chain_task_type: "review",
    use_worktree: false,
    open_pr_on_review: null,
    branch_base: null,
    error_message: null,
    cancel_requested_at: null,
    worker_id: null,
    parent_handoff_id: null,
    ...overrides,
  };
}

// Drive a controlled <input> or <textarea>'s React onChange under happy-dom.
//
// happy-dom 18 + React 18 do not fire React's controlled-input `onChange`
// for a bare `fireEvent.change(input, { target: { value } })`: the value
// reaches the DOM node but React's ChangeEventPlugin never re-syncs state,
// so the component keeps reading the empty initial value. A real keystroke
// envelope (focus -> keyDown -> input(value) -> keyUp) does drive onChange.
// Do not "simplify" this back to a single fireEvent.change — it silently
// stops exercising the typed value and the assertion below would pass
// against the "" fallback instead of the user's input.
function typeIntoInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: value.slice(-1) || "x" });
  fireEvent.input(input, { target: { value } });
  fireEvent.keyUp(input, { key: value.slice(-1) || "x" });
}

afterEach(() => {
  cleanup();
});

describe("PendingHandoffs", () => {
  test("renders empty state when no handoffs are pending", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      listHandoffs: mock(async () => ({ handoffs: [] })),
      approveHandoff: mock(async () => ({
        handoff_id: "x",
        status: "approved",
      })),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("No handoffs awaiting approval.");
    });

    unmount();
    client.clear();
  });

  test("renders one row per handoff with from→to agents", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      listHandoffs: mock(
        async () =>
          ({
            handoffs: [
              fakeRow({ handoff_id: "handoff-id-1", from_agent: "alpha", to_agent: "beta" }),
              fakeRow({ handoff_id: "handoff-id-2", from_agent: "gamma", to_agent: "delta" }),
            ],
          }) as HandoffsListResponse,
      ),
      approveHandoff: mock(async () => ({
        handoff_id: "x",
        status: "approved",
      })),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.textContent).toContain("alpha");
      expect(container.textContent).toContain("beta");
      expect(container.textContent).toContain("gamma");
      expect(container.textContent).toContain("delta");
    });
    expect(container.textContent).toContain("2 pending");

    unmount();
    client.clear();
  });

  test("clicking Approve calls approveHandoff with no reject and refetches", async () => {
    const { Wrapper, client } = makeWrapper();
    const listMock = mock(
      async () =>
        ({
          handoffs: [fakeRow({ handoff_id: "handoff-id-1" })],
        }) as HandoffsListResponse,
    );
    const approveMock = mock(async () => ({
      handoff_id: "handoff-id-1",
      status: "approved",
    }));
    const stubClient = {
      listHandoffs: listMock,
      approveHandoff: approveMock,
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    const approveBtn = within(container).getByText("Approve");
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
    });
    const firstCall = approveMock.mock.calls[0] as unknown as [string, unknown];
    expect(firstCall?.[0]).toBe("handoff-id-1");
    expect(firstCall?.[1]).toBeUndefined();

    await waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });

    unmount();
    client.clear();
  });

  test("Approve failure leaves the row visible and renders no inline error chip", async () => {
    const { Wrapper, client } = makeWrapper();
    const listMock = mock(
      async () =>
        ({
          handoffs: [fakeRow({ handoff_id: "handoff-id-err" })],
        }) as HandoffsListResponse,
    );
    const approveMock = mock(async () => {
      throw new Error("network down");
    });
    const stubClient = {
      listHandoffs: listMock,
      approveHandoff: approveMock,
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    const approveBtn = within(container).getByText("Approve");
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="ph-row-error"]')).toBeNull();
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    unmount();
    client.clear();
  });

  test("renders 'unknown' when row.ts is not a valid date", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      listHandoffs: mock(
        async () =>
          ({
            handoffs: [fakeRow({ handoff_id: "h-bad-ts", ts: "not a date" })],
          }) as HandoffsListResponse,
      ),
      approveHandoff: mock(async () => ({
        handoff_id: "x",
        status: "approved",
      })),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });
    expect(container.textContent).toContain("unknown");
    expect(container.textContent).not.toContain("NaN");

    unmount();
    client.clear();
  });

  test("truncates long messages on a code-point boundary without breaking emoji", async () => {
    const { Wrapper, client } = makeWrapper();
    const longMsg = "a".repeat(85) + "🎉🎉🎉";
    const stubClient = {
      listHandoffs: mock(
        async () =>
          ({
            handoffs: [fakeRow({ handoff_id: "h-long", message: longMsg })],
          }) as HandoffsListResponse,
      ),
      approveHandoff: mock(async () => ({
        handoff_id: "x",
        status: "approved",
      })),
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    // 80 'a' chars + ellipsis (1 code point); no broken surrogate at the tail
    const expected = "a".repeat(80) + "…";
    expect(container.textContent).toContain(expected);
    expect(Array.from(expected)).toHaveLength(81);
    // The string contains no lone surrogate halves: round-trip via Array.from is identity.
    expect(Array.from(expected).join("")).toBe(expected);

    unmount();
    client.clear();
  });

  test("clicking Deny opens reason input then submits with reject + reason", async () => {
    const { Wrapper, client } = makeWrapper();
    const listMock = mock(
      async () =>
        ({
          handoffs: [fakeRow({ handoff_id: "handoff-id-2" })],
        }) as HandoffsListResponse,
    );
    const approveMock = mock(async () => ({
      handoff_id: "handoff-id-2",
      status: "rejected",
    }));
    const stubClient = {
      listHandoffs: listMock,
      approveHandoff: approveMock,
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    const denyBtn = within(container).getByText("Deny");
    fireEvent.click(denyBtn);

    const dialog = await waitFor<HTMLElement>(() => {
      const found = getByRole(document.body, "dialog");
      if (!found) throw new Error("confirm dialog not rendered");
      return found as HTMLElement;
    });

    const reasonField = getByLabelText(document.body, "Reason") as HTMLTextAreaElement;
    typeIntoInput(reasonField, "looks bad");

    const confirmBtn = getByRole(dialog, "button", { name: "Confirm" }) as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
    });
    const firstCall = approveMock.mock.calls[0] as unknown as [string, unknown];
    expect(firstCall?.[0]).toBe("handoff-id-2");
    expect(firstCall?.[1]).toEqual({ reject: true, reason: "looks bad" });

    unmount();
    client.clear();
  });

  test("Deny with an empty reason cannot submit: Confirm is disabled and approveHandoff is never called", async () => {
    const { Wrapper, client } = makeWrapper();
    const listMock = mock(
      async () =>
        ({
          handoffs: [fakeRow({ handoff_id: "handoff-id-2" })],
        }) as HandoffsListResponse,
    );
    const approveMock = mock(async () => ({
      handoff_id: "handoff-id-2",
      status: "rejected",
    }));
    const stubClient = {
      listHandoffs: listMock,
      approveHandoff: approveMock,
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    const denyBtn = within(container).getByText("Deny");
    fireEvent.click(denyBtn);

    const dialog = await waitFor<HTMLElement>(() => {
      const found = getByRole(document.body, "dialog");
      if (!found) throw new Error("confirm dialog not rendered");
      return found as HTMLElement;
    });

    const confirmBtn = getByRole(dialog, "button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);

    await new Promise((r) => setTimeout(r, 0));
    expect(approveMock).not.toHaveBeenCalled();

    unmount();
    client.clear();
  });

  test("while the Deny dialog is open both row buttons are disabled, and they re-enable after Cancel", async () => {
    const { Wrapper, client } = makeWrapper();
    const listMock = mock(
      async () =>
        ({
          handoffs: [fakeRow({ handoff_id: "handoff-id-3" })],
        }) as HandoffsListResponse,
    );
    const approveMock = mock(async () => ({
      handoff_id: "handoff-id-3",
      status: "rejected",
    }));
    const stubClient = {
      listHandoffs: listMock,
      approveHandoff: approveMock,
    } as unknown as DaemonClient;

    const { container, unmount } = render(
      <Wrapper>
        <PendingHandoffs client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(container.querySelector(".ph-row")).toBeTruthy();
    });

    const row = container.querySelector(".ph-row") as HTMLElement;
    const denyBtn = within(row).getByRole("button", { name: "Deny" }) as HTMLButtonElement;
    const approveBtn = within(row).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    fireEvent.click(denyBtn);

    const dialog = await waitFor<HTMLElement>(() => {
      const found = getByRole(document.body, "dialog");
      if (!found) throw new Error("confirm dialog not rendered");
      return found as HTMLElement;
    });

    expect(approveBtn.disabled).toBe(true);
    expect(denyBtn.disabled).toBe(true);

    const cancelBtn = getByRole(dialog, "button", { name: "Cancel" }) as HTMLButtonElement;
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(approveBtn.disabled).toBe(false);
      expect(denyBtn.disabled).toBe(false);
    });

    expect(approveMock).not.toHaveBeenCalled();

    unmount();
    client.clear();
  });
});
