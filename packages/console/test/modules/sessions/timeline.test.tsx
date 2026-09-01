import "../../setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SessionEvent } from "@penumbra/api-contract";

import type { DaemonClient, SessionEventParseResult } from "@src/api/client";
import { SessionTimeline } from "@src/modules/sessions";

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

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 1,
    session_id: "session-1234567890",
    related_session_id: null,
    project_id: "penumbra",
    cwd: "/repo/penumbra",
    transcript_path: null,
    ref_path: "/tmp/session-note.md",
    kind: "session.start",
    ts: "2026-09-01T10:00:00.000Z",
    meta: null,
    ...overrides,
  };
}

function parsedEvent(event: SessionEvent): SessionEventParseResult {
  return { ok: true, event };
}

function malformedEvent(raw: unknown, reason = "Invalid enum value"): SessionEventParseResult {
  return { ok: false, raw, reason };
}

function makeClient(events: SessionEventParseResult[]): DaemonClient {
  return {
    listSessionEvents: mock(async () => ({ events })),
  } as unknown as DaemonClient;
}

afterEach(() => {
  cleanup();
});

describe("SessionTimeline", () => {
  test("renders rows newest-first with session and continuity families", async () => {
    const events = [
      parsedEvent(
        makeEvent({
          id: 1,
          kind: "session.start",
          ts: "2026-09-01T09:00:00.000Z",
          session_id: "session-alpha-1",
        }),
      ),
      parsedEvent(
        makeEvent({
          id: 2,
          kind: "continuity.boot_pickup",
          ts: "2026-09-01T10:00:00.000Z",
          session_id: "session-beta-2",
          related_session_id: "related-session-99",
          ref_path: "/notes/continuity.md",
        }),
      ),
    ];
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <SessionTimeline
          client={makeClient(events)}
          now={() => Date.parse("2026-09-01T11:00:00Z")}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("session-event-row")).toHaveLength(2);
    });

    const rows = view.getAllByTestId("session-event-row");
    expect(rows[0]!.dataset.kind).toBe("continuity.boot_pickup");
    expect(rows[0]!.dataset.family).toBe("continuity");
    expect(rows[0]!.querySelector(".badge-brand")?.textContent).toBe("continuity.boot_pickup");
    expect(rows[0]!.textContent ?? "").toContain("session-");
    expect(rows[0]!.textContent ?? "").toContain("related-");
    expect(rows[0]!.textContent ?? "").toContain("continuity.md");
    expect(rows[1]!.dataset.kind).toBe("session.start");
    expect(rows[1]!.dataset.family).toBe("session");
    expect(rows[1]!.querySelector(".badge-muted")?.textContent).toBe("session.start");

    view.unmount();
    client.clear();
  });

  test("renders equal-timestamp rows with higher ids first", async () => {
    const ts = "2026-09-01T10:00:00.000Z";
    const events = [
      parsedEvent(makeEvent({ id: 7, ts, session_id: "id-seven-session" })),
      parsedEvent(makeEvent({ id: 9, ts, session_id: "id-nine-session" })),
    ];
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <SessionTimeline client={makeClient(events)} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("session-event-row")).toHaveLength(2);
    });

    const rows = view.getAllByTestId("session-event-row");
    expect(rows[0]!.textContent ?? "").toContain("id-nine-");
    expect(rows[1]!.textContent ?? "").toContain("id-seven");

    view.unmount();
    client.clear();
  });

  test("renders a superseded badge only on note_superseded rows", async () => {
    const events = [
      parsedEvent(makeEvent({ id: 2, kind: "continuity.note_superseded" })),
      parsedEvent(makeEvent({ id: 1, kind: "continuity.draft_reviewed" })),
    ];
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <SessionTimeline client={makeClient(events)} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("session-event-row")).toHaveLength(2);
    });

    expect(view.getAllByTestId("session-event-superseded-badge")).toHaveLength(1);
    const supersededRow = view.getAllByTestId("session-event-row")[0]!;
    expect(supersededRow.dataset.kind).toBe("continuity.note_superseded");

    view.unmount();
    client.clear();
  });

  test("marks the newest skeleton stale only when no later boot pickup exists", async () => {
    const now = Date.parse("2026-09-01T20:00:00.000Z");
    const staleEvents = [
      parsedEvent(
        makeEvent({
          id: 1,
          kind: "continuity.skeleton_generated",
          ts: "2026-09-01T10:00:00.000Z",
        }),
      ),
      parsedEvent(
        makeEvent({
          id: 2,
          kind: "continuity.boot_pickup",
          ts: "2026-09-01T09:00:00.000Z",
        }),
      ),
    ];
    const freshEvents = [
      ...staleEvents,
      parsedEvent(
        makeEvent({
          id: 3,
          kind: "continuity.boot_pickup",
          ts: "2026-09-01T11:00:00.000Z",
        }),
      ),
    ];
    const stale = makeWrapper();
    const staleView = render(
      <stale.Wrapper>
        <SessionTimeline client={makeClient(staleEvents)} now={() => now} staleAfterHours={6} />
      </stale.Wrapper>,
    );

    await waitFor(() => {
      expect(staleView.getAllByTestId("session-event-stale-badge")).toHaveLength(1);
    });
    const staleRow = staleView
      .getByTestId("session-event-stale-badge")
      .closest('[data-testid="session-event-row"]') as HTMLElement | null;
    expect(staleRow?.dataset.kind).toBe("continuity.skeleton_generated");
    staleView.unmount();
    stale.client.clear();

    const fresh = makeWrapper();
    const freshView = render(
      <fresh.Wrapper>
        <SessionTimeline client={makeClient(freshEvents)} now={() => now} staleAfterHours={6} />
      </fresh.Wrapper>,
    );

    await waitFor(() => {
      expect(freshView.getAllByTestId("session-event-row")).toHaveLength(3);
    });
    expect(freshView.queryByTestId("session-event-stale-badge")).toBeNull();
    freshView.unmount();
    fresh.client.clear();
  });

  test("renders malformed rows without dropping valid events", async () => {
    const badRaw = { kind: "continuity.future_kind", ts: "2026-09-01T09:00:00.000Z" };
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <SessionTimeline
          client={makeClient([parsedEvent(makeEvent()), malformedEvent(badRaw)])}
          now={() => Date.parse("2026-09-01T11:00:00Z")}
        />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("session-event-row")).toHaveLength(1);
      expect(view.getAllByTestId("session-event-malformed")).toHaveLength(1);
    });
    expect(view.getByTestId("session-event-malformed").textContent ?? "").toContain(
      "continuity.future_kind",
    );

    view.unmount();
    client.clear();
  });

  test("renders empty state when there are no events", async () => {
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <SessionTimeline client={makeClient([])} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("sessions-empty").textContent).toBe("No session events yet.");
    });

    view.unmount();
    client.clear();
  });

  test("renders an error state when the query fails", async () => {
    const stubClient = {
      listSessionEvents: mock(async () => {
        throw new Error("daemon offline");
      }),
    } as unknown as DaemonClient;
    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <SessionTimeline client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("sessions-timeline-error").textContent ?? "").toContain(
        "daemon offline",
      );
    });
    expect(view.queryByTestId("sessions-empty")).toBeNull();

    view.unmount();
    client.clear();
  });
});
