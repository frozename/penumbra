import "../../setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import type { DaemonClient } from "@src/api/client";
import { RegistrarList } from "@src/modules/registrar";

function makeWrapper(initialEntries: string[] = ["/registrar"]): {
  Wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  client: QueryClient;
} {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  }
  return { Wrapper, client };
}

const BASE_TS = 1_756_200_000_000;

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registrar_id: "reg-1",
    slug: "plan-alpha",
    title: "Plan Alpha",
    home_project: "penumbra",
    source_doc_path: null,
    status: "active",
    created_at: BASE_TS,
    updated_at: BASE_TS + 60_000,
    ...overrides,
  };
}

interface DetailOverrides {
  openBlockers?: number;
  openFollowUps?: number;
  completedPhases?: number;
  totalPhases?: number;
}

function makeDetail(
  registrarId: string,
  overrides: DetailOverrides = {},
): {
  entry: Record<string, unknown>;
  phases: Record<string, unknown>[];
  events: Record<string, unknown>[];
  rollup: { open_blockers: number; open_follow_ups: number };
} {
  const totalPhases = overrides.totalPhases ?? 5;
  const completedPhases = overrides.completedPhases ?? 4;
  const phases = Array.from({ length: totalPhases }, (_, index) => ({
    registrar_id: registrarId,
    phase_no: index + 1,
    title: `Phase ${index + 1}`,
    status: index < completedPhases ? "complete" : "pending",
    updated_at: BASE_TS + index * 1000,
  }));
  // Two blocker-kind events while the rollup reports three open blockers: a
  // client that recomputes the count from events would render the wrong badge.
  const events = [
    {
      event_id: 1,
      registrar_id: registrarId,
      phase_no: 1,
      kind: "blocker",
      state: "opened",
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "worker",
      body: "first blocker",
      created_at: BASE_TS + 1000,
    },
    {
      event_id: 2,
      registrar_id: registrarId,
      phase_no: 2,
      kind: "blocker",
      state: "opened",
      ref_event_id: null,
      link_kind: null,
      link_value: null,
      actor: "worker",
      body: "second blocker",
      created_at: BASE_TS + 2000,
    },
  ];
  return {
    entry: makeEntry({ registrar_id: registrarId }),
    phases,
    events,
    rollup: {
      open_blockers: overrides.openBlockers ?? 3,
      open_follow_ups: overrides.openFollowUps ?? 2,
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("RegistrarList", () => {
  test("renders empty-state copy when the API returns no entries", async () => {
    const stubClient = {
      listRegistrarEntries: mock(async () => ({ entries: [] })),
      getRegistrarEntry: mock(async () => {
        throw new Error("getRegistrarEntry should not be called for an empty list");
      }),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("registrar-empty").textContent).toBe("No initiatives registered.");
    });

    view.unmount();
    client.clear();
  });

  test("row shows status, phase progress, and open blocker/follow-up badges taken from the API rollup", async () => {
    const detail = makeDetail("reg-1", { openBlockers: 3, openFollowUps: 2 });
    const stubClient = {
      listRegistrarEntries: mock(async () => ({ entries: [detail.entry] })),
      getRegistrarEntry: mock(async () => detail),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      const row = view.getByTestId("registrar-row");
      expect(row.textContent ?? "").toContain("Plan Alpha");
      expect(view.getByTestId("registrar-status").textContent).toBe("active");
      expect(view.getByTestId("registrar-phase-progress").textContent).toBe("4/5 phases");
      expect(view.getByTestId("registrar-open-blockers").textContent).toBe("3 blockers");
      expect(view.getByTestId("registrar-open-follow-ups").textContent).toBe("2 follow-ups");
    });

    view.unmount();
    client.clear();
  });

  test("rows link to the registrar detail route", async () => {
    const detail = makeDetail("reg-9");
    const stubClient = {
      listRegistrarEntries: mock(async () => ({ entries: [detail.entry] })),
      getRegistrarEntry: mock(async () => detail),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      const link = view.getByTestId("registrar-row").closest("a");
      expect(link?.getAttribute("href")).toBe("/registrar/reg-9");
    });

    view.unmount();
    client.clear();
  });

  test("renders a distinct error state and no empty-state copy when the list query fails", async () => {
    const stubClient = {
      listRegistrarEntries: mock(async () => {
        throw new Error("daemon offline");
      }),
      getRegistrarEntry: mock(async () => {
        throw new Error("getRegistrarEntry should not be called when the list fetch fails");
      }),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      const error = view.getByTestId("registrar-list-error");
      expect(error.textContent ?? "").toContain("daemon offline");
    });
    expect(view.queryByTestId("registrar-empty")).toBeNull();
    expect(view.container.textContent ?? "").not.toContain("No initiatives registered.");

    view.unmount();
    client.clear();
  });

  test("row renders an explicit rollup-unavailable indicator when the detail query fails", async () => {
    const stubClient = {
      listRegistrarEntries: mock(async () => ({ entries: [makeEntry({ registrar_id: "reg-1" })] })),
      getRegistrarEntry: mock(async () => {
        throw new Error("detail fetch failed");
      }),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("registrar-rollup-unavailable")).toBeDefined();
    });
    const marker = view.getByTestId("registrar-rollup-unavailable");
    // Distinct from a zero-count badge ("0 blockers" / "0 follow-ups"): the
    // marker names the unavailability via its label instead of a count.
    expect(marker.getAttribute("title") ?? "").toContain("counts unavailable");
    expect(marker.getAttribute("aria-label") ?? "").toContain("counts unavailable");
    expect(marker.textContent ?? "").not.toContain("0 blockers");
    expect(marker.textContent ?? "").not.toContain("0 follow-ups");
    expect(view.queryByTestId("registrar-open-blockers")).toBeNull();
    expect(view.queryByTestId("registrar-open-follow-ups")).toBeNull();

    view.unmount();
    client.clear();
  });

  test("zero rollup counts render as muted zero badges, not the unavailable indicator", async () => {
    const detail = makeDetail("reg-1", { openBlockers: 0, openFollowUps: 0 });
    const stubClient = {
      listRegistrarEntries: mock(async () => ({ entries: [detail.entry] })),
      getRegistrarEntry: mock(async () => detail),
    } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getByTestId("registrar-open-blockers").textContent).toBe("0 blockers");
      expect(view.getByTestId("registrar-open-follow-ups").textContent).toBe("0 follow-ups");
    });
    expect(view.queryByTestId("registrar-rollup-unavailable")).toBeNull();

    view.unmount();
    client.clear();
  });
});
