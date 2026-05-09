import "../setup";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react/pure";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MODULES } from "../../src/modules/manifest";
import { Shell } from "../../src/shell/Shell";
import { useDaemonStore } from "../../src/stores/daemon-store";
import { useUIStore } from "../../src/stores/ui-store";

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
  globalThis.fetch = mock(async () =>
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

    const brand = view.container.querySelector(".tb .brand") as HTMLElement | null;
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

  test("clicking the chains rail button navigates and renders the chains route", () => {
    const view = renderShellAt("/mission");

    const chainsButton = view.container.querySelector(
      'button[title="Chains"]',
    ) as HTMLButtonElement | null;
    expect(chainsButton).not.toBeNull();
    if (!chainsButton) return;
    fireEvent.click(chainsButton);

    expect(view.container.textContent ?? "").toContain("Chains module");
    expect(useUIStore.getState().activeModule).toBe("chains");
  });
});
