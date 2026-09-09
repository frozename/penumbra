import "../../setup";
import type { ReactNode } from "react";

import { SessionNoteApproveRequestSchema, type SessionNoteDraft } from "@penumbra/api-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, type Mock, mock, test } from "bun:test";

import type { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { PendingDraft } from "@src/modules/sessions";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

function makeWrapper(): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
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

function makeDraft(overrides: Partial<SessionNoteDraft> = {}): SessionNoteDraft {
  return {
    draft_id: "draft-session-1",
    session_id: "session-1234567890",
    project_id: "penumbra",
    period_key: "2026-09-01-am",
    skeleton_path: "/notes/skeleton.md",
    draft_path: "/notes/session-note-draft.md",
    note_path: "/notes/session-note.md",
    handoff_id: null,
    status: "awaiting_approval",
    composed_at: "2026-09-01T10:00:00.000Z",
    reviewed_at: null,
    composed_event_id: 1,
    review_event_id: null,
    ...overrides,
  };
}

function makeClient(
  drafts: SessionNoteDraft[],
  approve: (body: { draft_id: string; approve: true }) => Promise<unknown> = mock(
    async (_body) => ({ ok: true }),
  ),
): {
  client: DaemonClient;
  listMock: Mock<() => Promise<{ drafts: SessionNoteDraft[] }>>;
} {
  const listMock = mock(async () => ({ drafts: [...drafts] }));
  return {
    client: {
      listSessionNoteDrafts: listMock,
      sessionNotes: { approve },
    } as unknown as DaemonClient,
    listMock,
  };
}

afterEach(() => {
  cleanup();
});

describe("PendingDraft", () => {
  test("renders an Approve control that submits SessionNoteApproveRequestSchema", async () => {
    const draft = makeDraft();
    const drafts: SessionNoteDraft[] = [draft];
    const approveMock = mock(async (_body: { draft_id: string; approve: true }) => {
      drafts.length = 0;
      return { draft };
    });
    const { Wrapper, client } = makeWrapper();
    const { client: daemonClient, listMock } = makeClient(drafts, approveMock);
    const view = render(
      <Wrapper>
        <PendingDraft client={daemonClient} now={() => Date.parse("2026-09-01T12:35:00.000Z")} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("pending-draft-row").textContent ?? "").toContain("2026-09-01-am");
    });

    expect(view.getByTestId("pending-draft-row").textContent ?? "").toContain(
      "session-note-draft.md",
    );
    expect(view.getByTestId("pending-draft-elapsed").textContent).toBe("pending 2h 35m");
    expect(view.getByRole("button", { name: /^Approve$/ })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(1);
    });

    const call = approveMock.mock.calls[0];
    expect(call).toBeDefined();
    const arg = call![0];
    expect(arg).toEqual({ draft_id: draft.draft_id, approve: true });
    expect(SessionNoteApproveRequestSchema.safeParse(arg).success).toBe(true);

    await waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(view.queryByTestId("pending-draft-row")).toBeNull();
    });

    view.unmount();
    client.clear();
  });

  test("Approve failure shows a toast and keeps the row", async () => {
    const draft = makeDraft();
    const approveMock = mock(async (_body: { draft_id: string; approve: true }) => {
      throw new DaemonHttpError({
        status: 409,
        statusText: "Conflict",
        bodyText: '{"error":"note_exists"}',
        url: "/session-notes/approve",
      });
    });
    const { Wrapper, client } = makeWrapper();
    const { client: daemonClient, listMock } = makeClient([draft], approveMock);
    const view = render(
      <Wrapper>
        <PendingDraft client={daemonClient} now={() => Date.now()} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("pending-draft-row")).toBeTruthy();
    });

    fireEvent.click(view.getByRole("button", { name: /^Approve$/ }));

    await waitFor(() => {
      expect(view.getByRole("status").textContent ?? "").toContain("note_exists");
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(view.getByTestId("pending-draft-row")).toBeTruthy();

    view.unmount();
    client.clear();
  });

  test("renders empty state when no drafts are awaiting approval", async () => {
    const { Wrapper, client } = makeWrapper();
    const { client: daemonClient } = makeClient([]);
    const view = render(
      <Wrapper>
        <PendingDraft client={daemonClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("pending-draft-empty").textContent).toBe(
        "No drafts awaiting approval.",
      );
    });

    view.unmount();
    client.clear();
  });
});
