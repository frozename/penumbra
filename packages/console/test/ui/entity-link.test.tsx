import "../setup";

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { type ModuleSpec } from "@src/modules/manifest";
import { EntityLink } from "@src/ui/EntityLink";

afterEach(cleanup);

const handoffsModule = {
  available: true,
  icon: "h",
  id: "handoffs",
  label: "Handoffs",
  path: "/handoffs",
} as const satisfies ModuleSpec;

const chainsAvailable = {
  available: true,
  icon: "≋",
  id: "chains",
  label: "Chains",
  path: "/chains",
} as const satisfies ModuleSpec;

const chainsUnavailable = {
  available: false,
  icon: "≋",
  id: "chains",
  label: "Chains",
  path: "/chains",
} as const satisfies ModuleSpec;

describe("EntityLink", () => {
  test("a handoff id renders an anchor to /handoffs/h-1 when the passed manifest marks handoffs available", () => {
    const { container } = render(
      <MemoryRouter>
        <EntityLink kind="handoff" id="h-1" modules={[handoffsModule]} />
      </MemoryRouter>,
    );

    const anchor = container.querySelector("a");

    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("/handoffs/h-1");
    expect(anchor?.textContent).toBe("h-1");
    expect(container.querySelector("code")?.textContent).toBe("h-1");
    expect(container.querySelector("button")).toBeNull();
  });

  test("a task id renders <code> with copy and NO anchor while tasks is available:false", () => {
    const { container } = render(
      <MemoryRouter>
        <EntityLink kind="task" id="t-1" />
      </MemoryRouter>,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("t-1");
    expect(within(container).getByLabelText("Copy id")).toBeTruthy();
  });

  test("a conversation id links to /chains/c-1 only when chains is available", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <EntityLink kind="conversation" id="c-1" modules={[chainsUnavailable]} />
      </MemoryRouter>,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("c-1");
    expect(within(container).getByLabelText("Copy id")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <EntityLink kind="conversation" id="c-1" modules={[chainsAvailable]} />
      </MemoryRouter>,
    );

    const anchor = container.querySelector("a");

    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("/chains/c-1");
    expect(anchor?.textContent).toBe("c-1");
  });

  test("a lane id renders <code> with copy and no anchor (no lane route exists)", () => {
    const { container } = render(
      <MemoryRouter>
        <EntityLink kind="lane" id="l-1" />
      </MemoryRouter>,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("l-1");
    expect(within(container).getByLabelText("Copy id")).toBeTruthy();
  });
});
