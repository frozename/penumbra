import "../../setup";
import type { DispatchEvent } from "@penumbra/api-contract";
import type { ReactNode } from "react";

import {
  DispatchAuditResponseSchema,
  DispatchEventsListResponseSchema,
  HandoffDetailResponseSchema,
} from "@penumbra/api-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { DaemonClient } from "@src/api/client";
import {
  makeDispatchAuditResponse,
  makeDispatchEvent,
  makeHandoffDetail,
} from "@src/modules/handoffs/fixtures";
import { HandoffDetail } from "@src/modules/handoffs/HandoffDetail";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";
import { ConfirmDialogProvider } from "@src/ui/ConfirmDialog";
import { ToastProvider } from "@src/ui/Toast";

function makeWrapper(initialRoute: string): {
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
            <MemoryRouter initialEntries={[initialRoute]}>
              <Routes>
                <Route path="/handoffs/:handoffId" element={children} />
              </Routes>
            </MemoryRouter>
          </ConfirmDialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

const TS_EARLY = "2026-09-07T10:00:00.000Z";
const TS_MID = "2026-09-07T10:05:00.000Z";
const TS_LATE = "2026-09-07T10:10:00.000Z";

function makeEvent(overrides: Partial<DispatchEvent> = {}): DispatchEvent {
  return makeDispatchEvent(overrides);
}

interface ClientMocks {
  handoffsGet: ReturnType<typeof mock>;
  dispatchEventsList: ReturnType<typeof mock>;
  dispatchAuditAudit: ReturnType<typeof mock>;
  client: DaemonClient;
}

function makeClient(opts?: {
  handoff?: ReturnType<typeof makeHandoffDetail>;
  events?: DispatchEvent[];
  audit?: ReturnType<typeof makeDispatchAuditResponse>;
}): ClientMocks {
  const handoffsGet = mock(async () => opts?.handoff ?? makeHandoffDetail());
  const dispatchEventsList = mock(async () => ({ events: opts?.events ?? [] }));
  const dispatchAuditAudit = mock(async () => opts?.audit ?? makeDispatchAuditResponse());
  const client = {
    handoffs: { get: handoffsGet },
    dispatchEvents: { list: dispatchEventsList },
    dispatchAudit: { audit: dispatchAuditAudit },
  } as unknown as DaemonClient;
  return { handoffsGet, dispatchEventsList, dispatchAuditAudit, client };
}

beforeEach(() => {
  useUIStore.setState({ activeModule: "handoffs", explorerCollapsed: false });
  useDaemonStore.setState({
    baseUrl: "http://daemon.test/",
    token: "test-token",
    health: "unknown",
    lastHealthAt: null,
    sessionInvalid: false,
  });
});

afterEach(() => {
  cleanup();
});

describe("HandoffDetail", () => {
  test("shows loading until dispatch events settle and marks unknown worktree state", async () => {
    let resolveEvents: (value: { events: DispatchEvent[] }) => void = () => {
      throw new Error("missing resolver");
    };
    const pendingEvents = new Promise<{ events: DispatchEvent[] }>((resolve) => {
      resolveEvents = resolve;
    });
    const client = {
      handoffs: { get: async () => makeHandoffDetail({ use_worktree: null }) },
      dispatchAudit: { audit: async () => makeDispatchAuditResponse() },
      dispatchEvents: { list: () => pendingEvents },
    } as unknown as DaemonClient;
    const { Wrapper } = makeWrapper("/handoffs/h-abc12345");
    const view = render(
      <Wrapper>
        <HandoffDetail client={client} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(view.container.textContent).toContain("Loading dispatch events");
    });
    expect(view.container.textContent).toContain("use_worktree: —");
    expect(view.container.textContent).not.toContain("No dispatch events");
    resolveEvents({ events: [] });
    await waitFor(() => {
      expect(view.container.textContent).toContain("No dispatch events");
    });
    expect(view.container.textContent).not.toContain("Loading dispatch events");
    view.unmount();
  });

  test("a direct detail link activates the handoffs module", async () => {
    useUIStore.setState({ activeModule: "mission" });
    const { Wrapper } = makeWrapper("/handoffs/h-abc12345");
    const view = render(
      <Wrapper>
        <HandoffDetail client={makeClient().client} />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(useUIStore.getState().activeModule).toBe("handoffs");
    });
    view.unmount();
  });

  test("the default client parses daemon responses and renders the requested handoff", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    const id = "h-round-trip";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      requested.push(url.pathname + url.search);
      if (url.pathname === `/handoffs/${id}`) {
        return Response.json(
          HandoffDetailResponseSchema.parse(
            makeHandoffDetail({ handoff_id: id, message: "round-trip response" }),
          ),
        );
      }
      if (url.pathname === "/dispatch/events" && url.searchParams.get("handoff_id") === id) {
        return Response.json(
          DispatchEventsListResponseSchema.parse({
            events: [makeEvent({ handoff_id: id, kind: "dispatch.end" })],
          }),
        );
      }
      if (url.pathname === "/dispatch/audit" && url.searchParams.get("handoff_id") === id) {
        return Response.json(
          DispatchAuditResponseSchema.parse(makeDispatchAuditResponse({ handoff_id: id })),
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const { Wrapper, client } = makeWrapper(`/handoffs/${id}`);
    const view = render(
      <Wrapper>
        <HandoffDetail />
      </Wrapper>,
    );
    try {
      await waitFor(() => {
        expect(view.container.textContent).toContain("round-trip response");
        expect(
          view.container.querySelector('[data-testid="dispatch-timeline"]')?.textContent,
        ).toContain("dispatch.end");
        expect(
          view.container
            .querySelector('[data-testid="reliability-chip"]')
            ?.getAttribute("data-action"),
        ).toBe("accept");
      });
      expect(requested).toEqual(
        expect.arrayContaining([
          `/handoffs/${id}`,
          `/dispatch/events?handoff_id=${id}`,
          `/dispatch/audit?handoff_id=${id}`,
        ]),
      );
    } finally {
      view.unmount();
      client.clear();
      globalThis.fetch = originalFetch;
    }
  });

  test("renders message, to_agent, branch, worktree and dispatch events newest-first", async () => {
    const events = [
      makeEvent({ kind: "dispatch.start", ts: TS_EARLY }),
      makeEvent({ kind: "agent.heartbeat", ts: TS_MID }),
      makeEvent({ kind: "agent.thought", ts: TS_MID }),
      makeEvent({ kind: "dispatch.end", ts: TS_LATE }),
    ];
    const mocks = makeClient({
      handoff: makeHandoffDetail({
        message: "implement the feature",
        to_agent: "codex",
        branch_name: "feat/branch",
        use_worktree: true,
      }),
      events,
    });

    const { Wrapper } = makeWrapper("/handoffs/h-abc12345");
    const view = render(<Wrapper>{<HandoffDetail client={mocks.client} />}</Wrapper>);

    await waitFor(() => {
      expect(view.container.textContent).toContain("implement the feature");
    });

    expect(view.container.textContent).toContain("codex");
    expect(view.container.textContent).toContain("feat/branch");
    expect(view.container.textContent).toContain("use_worktree: true");

    const timeline = view.container.querySelector('[data-testid="dispatch-timeline"]');
    expect(timeline).not.toBeNull();
    const items = timeline!.querySelectorAll("li");
    expect(items).toHaveLength(4);

    const kinds = Array.from(items).map((li) => li.querySelectorAll("span")[1]?.textContent ?? "");
    expect(kinds).toEqual(["dispatch.end", "agent.heartbeat", "agent.thought", "dispatch.start"]);

    expect(events[0]!.ts).toBe(TS_EARLY);
    expect(events[1]!.ts).toBe(TS_MID);
    expect(events.map((event) => event.kind)).toEqual([
      "dispatch.start",
      "agent.heartbeat",
      "agent.thought",
      "dispatch.end",
    ]);
    expect(mocks.handoffsGet).toHaveBeenCalledWith("h-abc12345");
    expect(mocks.dispatchEventsList).toHaveBeenCalledWith("h-abc12345");
    expect(mocks.dispatchAuditAudit).toHaveBeenCalledWith("h-abc12345");

    view.unmount();
  });

  test("ReliabilityChip shows report.status and the recommended action", async () => {
    const mocks = makeClient({
      audit: makeDispatchAuditResponse({
        status: "non_terminal_stale",
        recommended_action: "wait",
        summary: "agent has been idle",
      }),
    });

    const { Wrapper } = makeWrapper("/handoffs/h-abc12345");
    const view = render(<Wrapper>{<HandoffDetail client={mocks.client} />}</Wrapper>);

    await waitFor(() => {
      const chip = view.container.querySelector('[data-testid="reliability-chip"]');
      expect(chip).not.toBeNull();
    });

    const chip = view.container.querySelector('[data-testid="reliability-chip"]')!;
    expect(chip.getAttribute("data-status")).toBe("non_terminal_stale");
    expect(chip.getAttribute("data-action")).toBe("wait");
    expect(chip.textContent).toContain("non_terminal_stale");
    expect(chip.textContent).toContain("wait");

    view.unmount();
  });

  test("no Land and no Fail control is rendered", async () => {
    const mocks = makeClient();

    const { Wrapper } = makeWrapper("/handoffs/h-abc12345");
    const view = render(<Wrapper>{<HandoffDetail client={mocks.client} />}</Wrapper>);

    await waitFor(() => {
      expect(view.container.textContent).toContain("implement the handoffs module");
    });

    const buttons = view.container.querySelectorAll("button");
    const buttonLabels = Array.from(buttons).map((b) => b.textContent ?? "");
    expect(buttonLabels).not.toContain("Land");
    expect(buttonLabels).not.toContain("Fail");
    expect(buttonLabels).not.toContain("Complete");

    view.unmount();
  });

  test("every rendered handoff_id and conversation_id goes through EntityLink — handoff as anchor and conversation as code with no anchor", async () => {
    const mocks = makeClient({
      handoff: makeHandoffDetail({
        handoff_id: "h-full12345",
        conversation_id: "c-full12345",
      }),
    });

    const { Wrapper } = makeWrapper("/handoffs/h-full12345");
    const view = render(<Wrapper>{<HandoffDetail client={mocks.client} />}</Wrapper>);

    await waitFor(() => {
      expect(view.container.textContent).toContain("h-full12345");
    });

    const handoffAnchors = view.container.querySelectorAll('a[href="/handoffs/h-full12345"]');
    expect(handoffAnchors.length).toBeGreaterThanOrEqual(1);

    const conversationCode = view.container.querySelectorAll("code");
    const conversationTexts = Array.from(conversationCode).map((c) => c.textContent ?? "");
    expect(conversationTexts).toContain("c-full12345");

    const chainAnchors = view.container.querySelectorAll('a[href*="/chains/"]');
    expect(chainAnchors).toHaveLength(0);

    view.unmount();
  });
});
