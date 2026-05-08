import { describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { Titlebar } from "../../src/shell/Titlebar";

mock.module("../../src/hooks/usePressureSnapshot", () => ({
  usePressureSnapshot: () => ({
    windows: [],
    peakUsedPct: 0.9,
    isLoading: false,
  }),
}));

describe("Titlebar pressure pip", () => {
  test("shows warn band and percent text", () => {
    const { container } = render(<Titlebar />);
    const pip = container.querySelector(".pressure-pip");

    expect(pip?.className).toContain("pressure-pip-warn");
    expect(pip?.textContent).toContain("90%");
  });
});
