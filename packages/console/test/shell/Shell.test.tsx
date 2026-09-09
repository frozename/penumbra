import "../setup";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { MODULES } from "@src/modules/manifest";
import { Shell } from "@src/shell/Shell";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

const ORIGINAL_FETCH = globalThis.fetch;

function MissionStub(): JSX.Element {
  return <div className="surface-stub">Mission Control coming online…</div>;
}
function ChainsStub(): JSX.Element {
  return <div className="surface-stub">Chains module — wired in P1.</div>;
}

function resetStores() {
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "t",
    health: "unknown",
    lastHealthAt: null,
  });
  useUIStore.setState({
    activeModule: "mission",
    explorerCollapsed: false,
  });
  localStorage.clear();
}

beforeEach(() => {
  resetStores();
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = ORIGINAL_FETCH;
  resetStores();
});

function renderShellAt(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<Shell />}>
            {MODULES.map((module) => (
              <Route
                key={module.id}
                path={module.id}
                element={module.id === "mission" ? <MissionStub /> : <ChainsStub />}
              />
            ))}
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Shell", () => {
  test("mounts titlebar, rail, statusbar at /mission and shows mission stub", () => {
    const view = renderShellAt("/mission");

    const brand = view.container.querySelector(".tb .brand");
    expect(brand?.textContent ?? "").toContain("penumbra");
    expect(view.getByTitle("Mission control")).toBeTruthy();
    expect(view.container.querySelector(".exp-proj-card")).toBeTruthy();
    expect(view.container.textContent ?? "").toContain("penumbra");
    expect(view.container.textContent ?? "").toContain("daemon");
    expect(view.container.textContent ?? "").toContain("Mission Control coming online");
  });

  test("polls daemon health and updates the store via stubbed fetch", async () => {
    renderShellAt("/mission");

    await waitFor(() => {
      expect(useDaemonStore.getState().health).toBe("ok");
    });
  });

  test("clicking the plans rail button navigates and renders the plans route", () => {
    const view = renderShellAt("/mission");

    const plansButton = view.container.querySelector('button[title="Plans"]');
    expect(plansButton).not.toBeNull();
    if (!plansButton) return;
    fireEvent.click(plansButton);

    expect(view.container.textContent ?? "").toContain("Chains module");
    expect(useUIStore.getState().activeModule).toBe("registrar");
  });

  test("shows the reload banner only when sessionInvalid is true", () => {
    const view = renderShellAt("/mission");
    expect(view.queryByRole("alert")).toBeNull();
    act(() => {
      useDaemonStore.getState().setSessionInvalid(true);
    });
    const banner = view.getByRole("alert");
    expect(banner.textContent ?? "").toContain("console restarted — reload");
  });

  test("banner is not a direct child of .app when visible (does not disturb grid layout)", () => {
    const view = renderShellAt("/mission");
    act(() => {
      useDaemonStore.getState().setSessionInvalid(true);
    });
    const appEl = view.container.querySelector(".app");
    expect(appEl).not.toBeNull();
    const banner = view.getByRole("alert");
    // The banner must NOT be a direct child of .app — it would add a 4th grid
    // child and shift every row. It should be outside the grid flow.
    expect(appEl!.contains(banner)).toBe(false);
  });
});
