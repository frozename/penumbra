import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { MODULES, type ModuleSpec } from "@src/modules/manifest";
import { Rail } from "@src/shell/Rail";
import { useUIStore } from "@src/stores/ui-store";

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

const ghost: ModuleSpec = {
  id: "ghost",
  path: "/ghost",
  label: "Ghost",
  icon: "g",
  available: false,
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  useUIStore.setState({
    activeModule: "mission",
    explorerCollapsed: false,
  });
  localStorage.clear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ handoffs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Rail", () => {
  test("an available:false entry renders no rail button", () => {
    const { Wrapper } = makeWrapper();
    const { container } = render(
      <Wrapper>
        <Rail activeModule="mission" onSelect={mock(() => {})} modules={[ghost, ...MODULES]} />
      </Wrapper>,
    );

    expect(container.querySelectorAll('button[title="Ghost"]').length).toBe(0);
    for (const m of MODULES.filter((module) => module.available)) {
      expect(container.querySelector(`button[title="${m.label}"]`)).not.toBeNull();
    }
  });

  test("no settings button is rendered", () => {
    const { Wrapper } = makeWrapper();
    const { container } = render(
      <Wrapper>
        <Rail activeModule="mission" onSelect={mock(() => {})} />
      </Wrapper>,
    );

    for (const module of MODULES.filter((m) => m.available)) {
      const button = container.querySelector(`button[title="${module.label}"]`);
      expect(button).not.toBeNull();
      expect(button?.textContent ?? "").toContain(module.icon);
    }
    expect(container.querySelector('button[title="settings"]')).toBeNull();
  });

  test("marks the active module", () => {
    const { Wrapper } = makeWrapper();
    const { container, rerender } = render(
      <Wrapper>
        <Rail activeModule="mission" onSelect={mock(() => {})} />
      </Wrapper>,
    );

    const getButton = (title: string) => container.querySelector(`button[title="${title}"]`);

    expect(getButton("Mission control")?.className).toContain("active");
    expect(getButton("Plans")?.className).not.toContain("active");

    rerender(
      <Wrapper>
        <Rail activeModule="registrar" onSelect={mock(() => {})} />
      </Wrapper>,
    );

    expect(getButton("Plans")?.className).toContain("active");
    expect(getButton("Mission control")?.className).not.toContain("active");
  });

  test("calls onSelect when provided", () => {
    const { Wrapper } = makeWrapper();
    const onSelect = mock(() => {});
    const { container } = render(
      <Wrapper>
        <Rail activeModule="mission" onSelect={onSelect} />
      </Wrapper>,
    );
    const plans = container.querySelector('button[title="Plans"]');

    expect(plans).not.toBeNull();
    if (!plans) return;
    fireEvent.click(plans);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("registrar");
    expect(useUIStore.getState().activeModule).toBe("mission");
  });

  test("updates store and navigates when onSelect is omitted", () => {
    function LocationView() {
      const location = useLocation();
      return <div data-testid="location">{location.pathname}</div>;
    }

    const { Wrapper } = makeWrapper();
    const { container, getByTestId } = render(
      <Wrapper>
        <MemoryRouter initialEntries={["/mission"]}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <LocationView />
                  <Rail />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </Wrapper>,
    );
    const plans = container.querySelector('button[title="Plans"]');

    expect(plans).not.toBeNull();
    if (!plans) return;
    fireEvent.click(plans);

    expect(useUIStore.getState().activeModule).toBe("registrar");
    expect(getByTestId("location").textContent).toBe("/registrar");
  });
});
