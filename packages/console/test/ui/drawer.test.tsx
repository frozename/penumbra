import "../setup";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode, useState } from "react";

import { Drawer } from "@src/ui/Drawer";
import { Field } from "@src/ui/Field";

afterEach(cleanup);

function TestDrawer({
  children,
  onClose,
  open: initialOpen = false,
}: {
  children?: ReactNode;
  onClose: () => void;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div>
      <button
        data-testid="opener"
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        Open
      </button>
      <Drawer
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="Details"
      >
        {children ?? <input data-testid="drawer-input" />}
      </Drawer>
    </div>
  );
}

describe("Drawer", () => {
  test("Esc closes and returns focus to the opener", () => {
    const onClose = mock(() => {});
    const { getByTestId } = render(<TestDrawer onClose={onClose} />);
    const opener = getByTestId("opener") as HTMLButtonElement;

    opener.focus();
    fireEvent.click(opener);

    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("opener");
  });

  test("focus wraps inside the drawer", () => {
    const onClose = mock(() => {});
    const { getByTestId, getByRole } = render(
      <Drawer open onClose={onClose} title="Details">
        <input data-testid="input-a" />
        <button data-testid="input-b" type="button">
          B
        </button>
      </Drawer>,
    );

    const closeButton = getByRole("button", { name: "Close" });
    const inputA = getByTestId("input-a") as HTMLInputElement;
    const inputB = getByTestId("input-b") as HTMLButtonElement;

    closeButton.focus();
    fireEvent.keyDown(closeButton, { key: "Tab" });
    expect(document.activeElement).toBe(inputA);

    fireEvent.keyDown(inputA, { key: "Tab" });
    expect(document.activeElement).toBe(inputB);

    fireEvent.keyDown(inputB, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inputB);

    fireEvent.keyDown(inputB, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(inputA);

    fireEvent.keyDown(inputA, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(closeButton);
  });

  test("closing restores focus and removes listeners", () => {
    const onClose = mock(() => {});
    const { getByRole, getByTestId } = render(<TestDrawer onClose={onClose} />);
    const opener = getByTestId("opener") as HTMLButtonElement;

    opener.focus();
    fireEvent.click(opener);

    const input = getByTestId("drawer-input") as HTMLInputElement;
    const closeButton = getByRole("button", { name: "Close" });

    input.focus();
    fireEvent.keyDown(closeButton, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("opener");

    fireEvent.keyDown(opener, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("redirects outside focus and preserves the opener across callback changes", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const firstClose = mock(() => {});
    const nextClose = mock(() => {});
    try {
      const { getByRole, rerender, unmount } = render(
        <Drawer open onClose={firstClose} title="Details">
          Content
        </Drawer>,
      );
      const close = getByRole("button", { name: "Close" });
      opener.focus();
      expect(document.activeElement === close).toBe(true);
      rerender(
        <Drawer open onClose={nextClose} title="Updated">
          Content
        </Drawer>,
      );
      fireEvent.keyDown(close, { key: "Escape" });
      expect(firstClose).not.toHaveBeenCalled();
      expect(nextClose).toHaveBeenCalledTimes(1);
      unmount();
      expect(document.activeElement).toBe(opener);
      fireEvent.keyDown(opener, { key: "Escape" });
      expect(nextClose).toHaveBeenCalledTimes(1);
    } finally {
      opener.remove();
    }
  });

  test("skips hidden and disabled controls while trapping focus", () => {
    const { getByRole } = render(
      <Drawer open onClose={() => {}} title="Details">
        <button type="button" style={{ visibility: "hidden" }}>
          Hidden
        </button>
        <fieldset disabled>
          <button type="button">Disabled</button>
        </fieldset>
        <button type="button">Last</button>
      </Drawer>,
    );
    const close = getByRole("button", { name: "Close" });
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement?.textContent).toBe("Last");
  });
});

describe("Field", () => {
  test("Field renders label, error text and aria-describedby", () => {
    const { getByLabelText, getByText } = render(
      <Field label="Name" htmlFor="name" error="Required">
        <input />
      </Field>,
    );

    const input = getByLabelText("Name") as HTMLInputElement;
    expect(input.id).toBe("name");
    expect(input.getAttribute("aria-describedby")).toBe("name-error");

    const error = getByText("Required") as HTMLParagraphElement;
    expect(error.id).toBe("name-error");
    expect(error.getAttribute("role")).toBe("alert");
  });

  test("Field preserves and removes existing description IDs", () => {
    const { getByLabelText, queryByText, rerender } = render(
      <Field label="Name" htmlFor="name" error="Required">
        <input aria-describedby="hint" />
      </Field>,
    );

    expect(getByLabelText("Name").getAttribute("aria-describedby")).toBe("hint name-error");

    rerender(
      <Field label="Name" htmlFor="name">
        <input aria-describedby="hint" />
      </Field>,
    );

    expect(getByLabelText("Name").getAttribute("aria-describedby")).toBe("hint");
    expect(queryByText("Required")).toBeNull();
  });
});
