import "../../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import { DaemonHttpError } from "@src/api/errors";
import { RegistrarDetail } from "@src/modules/registrar";
import { JournalFeed } from "@src/modules/registrar/JournalFeed";
import { PhaseTimeline } from "@src/modules/registrar/PhaseTimeline";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

const BASE_TS = 1_756_200_000_000;

function makePhase(phaseNo: number, status: string): Record<string, unknown> {
  return {
    registrar_id: "reg-1",
    phase_no: phaseNo,
    title: `Phase ${phaseNo}`,
    status,
    updated_at: BASE_TS + phaseNo * 1000,
  };
}

function makeEvent(
  eventId: number,
  createdAt: number,
  kind: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event_id: eventId,
    registrar_id: "reg-1",
    phase_no: null,
    kind,
    state: null,
    ref_event_id: null,
    link_kind: null,
    link_value: null,
    actor: "maestro",
    body: `event ${eventId}`,
    created_at: createdAt,
    ...overrides,
  };
}

function makeDetailFixture(): {
  entry: Record<string, unknown>;
  phases: Record<string, unknown>[];
  events: Record<string, unknown>[];
  rollup: { open_blockers: number; open_follow_ups: number };
} {
  return {
    entry: {
      registrar_id: "reg-1",
      slug: "plan-alpha",
      title: "Plan Alpha",
      home_project: "penumbra",
      source_doc_path: null,
      status: "active",
      created_at: BASE_TS,
      updated_at: BASE_TS + 60_000,
    },
    phases: [makePhase(1, "complete"), makePhase(2, "active"), makePhase(3, "blocked")],
    events: [
      makeEvent(1, BASE_TS + 1000, "progress"),
      makeEvent(2, BASE_TS + 2000, "follow_up", { state: "owed", actor: "worker" }),
      makeEvent(3, BASE_TS + 3000, "blocker", { state: "opened", phase_no: 3 }),
    ],
    rollup: { open_blockers: 1, open_follow_ups: 1 },
  };
}

function makeWrapper(initialEntries: string[]): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <ConfirmDialogProvider>{children}</ConfirmDialogProvider>
          </ToastProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }
  return { Wrapper, client };
}

// Drive a controlled <textarea>'s React onChange under happy-dom: a bare
// fireEvent.change/input leaves React's ChangeEventPlugin unsynced, so the
// component keeps reading the initial value. The keystroke envelope below is
// the same pattern used for controlled <input>s elsewhere in this suite.
function typeIntoField(field: HTMLTextAreaElement, value: string): void {
  fireEvent.focus(field);
  fireEvent.keyDown(field, { key: value.slice(-1) || "x" });
  fireEvent.input(field, { target: { value } });
  fireEvent.keyUp(field, { key: value.slice(-1) || "x" });
}

afterEach(() => {
  cleanup();
});

describe("PhaseTimeline", () => {
  test("renders phases in phase_no order with statuses", () => {
    const view = render(
      <PhaseTimeline
        phases={
          [makePhase(3, "blocked"), makePhase(1, "complete"), makePhase(2, "active")] as never
        }
      />,
    );

    const items = view.getAllByTestId("phase-item");
    expect(items.map((el) => el.getAttribute("data-phase-no"))).toEqual(["1", "2", "3"]);
    const texts = items.map((el) => el.textContent ?? "");
    expect(texts[0]).toContain("complete");
    expect(texts[1]).toContain("active");
    expect(texts[2]).toContain("blocked");
  });
});

describe("JournalFeed", () => {
  test("renders events in chronological order with kind labels", () => {
    const view = render(
      <JournalFeed
        events={
          [
            makeEvent(3, BASE_TS + 3000, "decision"),
            makeEvent(1, BASE_TS + 1000, "progress"),
            makeEvent(2, BASE_TS + 2000, "follow_up", { state: "owed" }),
          ] as never
        }
      />,
    );

    const items = view.getAllByTestId("journal-event");
    expect(items.map((el) => el.getAttribute("data-event-id"))).toEqual(["1", "2", "3"]);
    const kinds = items.map((el) => el.querySelector('[data-testid="journal-kind"]')?.textContent);
    expect(kinds).toEqual(["Progress", "Follow-up", "Decision"]);
  });

  test("renders empty-state copy when there are no events", () => {
    const view = render(<JournalFeed events={[]} />);
    expect(view.getByTestId("journal-empty").textContent).toBe("No journal events.");
  });
});

function makeAppendedEvent(): { event: Record<string, unknown> } {
  return {
    event: {
      event_id: 9,
      registrar_id: "reg-1",
      phase_no: null,
      kind: "progress",
      state: null,
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "operator",
      body: "Kickoff done",
      created_at: BASE_TS,
    },
  };
}

describe("RegistrarDetail", () => {
  test("renders phase timeline and journal from the API detail and events payloads", async () => {
    const detail = makeDetailFixture();
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents: mock(async () => ({ events: detail.events })),
      registrar: { appendEvent: mock(async () => makeAppendedEvent()) },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      const phaseItems = view.getAllByTestId("phase-item");
      expect(phaseItems.map((el) => el.getAttribute("data-phase-no"))).toEqual(["1", "2", "3"]);
      expect(phaseItems.map((el) => el.textContent ?? "")[2]).toContain("blocked");

      const journalItems = view.getAllByTestId("journal-event");
      expect(journalItems.map((el) => el.getAttribute("data-event-id"))).toEqual(["1", "2", "3"]);
      expect(journalItems.map((el) => el.textContent ?? "")[1]).toContain("Follow-up");

      expect(view.getByTestId("detail-open-blockers").textContent).toBe("1 blockers");
      expect(view.getByTestId("detail-open-follow-ups").textContent).toBe("1 follow-ups");
    });

    view.unmount();
    client.clear();
  });

  test("renders the empty journal copy when the events payload is empty", async () => {
    const detail = makeDetailFixture();
    detail.events = [];
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents: mock(async () => ({ events: [] })),
      registrar: { appendEvent: mock(async () => makeAppendedEvent()) },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-empty").textContent).toBe("No journal events.");
    });

    view.unmount();
    client.clear();
  });

  test("renders an explicit journal error state when the events query fails", async () => {
    const detail = makeDetailFixture();
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents: mock(async () => {
        throw new Error("events fetch failed");
      }),
      registrar: { appendEvent: mock(async () => makeAppendedEvent()) },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      const error = view.getByTestId("registrar-journal-error");
      expect(error.textContent ?? "").toContain("events fetch failed");
    });
    expect(view.queryByTestId("journal-empty")).toBeNull();

    view.unmount();
    client.clear();
  });

  test("Add journal entry posts RegistrarEventInput {actor:'operator'} and invalidates registrarEvents(id)", async () => {
    const detail = makeDetailFixture();
    detail.events = [];
    const appendEvent = mock(async () => makeAppendedEvent());
    const listRegistrarEvents = mock(async () => ({ events: [] }));
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents,
      registrar: { appendEvent },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-composer-body")).toBeTruthy();
    });
    expect(listRegistrarEvents).toHaveBeenCalledTimes(1);

    typeIntoField(view.getByTestId("journal-composer-body") as HTMLTextAreaElement, "Kickoff done");
    fireEvent.click(view.getByTestId("journal-composer-add"));

    await waitFor(() => {
      expect(appendEvent).toHaveBeenCalledWith("reg-1", {
        kind: "progress",
        body: "Kickoff done",
        actor: "operator",
      });
    });
    await waitFor(() => {
      expect(listRegistrarEvents).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect((view.getByTestId("journal-composer-body") as HTMLTextAreaElement).value).toBe("");
    });

    view.unmount();
    client.clear();
  });

  test("the Add button stays disabled while the post-append refetch is in flight", async () => {
    const detail = makeDetailFixture();
    detail.events = [];
    const appendEvent = mock(async () => makeAppendedEvent());
    let listCall = 0;
    const refetchGate: {
      resolve: ((value: { events: Record<string, unknown>[] }) => void) | null;
    } = { resolve: null };
    const listRegistrarEvents = mock(async () => {
      listCall += 1;
      if (listCall === 1) {
        return { events: [] };
      }
      return await new Promise<{ events: Record<string, unknown>[] }>((resolve) => {
        refetchGate.resolve = resolve;
      });
    });
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents,
      registrar: { appendEvent },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-composer-body")).toBeTruthy();
    });
    expect(listRegistrarEvents).toHaveBeenCalledTimes(1);

    typeIntoField(view.getByTestId("journal-composer-body") as HTMLTextAreaElement, "Kickoff done");
    fireEvent.click(view.getByTestId("journal-composer-add"));

    await waitFor(() => {
      expect(listRegistrarEvents).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(view.getByTestId("journal-composer-add").hasAttribute("disabled")).toBe(true);
    });

    if (refetchGate.resolve === null) {
      throw new Error("deferred refetch not captured");
    }
    refetchGate.resolve({ events: [] });
    await waitFor(() => {
      expect((view.getByTestId("journal-composer-body") as HTMLTextAreaElement).value).toBe("");
    });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(listRegistrarEvents).toHaveBeenCalledTimes(2);

    view.unmount();
    client.clear();
  });

  test("a whitespace-only body leaves Add disabled and posts nothing", async () => {
    const detail = makeDetailFixture();
    detail.events = [];
    const appendEvent = mock(async () => makeAppendedEvent());
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents: mock(async () => ({ events: [] })),
      registrar: { appendEvent },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-composer-body")).toBeTruthy();
    });

    typeIntoField(view.getByTestId("journal-composer-body") as HTMLTextAreaElement, " ");
    const addButton = view.getByTestId("journal-composer-add");
    await waitFor(() => {
      expect(addButton.hasAttribute("disabled")).toBe(true);
    });
    fireEvent.click(addButton);
    expect(appendEvent).toHaveBeenCalledTimes(0);

    view.unmount();
    client.clear();
  });

  test("a failed append preserves the typed body and re-enables Add", async () => {
    const detail = makeDetailFixture();
    detail.events = [];
    const appendEvent = mock(async () => {
      throw new DaemonHttpError({
        status: 500,
        statusText: "Internal Server Error",
        bodyText: "server error",
        url: "http://127.0.0.1/registrar/reg-1/events",
      });
    });
    const listRegistrarEvents = mock(async () => ({ events: [] }));
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents,
      registrar: { appendEvent },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-composer-body")).toBeTruthy();
    });

    typeIntoField(
      view.getByTestId("journal-composer-body") as HTMLTextAreaElement,
      "Keep this draft",
    );
    fireEvent.click(view.getByTestId("journal-composer-add"));

    await waitFor(() => {
      expect(appendEvent).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const textarea = view.getByTestId("journal-composer-body") as HTMLTextAreaElement;
      expect(textarea.value).toBe("Keep this draft");
      const button = view.getByTestId("journal-composer-add");
      expect(button.hasAttribute("disabled")).toBe(false);
    });

    view.unmount();
    client.clear();
  });

  test("a body over 4096 bytes is blocked client-side with a counter and no request", async () => {
    const detail = makeDetailFixture();
    const appendEvent = mock(async () => makeAppendedEvent());
    const stubClient = {
      getRegistrarEntry: mock(async () => detail),
      listRegistrarEvents: mock(async () => ({ events: [] })),
      registrar: { appendEvent },
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-composer-body")).toBeTruthy();
    });
    typeIntoField(
      view.getByTestId("journal-composer-body") as HTMLTextAreaElement,
      "a".repeat(4097),
    );

    await waitFor(() => {
      expect(view.getByTestId("journal-composer-bytes").textContent ?? "").toContain("4097");
    });
    const addButton = view.getByTestId("journal-composer-add");
    expect(addButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(addButton);
    await waitFor(() => {
      expect(view.getByTestId("journal-composer-bytes").textContent ?? "").toContain("4097");
    });
    expect(appendEvent).toHaveBeenCalledTimes(0);

    view.unmount();
    client.clear();
  });

  test("a 404 on /registrar renders 'registrar disabled', not an error toast", async () => {
    const stubClient = {
      getRegistrarEntry: mock(async () => {
        throw new DaemonHttpError({
          status: 404,
          statusText: "Not Found",
          bodyText: "not found",
          url: "http://127.0.0.1/registrar/reg-1",
        });
      }),
      listRegistrarEvents: mock(async () => ({ events: [] })),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("registrar-disabled").textContent ?? "").toContain(
        "registrar disabled",
      );
    });
    expect(view.queryByTestId("registrar-detail-error")).toBeNull();
    expect(view.container.querySelector(".toast")).toBeNull();

    view.unmount();
    client.clear();
  });

  test("a 404 with code registrar_not_found renders the error state, not 'registrar disabled'", async () => {
    const stubClient = {
      getRegistrarEntry: mock(async () => {
        throw new DaemonHttpError({
          status: 404,
          statusText: "Not Found",
          bodyText: JSON.stringify({ error: "registrar_not_found", registrar_id: "reg-1" }),
          url: "http://127.0.0.1/registrar/reg-1",
        });
      }),
      listRegistrarEvents: mock(async () => ({ events: [] })),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper(["/registrar/reg-1"]);
    const view = render(
      <Wrapper>
        <Routes>
          <Route path="/registrar/:registrarId" element={<RegistrarDetail client={stubClient} />} />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("registrar-detail-error")).toBeTruthy();
    });
    expect(view.queryByTestId("registrar-disabled")).toBeNull();

    view.unmount();
    client.clear();
  });
});
