import "../setup";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MODULES } from "../../src/modules/manifest";
import { Rail } from "../../src/shell/Rail";
import { useUIStore } from "../../src/stores/ui-store";

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
  globalThis.fetch = originalFetch;
});

describe("Rail", () => {
  test("renders rail buttons and settings", () => {
    const { Wrapper } = makeWrapper();
    const { getByTitle, getByText } = render(
      <Wrapper>
        <Rail activeModule="mission" onSelect={mock(() => {})} />
      </Wrapper>,
    );

    for (const module of MODULES) {
      expect(getByTitle(module.label)).toBeTruthy();
      expect(getByText(module.icon)).toBeTruthy();
    }
    expect(getByTitle("settings")).toBeTruthy();
    expect(getByText("⚙")).toBeTruthy();
  });

  test("marks the active module", () => {
    const { Wrapper } = makeWrapper();
    const { container, rerender } = render(
      <Wrapper>
        <Rail activeModule="mission" onSelect={mock(() => {})} />
      </Wrapper>,
    );

    const getButton = (title: string) =>
      container.querySelector(`button[title="${title}"]`) as HTMLButtonElement | null;

    expect(getButton("Mission control")?.className).toContain("active");
    expect(getButton("Chains")?.className).not.toContain("active");

    rerender(
      <Wrapper>
        <Rail activeModule="chains" onSelect={mock(() => {})} />
      </Wrapper>,
    );

    expect(getButton("Chains")?.className).toContain("active");
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
    const chains = container.querySelector('button[title="Chains"]') as HTMLButtonElement | null;

    expect(chains).not.toBeNull();
    if (!chains) return;
    fireEvent.click(chains);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("chains");
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
    const chains = container.querySelector('button[title="Chains"]') as HTMLButtonElement | null;

    expect(chains).not.toBeNull();
    if (!chains) return;
    fireEvent.click(chains);

    expect(useUIStore.getState().activeModule).toBe("chains");
    expect(getByTestId("location").textContent).toBe("/chains");
  });
});
