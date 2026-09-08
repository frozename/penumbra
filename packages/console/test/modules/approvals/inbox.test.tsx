import "../../setup";
import type {
  HandoffRow,
  PermissionRequestRow,
  SessionNoteApproveRequest,
  SessionNoteDraft,
} from "@penumbra/api-contract";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import type { EventSourceLike, ShimOpts } from "@src/api/event-source-shim";
import { __resetBrokerForTests, __setSourceFactory } from "@src/api/streams";
import { approvalsHandoffs } from "@src/lib/query-keys";
import { ApprovalsView } from "@src/modules/approvals";
import { ApprovalsInbox } from "@src/modules/approvals/ApprovalsInbox";
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
            <MemoryRouter initialEntries={["/approvals"]}>{children}</MemoryRouter>
          </ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

const TS_10 = "2026-09-07T10:00:00.000Z";
const TS_1005 = "2026-09-07T10:05:00.000Z";
const TS_1020 = "2026-09-07T10:20:00.000Z";

function makeHandoff(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoff_id: "h-1",
    ts: TS_1020,
    project_id: null,
    conversation_id: "c-1",
    from_agent: "alpha",
    to_agent: "beta",
    to_role: null,
    message: "handoff 1",
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

function makePermission(overrides: Partial<PermissionRequestRow> = {}): PermissionRequestRow {
  return {
    permission_id: "p-1",
    parent_handoff_id: "h-parent",
    conversation_id: "c-1",
    agent_name: "claude",
    tool_name: "shell.run",
    raw_input_json: "{}",
    status: "pending",
    remember_scope: null,
    decision_reason: null,
    decided_by: null,
    ttl_at: "2026-09-07T11:00:00.000Z",
    created_at: TS_1005,
    decided_at: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<SessionNoteDraft> = {}): SessionNoteDraft {
  return {
    draft_id: "d-1",
    session_id: "s-1",
    project_id: "penumbra",
    period_key: "2026-09-01-am",
    skeleton_path: "/notes/skeleton.md",
    draft_path: "/notes/draft.md",
    note_path: "/notes/note.md",
    handoff_id: null,
    status: "awaiting_approval",
    composed_at: TS_10,
    reviewed_at: null,
    composed_event_id: 1,
    review_event_id: null,
    ...overrides,
  };
}

interface ClientMocks {
  handoffsList: ReturnType<typeof mock>;
  handoffsApprove: ReturnType<typeof mock>;
  permissionsList: ReturnType<typeof mock>;
  permissionsDecide: ReturnType<typeof mock>;
  draftsList: ReturnType<typeof mock>;
  draftsApprove: ReturnType<typeof mock>;
  client: DaemonClient;
}

function makeClient(opts?: {
  handoffs?: HandoffRow[];
  permissions?: PermissionRequestRow[];
  drafts?: SessionNoteDraft[];
  decideImpl?: (id: string, body: unknown) => Promise<unknown>;
  approveDraftImpl?: (body: unknown) => Promise<unknown>;
}): ClientMocks {
  const handoffsList = mock(async () => ({ handoffs: opts?.handoffs ?? [] }));
  const handoffsApprove = mock(async () => ({}));
  const permissionsList = mock(async () => ({ permissions: opts?.permissions ?? [] }));
  const decideImpl = opts?.decideImpl ?? (async () => ({}));
  const permissionsDecide = mock(decideImpl);
  const draftsList = mock(async () => ({ drafts: opts?.drafts ?? [] }));
  const approveDraftImpl = opts?.approveDraftImpl ?? (async () => ({}));
  const draftsApprove = mock(approveDraftImpl);
  const client = {
    handoffs: { list: handoffsList, approve: handoffsApprove },
    permissions: { list: permissionsList, decide: permissionsDecide },
    sessionNotes: { drafts: draftsList, approve: draftsApprove },
  } as unknown as DaemonClient;
  return {
    handoffsList,
    handoffsApprove,
    permissionsList,
    permissionsDecide,
    draftsList,
    draftsApprove,
    client,
  };
}

let emitMessage: ((raw: { data: string; type: string }) => void) | null = null;

beforeEach(() => {
  useUIStore.setState({ activeModule: "approvals", explorerCollapsed: false });
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

describe("ApprovalsInbox", () => {
  test("one ApprovalRow per pending handoff, pending permission and awaiting draft, age-ordered (data-kind sequence)", async () => {
    const mocks = makeClient({
      handoffs: [makeHandoff()],
      permissions: [makePermission()],
      drafts: [makeDraft()],
    });
    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={mocks.client} />
      </Wrapper>,
    );

    await waitFor(() => {
      const rows = view.getAllByTestId("approval-row");
      expect(rows.length).toBe(3);
    });

    const kinds = view.getAllByTestId("approval-row").map((r) => r.getAttribute("data-kind"));
    expect(kinds).toEqual(["draft", "permission", "handoff"]);

    view.unmount();
  });

  test("Approve on a permission row calls permissions.decide(id,{decision:'approve'}) and invalidates permissionsByStatus('pending')", async () => {
    const mocks = makeClient({
      handoffs: [],
      permissions: [makePermission()],
      drafts: [],
    });
    const { Wrapper, client: queryClient } = makeWrapper();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={mocks.client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    const approveBtn = view.getByRole("button", { name: /^Approve$/ });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(mocks.permissionsDecide).toHaveBeenCalledTimes(1);
    });
    const call = mocks.permissionsDecide.mock.calls[0]!;
    expect(call[0]).toBe("p-1");
    expect(call[1]).toEqual({ decision: "approve" });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(
      invalidatedKeys.some(
        (k) => JSON.stringify(k) === JSON.stringify({ queryKey: ["permissions", "pending"] }),
      ),
    ).toBe(true);

    view.unmount();
  });

  test("Reject on a permission row is guarded: reason required, sends {decision:'reject', reason}", async () => {
    const mocks = makeClient({
      handoffs: [],
      permissions: [makePermission()],
      drafts: [],
    });
    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={mocks.client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    const rejectBtn = view.getByRole("button", { name: /^Reject$/ });
    await act(async () => {
      fireEvent.click(rejectBtn);
    });

    const dialog = view.getByRole("dialog");
    const confirmBtn = dialog.querySelector("button.btn-primary") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    const reasonField = view.getByLabelText("Reason") as HTMLTextAreaElement;
    fireEvent.focus(reasonField);
    fireEvent.keyDown(reasonField, { key: "o" });
    fireEvent.input(reasonField, { target: { value: "no" } });
    fireEvent.keyUp(reasonField, { key: "o" });
    expect(confirmBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(mocks.permissionsDecide).toHaveBeenCalledTimes(1);
    });
    const call = mocks.permissionsDecide.mock.calls[0]!;
    expect(call[0]).toBe("p-1");
    expect(call[1]).toEqual({ decision: "reject", reason: "no" });

    view.unmount();
  });

  test("Approve on a draft row sends {draft_id, approve:true} and the row leaves after invalidation", async () => {
    let draftsCallCount = 0;
    const draftsList = mock(async () => {
      draftsCallCount += 1;
      return { drafts: draftsCallCount === 1 ? [makeDraft()] : [] };
    });
    const draftsApprove = mock(async (_body: SessionNoteApproveRequest) => ({}));
    const client = {
      handoffs: { list: mock(async () => ({ handoffs: [] })), approve: mock(async () => ({})) },
      permissions: {
        list: mock(async () => ({ permissions: [] })),
        decide: mock(async () => ({})),
      },
      sessionNotes: { drafts: draftsList, approve: draftsApprove },
    } as unknown as DaemonClient;

    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    const approveBtn = view.getByRole("button", { name: /^Approve$/ });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(draftsApprove).toHaveBeenCalledTimes(1);
    });
    const call = draftsApprove.mock.calls[0]!;
    expect(call[0]).toEqual({ draft_id: "d-1", approve: true });

    await waitFor(() => {
      expect(view.queryAllByTestId("approval-row").length).toBe(0);
    });

    view.unmount();
  });

  test("a permission-events frame invalidates the pending permissions key (refetch count 2)", async () => {
    const mocks = makeClient({
      handoffs: [],
      permissions: [makePermission()],
      drafts: [],
    });
    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={mocks.client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(mocks.permissionsList).toHaveBeenCalledTimes(1);
    });

    act(() => {
      if (!emitMessage) throw new Error("stream not connected");
      emitMessage({ data: JSON.stringify({ type: "permission_decided" }), type: "message" });
    });

    await waitFor(() => {
      expect(mocks.permissionsList).toHaveBeenCalledTimes(2);
    });

    view.unmount();
  });

  test("a 409 {code:'conflict', current_status} renders current_status inline on the row and the row is not stuck busy", async () => {
    const mocks = makeClient({
      handoffs: [],
      permissions: [makePermission()],
      drafts: [],
      decideImpl: async () => {
        throw new DaemonHttpError({
          status: 409,
          statusText: "Conflict",
          bodyText: JSON.stringify({ error: { code: "conflict" }, current_status: "approved" }),
          url: "x",
        });
      },
    });
    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={mocks.client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    const approveBtn = view.getByRole("button", { name: /^Approve$/ });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(view.getByTestId("approval-row-status").textContent ?? "").toContain("approved");
    });

    const approveBtnAfter = view.getByRole("button", { name: /^Approve$/ }) as HTMLButtonElement;
    expect(approveBtnAfter.disabled).toBe(false);

    view.unmount();
  });

  test("mounting the approvals view at /approvals with a default ui-store enables its queries", async () => {
    useUIStore.setState({ activeModule: "mission" });
    const mocks = makeClient({
      handoffs: [makeHandoff()],
      permissions: [],
      drafts: [],
    });
    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsView client={mocks.client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    view.unmount();
  });

  test("a failing queue renders an error row, not the empty state", async () => {
    const permissionsList = mock(async () => {
      throw new Error("permissions endpoint down");
    });
    const client = {
      handoffs: {
        list: mock(async () => ({ handoffs: [makeHandoff()] })),
        approve: mock(async () => ({})),
      },
      permissions: { list: permissionsList, decide: mock(async () => ({})) },
      sessionNotes: {
        drafts: mock(async () => ({ drafts: [makeDraft()] })),
        approve: mock(async () => ({})),
      },
    } as unknown as DaemonClient;

    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("approvals-queue-error")).toBeTruthy();
    });

    expect(view.queryByTestId("approvals-empty")).toBeNull();
    expect(view.getAllByTestId("approval-row").length).toBe(2);

    view.unmount();
  });

  test("a failing refetch keeps the already-loaded rows and shows the error alongside them", async () => {
    let handoffsCallCount = 0;
    const handoffsList = mock(async () => {
      handoffsCallCount += 1;
      if (handoffsCallCount === 1) return { handoffs: [makeHandoff()] };
      throw new Error("refetch failed");
    });
    const client = {
      handoffs: { list: handoffsList, approve: mock(async () => ({})) },
      permissions: {
        list: mock(async () => ({ permissions: [] })),
        decide: mock(async () => ({})),
      },
      sessionNotes: {
        drafts: mock(async () => ({ drafts: [] })),
        approve: mock(async () => ({})),
      },
    } as unknown as DaemonClient;

    const { Wrapper, client: queryClient } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: approvalsHandoffs() });
    });

    await waitFor(() => {
      expect(view.getByTestId("approvals-queue-error")).toBeTruthy();
      expect(view.getAllByTestId("approval-row").length).toBe(1);
    });

    view.unmount();
  });

  test("an unresolved queue shows a loading state, not the empty state", async () => {
    const handoffsList = mock(async () => await new Promise<never>(() => {}));
    const permissionsList = mock(async () => ({ permissions: [] }));
    const draftsList = mock(async () => ({ drafts: [] }));
    const client = {
      handoffs: { list: handoffsList, approve: mock(async () => ({})) },
      permissions: { list: permissionsList, decide: mock(async () => ({})) },
      sessionNotes: { drafts: draftsList, approve: mock(async () => ({})) },
    } as unknown as DaemonClient;

    const { Wrapper } = makeWrapper();

    const view = render(
      <Wrapper>
        <ApprovalsInbox client={client} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(permissionsList).toHaveBeenCalledTimes(1);
      expect(draftsList).toHaveBeenCalledTimes(1);
    });

    expect(view.queryByTestId("approvals-empty")).toBeNull();
    expect(view.queryByTestId("approvals-loading")).not.toBeNull();

    view.unmount();
  });
});
