import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { Titlebar } from "../../src/shell/Titlebar";

describe("Titlebar", () => {
  test("renders traffic lights, orb, brand, and version", () => {
    const { container } = render(<Titlebar />);
    const brand = container.querySelector(".brand");

    expect(container.querySelector(".traffic > span")).not.toBeNull();
    expect(container.querySelectorAll(".traffic > span")).toHaveLength(3);
    expect(container.querySelector(".penorb")).not.toBeNull();
    expect(brand).not.toBeNull();
    expect(brand?.textContent).toContain("penumbra");
    expect(brand?.textContent).toContain("v0.8.2");
  });

  test("renders custom project, view, and version values", () => {
    render(
      <Titlebar projectName="repo-x" viewName="Mission" version="v9.9.9" />,
    );

    expect(screen.getByText("repo-x")).toBeTruthy();
    expect(screen.getByText("Mission")).toBeTruthy();
    expect(screen.getByText("v9.9.9")).toBeTruthy();
  });

  test("clicking the center section fires onJump", () => {
    const onJump = mock(() => {});
    const { container } = render(<Titlebar onJump={onJump} />);
    const center = container.querySelector(".tb-c");

    expect(center).not.toBeNull();
    if (!center) {
      return;
    }

    fireEvent.click(center);
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  test("reload and docs buttons fire their handlers", () => {
    const onReload = mock(() => {});
    const onDocs = mock(() => {});
    const { container } = render(
      <Titlebar onReload={onReload} onDocs={onDocs} />,
    );

    const buttons = container.querySelectorAll("button.iconbtn");
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onDocs).toHaveBeenCalledTimes(1);
  });

  test("Enter on the center section fires onJump", () => {
    const onJump = mock(() => {});
    const { container } = render(<Titlebar onJump={onJump} />);
    const center = container.querySelector(".tb-c") as HTMLElement | null;

    expect(center).not.toBeNull();
    if (!center) {
      return;
    }

    center.focus();
    fireEvent.keyDown(center, { key: "Enter" });

    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
