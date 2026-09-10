import "../setup";

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { type TabItem, Tabs } from "@src/ui/Tabs";

afterEach(() => {
  cleanup();
});

describe("Tabs", () => {
  test("Tabs renders one button role=tab per item, aria-selected only on activeId, and onSelect fires with the clicked item id", () => {
    const items: readonly TabItem[] = [
      { id: "pending", label: "Pending" },
      { id: "dispatched", label: "Dispatched" },
      { id: "completed", label: "Completed" },
      { id: "failed", label: "Failed" },
    ];
    const activeId = "dispatched";
    const selected: string[] = [];
    const onSelect = (id: string): void => {
      selected.push(id);
    };

    const { container } = render(<Tabs items={items} activeId={activeId} onSelect={onSelect} />);

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();

    const buttons = within(container).getAllByRole("tab");
    expect(buttons).toHaveLength(4);

    for (const btn of buttons) {
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.getAttribute("type")).toBe("button");
    }

    const ariaSelected = buttons.map((b) => b.getAttribute("aria-selected"));
    expect(ariaSelected).toEqual(["false", "true", "false", "false"]);

    const labels = buttons.map((b) => b.textContent ?? "");
    expect(labels).toEqual(["Pending", "Dispatched", "Completed", "Failed"]);
    expect(labels).not.toContain("0");
    expect(labels).not.toContain("1");

    const nonActive = buttons.find((b) => b.getAttribute("aria-selected") === "false")!;
    fireEvent.click(nonActive);
    expect(selected).toEqual(["pending"]);
  });
});
