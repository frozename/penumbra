import "../setup";

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter } from "react-router-dom";

import { type ModuleSpec } from "@src/modules/manifest";
import { EntityLink } from "@src/ui/EntityLink";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function setClipboard(value: Pick<Clipboard, "writeText"> | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  cleanup();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    delete (navigator as unknown as { clipboard?: Clipboard }).clipboard;
  }
});

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
    expect(anchor?.className).toBe("entity-link entity-link-linked");
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
    expect(container.firstElementChild?.className).toBe("entity-link entity-link-unlinked");
    expect(container.querySelector("code")?.textContent).toBe("t-1");
    expect(within(container).getByLabelText("Copy task id t-1")).toBeTruthy();
  });

  test("a conversation id links to /chains/c-1 only when chains is available", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <EntityLink kind="conversation" id="c-1" modules={[chainsUnavailable]} />
      </MemoryRouter>,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("c-1");
    expect(within(container).getByLabelText("Copy conversation id c-1")).toBeTruthy();

    rerender(
      <MemoryRouter>
        <EntityLink kind="conversation" id="c-1" modules={[chainsAvailable]} />
      </MemoryRouter>,
    );

    const anchor = container.querySelector("a");

    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("/chains/c-1");
    expect(anchor?.className).toBe("entity-link entity-link-linked");
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
    expect(within(container).getByLabelText("Copy lane id l-1")).toBeTruthy();
  });

  test("copy writes the full unlinked id to the clipboard", () => {
    const writeText = mock(async (_value: string) => undefined);
    setClipboard({ writeText });
    const { container } = render(
      <MemoryRouter>
        <EntityLink kind="task" id="task-1234567890abcdef" />
      </MemoryRouter>,
    );

    fireEvent.click(within(container).getByLabelText("Copy task id task-1234567890abcdef"));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("task-1234567890abcdef");
  });

  test("copy is a no-op when no clipboard is available", () => {
    setClipboard(undefined);
    const { container } = render(
      <MemoryRouter>
        <EntityLink kind="lane" id="l-clipboardless" />
      </MemoryRouter>,
    );
    const copyButton = within(container).getByLabelText("Copy lane id l-clipboardless");

    expect(() => fireEvent.click(copyButton)).not.toThrow();
  });

  test("an unlinked conversation renders no anchor element", () => {
    const { container } = render(
      <MemoryRouter>
        <EntityLink kind="conversation" id="c-unlinked" modules={[chainsUnavailable]} />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});
