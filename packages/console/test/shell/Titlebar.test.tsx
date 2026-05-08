import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
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

  test("renders reload and docs buttons", () => {
    const { container } = render(<Titlebar />);

    expect(container.querySelectorAll("button.iconbtn")).toHaveLength(2);
    expect(container.querySelector('button[title="reload config"]')).not.toBeNull();
    expect(container.querySelector('button[title="docs"]')).not.toBeNull();
  });
});
