import "../../setup";
import type { SessionNoteDraft } from "@penumbra/api-contract";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/api/client";
import { PendingDraft } from "@src/modules/sessions";

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

function makeClient(drafts: SessionNoteDraft[]): DaemonClient {
  return {
    listSessionNoteDrafts: mock(async () => ({ drafts })),
  } as unknown as DaemonClient;
}

afterEach(() => {
  cleanup();
});

describe("PendingDraft", () => {
  test("renders awaiting drafts with elapsed text and no interactive controls", async () => {
    const draft = makeDraft();
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <PendingDraft
          client={makeClient([draft])}
          now={() => Date.parse("2026-09-01T12:35:00.000Z")}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("pending-draft-row").textContent ?? "").toContain("2026-09-01-am");
    });

    expect(view.getByTestId("pending-draft-row").textContent ?? "").toContain(
      "session-note-draft.md",
    );
    expect(view.getByTestId("pending-draft-elapsed").textContent).toBe("pending 2h 35m");
    expect(view.getByTestId("pending-draft-approve-command").textContent ?? "").toContain(
      draft.draft_id,
    );
    expect(view.container.querySelectorAll('button, input, form, [role="button"]').length).toBe(0);

    view.unmount();
    client.clear();
  });

  test("renders empty state when no drafts are awaiting approval", async () => {
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <PendingDraft client={makeClient([])} />
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
