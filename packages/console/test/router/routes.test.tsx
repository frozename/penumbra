import "../setup";
import type { ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { MODULES, type ModuleSpec } from "@src/modules/manifest";
import { buildRoutes } from "@src/router";
import { useDaemonStore } from "@src/stores/daemon-store";
import { useUIStore } from "@src/stores/ui-store";

function makeWrapper(): ({ children }: { children: ReactNode }) => JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
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
  useDaemonStore.setState({
    baseUrl: "http://127.0.0.1:51257",
    token: "t",
    health: "unknown",
    lastHealthAt: null,
    bootError: null,
    sessionInvalid: false,
  });
  localStorage.clear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/handoffs")) {
      return new Response(JSON.stringify({ handoffs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("router", () => {
  test("buildRoutes([ghost]) renders NotFound for /ghost, not DeferredViewStub", () => {
    const router = createMemoryRouter(buildRoutes([...MODULES, ghost]), {
      initialEntries: ["/ghost"],
    });
    const Wrapper = makeWrapper();
    const { container } = render(
      <Wrapper>
        <RouterProvider router={router} />
      </Wrapper>,
    );

    expect(container.textContent ?? "").toContain("404 — no such view.");
    expect(container.textContent ?? "").not.toContain("wired in P1");
  });
});
