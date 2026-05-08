import "../setup";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { MODULES } from "../../src/modules/manifest";
import { Rail } from "../../src/shell/Rail";
import { useUIStore } from "../../src/stores/ui-store";

beforeEach(() => {
  useUIStore.setState({
    activeModule: "mission",
    explorerCollapsed: false,
  });
  localStorage.clear();
});

describe("Rail", () => {
  test("renders rail buttons and settings", () => {
    const { getByTitle, getByText } = render(
      <Rail activeModule="mission" onSelect={mock(() => {})} />,
    );

    for (const module of MODULES) {
      expect(getByTitle(module.label)).toBeTruthy();
      expect(getByText(module.icon)).toBeTruthy();
    }
    expect(getByTitle("settings")).toBeTruthy();
    expect(getByText("⚙")).toBeTruthy();
  });

  test("marks the active module", () => {
    const { container, rerender } = render(
      <Rail activeModule="mission" onSelect={mock(() => {})} />,
    );

    const getButton = (title: string) =>
      container.querySelector(`button[title="${title}"]`) as HTMLButtonElement | null;

    expect(getButton("Mission control")?.className).toContain("active");
    expect(getButton("Chains")?.className).not.toContain("active");

    rerender(<Rail activeModule="chains" onSelect={mock(() => {})} />);

    expect(getButton("Chains")?.className).toContain("active");
    expect(getButton("Mission control")?.className).not.toContain("active");
  });

  test("calls onSelect when provided", () => {
    const onSelect = mock(() => {});
    const { container } = render(
      <Rail activeModule="mission" onSelect={onSelect} />,
    );
    const chains = container.querySelector(
      'button[title="Chains"]',
    ) as HTMLButtonElement | null;

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

    const { container, getByTestId } = render(
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
      </MemoryRouter>,
    );
    const chains = container.querySelector(
      'button[title="Chains"]',
    ) as HTMLButtonElement | null;

    expect(chains).not.toBeNull();
    if (!chains) return;
    fireEvent.click(chains);

    expect(useUIStore.getState().activeModule).toBe("chains");
    expect(getByTestId("location").textContent).toBe("/chains");
  });
});
