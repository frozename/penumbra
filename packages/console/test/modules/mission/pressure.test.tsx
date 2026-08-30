import "../../setup";
import { describe, expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import { PressureGrid } from "@src/modules/mission/PressureGrid";

describe("PressureGrid", () => {
  test("renders first four orbs and collapses overflow", () => {
    mock.module("@src/hooks/usePressureSnapshot", () => ({
      usePressureSnapshot: () => ({
        windows: [
          {
            used_pct: 0.1,
            refuse_pct: 0.95,
            warn_pct: 0.8,
            provider: "openai",
            model: "gpt-5",
            window_label: "a",
          },
          {
            used_pct: 0.2,
            refuse_pct: 0.95,
            warn_pct: 0.8,
            provider: "openai",
            model: "gpt-5",
            window_label: "b",
          },
          {
            used_pct: 0.3,
            refuse_pct: 0.95,
            warn_pct: 0.8,
            provider: "openai",
            model: "gpt-5",
            window_label: "c",
          },
          {
            used_pct: 0.4,
            refuse_pct: 0.95,
            warn_pct: 0.8,
            provider: "openai",
            model: "gpt-5",
            window_label: "d",
          },
          {
            used_pct: 0.5,
            refuse_pct: 0.95,
            warn_pct: 0.8,
            provider: "openai",
            model: "gpt-5",
            window_label: "e",
          },
        ],
        peakUsedPct: 0.5,
        isLoading: false,
      }),
    }));

    const { container } = render(<PressureGrid />);

    expect(container.querySelectorAll(".orb")).toHaveLength(5);
    expect(container.querySelectorAll(".orb-grid").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("1 more");
  });

  test("renders empty state when no windows exist", () => {
    mock.module("@src/hooks/usePressureSnapshot", () => ({
      usePressureSnapshot: () => ({ windows: [], peakUsedPct: 0, isLoading: false }),
    }));

    const { container } = render(<PressureGrid />);
    // Query the render container (bound at call time) rather than `screen`,
    // whose document.body binding is captured at module-eval time and is
    // undefined when the suite runs from the repo root before happy-dom
    // registers — see the note in test/ui/atoms.test.tsx.
    expect(within(container).getByText("No pressure data available.")).toBeTruthy();
  });

  test("renders card head title", () => {
    mock.module("@src/hooks/usePressureSnapshot", () => ({
      usePressureSnapshot: () => ({ windows: [], peakUsedPct: 0, isLoading: false }),
    }));

    const { container } = render(<PressureGrid />);
    expect(container.querySelector("h3")?.textContent).toContain("Pressure");
  });
});
