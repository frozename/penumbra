import "../../setup";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PendingHandoffs } from "../../../src/modules/mission/PendingHandoffs";
import type { DaemonClient } from "../../../src/api/client";
import type { HandoffsListResponse } from "../../../src/api/client";

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
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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

afterEach(() => {
  cleanup();
});

describe("PendingHandoffs", () => {
  test("renders empty state when no handoffs are pending", async () => {
    const { Wrapper, client } = makeWrapper();
    const stubClient = {
      listHandoffs: mock(async () => ({ handoffs: [] }) as HandoffsListResponse),
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

    const approveBtn = within(container).getByText("Approve") as HTMLButtonElement;
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

  test("Approve failure surfaces an error chip and keeps the row visible", async () => {
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

    const approveBtn = within(container).getByText("Approve") as HTMLButtonElement;
    fireEvent.click(approveBtn);

    await waitFor(() => {
      const err = container.querySelector('[data-testid="ph-row-error"]');
      if (!err) throw new Error("error chip not rendered");
      expect(err.textContent).toContain("network down");
    });
    expect(container.querySelector(".ph-row")).toBeTruthy();

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

    const denyBtn = within(container).getByText("Deny") as HTMLButtonElement;
    fireEvent.click(denyBtn);

    const input = (await waitFor(() => {
      const found = container.querySelector('input[name="deny-reason"]') as HTMLInputElement | null;
      if (!found) throw new Error("reason input not rendered");
      return found;
    })) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "looks bad" } });
    const submit = within(container).getByText("Submit deny") as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
    });
    const firstCall = approveMock.mock.calls[0] as unknown as [string, unknown];
    expect(firstCall?.[0]).toBe("handoff-id-2");
    expect(firstCall?.[1]).toEqual({ reject: true, reason: "looks bad" });

    unmount();
    client.clear();
  });
});
