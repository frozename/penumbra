import "../../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

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

afterEach(() => {
  cleanup();
});

describe("RegistrarList", () => {
  test("renders empty-state copy when the API returns no entries", async () => {
    const listRegistrarEntries = mock(async () => ({ entries: [] }));
    const getRegistrarEntry = mock(async () => {
      throw new Error("getRegistrarEntry should not be called for an empty list");
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

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
    const listRegistrarEntries = mock(async () => ({
      entries: [
        makeEntry({
          rollup: { open_blockers: 3, open_follow_ups: 2 },
          phase_progress: { complete: 4, total: 5 },
        }),
      ],
    }));
    const getRegistrarEntry = mock(async () => {
      throw new Error(
        "getRegistrarEntry should not be called when the list payload carries rollup",
      );
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

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
    expect(getRegistrarEntry).toHaveBeenCalledTimes(0);

    view.unmount();
    client.clear();
  });

  test("rows link to the registrar detail route", async () => {
    const listRegistrarEntries = mock(async () => ({
      entries: [makeEntry({ registrar_id: "reg-9" })],
    }));
    const getRegistrarEntry = mock(async () => {
      throw new Error("getRegistrarEntry should not be called for a list link");
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

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
    const listRegistrarEntries = mock(async () => {
      throw new Error("daemon offline");
    });
    const getRegistrarEntry = mock(async () => {
      throw new Error("getRegistrarEntry should not be called when the list fetch fails");
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

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

  test("renders a placeholder when rollup is absent", async () => {
    const listRegistrarEntries = mock(async () => ({ entries: [makeEntry()] }));
    const getRegistrarEntry = mock(async () => {
      throw new Error("getRegistrarEntry should not be called for the list placeholder");
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

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
    expect(marker.getAttribute("title") ?? "").toContain("counts unavailable");
    expect(marker.getAttribute("aria-label") ?? "").toContain("counts unavailable");
    expect(marker.textContent ?? "").not.toContain("0 blockers");
    expect(marker.textContent ?? "").not.toContain("0 follow-ups");
    expect(view.queryByTestId("registrar-open-blockers")).toBeNull();
    expect(view.queryByTestId("registrar-open-follow-ups")).toBeNull();
    expect(view.getByTestId("registrar-phase-progress").textContent).toBe("—");
    expect(getRegistrarEntry).toHaveBeenCalledTimes(0);

    view.unmount();
    client.clear();
  });

  test("zero rollup counts render as muted zero badges, not the unavailable indicator", async () => {
    const listRegistrarEntries = mock(async () => ({
      entries: [
        makeEntry({
          rollup: { open_blockers: 0, open_follow_ups: 0 },
          phase_progress: { complete: 0, total: 5 },
        }),
      ],
    }));
    const getRegistrarEntry = mock(async () => {
      throw new Error(
        "getRegistrarEntry should not be called when the list payload carries rollup",
      );
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

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
    expect(view.getByTestId("registrar-phase-progress").textContent).toBe("0/5 phases");
    expect(getRegistrarEntry).toHaveBeenCalledTimes(0);

    view.unmount();
    client.clear();
  });

  test("renders N rows with one listRegistrarEntries call and getRegistrarEntry called 0 times", async () => {
    const listRegistrarEntries = mock(async () => ({
      entries: [
        makeEntry({
          registrar_id: "reg-1",
          rollup: { open_blockers: 0, open_follow_ups: 0 },
          phase_progress: { complete: 1, total: 5 },
        }),
        makeEntry({
          registrar_id: "reg-2",
          rollup: { open_blockers: 2, open_follow_ups: 1 },
          phase_progress: { complete: 3, total: 5 },
        }),
      ],
    }));
    const getRegistrarEntry = mock(async () => {
      throw new Error(
        "getRegistrarEntry should not be called when the list payload carries rollup",
      );
    });
    const stubClient = { listRegistrarEntries, getRegistrarEntry } as unknown as DaemonClient;

    const { Wrapper, client } = makeWrapper();
    const view = render(
      <Wrapper>
        <RegistrarList client={stubClient} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(view.getAllByTestId("registrar-row").length).toBe(2);
    });
    expect(listRegistrarEntries).toHaveBeenCalledTimes(1);
    expect(getRegistrarEntry).toHaveBeenCalledTimes(0);

    view.unmount();
    client.clear();
  });
});
