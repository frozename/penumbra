import "../setup";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { EmptyState } from "@src/ui/EmptyState";
import { Sparkline } from "@src/ui/Sparkline";
import { StatCard } from "@src/ui/StatCard";

afterEach(cleanup);

function polylinePoints(container: HTMLElement): string {
  const polyline = container.querySelector("polyline");
  expect(polyline).toBeTruthy();
  return polyline?.getAttribute("points") ?? "";
}

describe("Sparkline", () => {
  test("golden points for seed 1 and 3 points", () => {
    const { container } = render(<Sparkline seed={1} points={3} />);
    expect(polylinePoints(container)).toBe("0.00,49.81 50.00,35.19 100.00,46.76");
  });

  test("seed changes the generated geometry", () => {
    const { container, unmount } = render(<Sparkline seed={2} points={3} />);
    const seed2 = polylinePoints(container);
    expect(seed2).toBe("0.00,46.99 50.00,50.47 100.00,70.54");
    unmount();

    const { container: other } = render(<Sparkline seed={1} points={3} />);
    expect(seed2).not.toBe(polylinePoints(other));
  });

  test("same seed and points render identical geometry", () => {
    const { container: first, unmount } = render(<Sparkline seed={5} points={6} />);
    const once = polylinePoints(first);
    unmount();

    const { container: second } = render(<Sparkline seed={5} points={6} />);
    expect(polylinePoints(second)).toBe(once);
  });

  test("default points yield 28 pairs spanning x 0.00 to 100.00", () => {
    const { container } = render(<Sparkline seed={3} />);
    const pairs = polylinePoints(container).split(" ");
    expect(pairs.length).toBe(28);
    expect(pairs[0]?.split(",")[0]).toBe("0.00");
    expect(pairs[27]?.split(",")[0]).toBe("100.00");
  });

  test("area polygon closes the polyline between baseline corners", () => {
    const { container } = render(<Sparkline seed={4} points={5} />);
    const pts = polylinePoints(container);
    const polygon = container.querySelector("polygon");
    expect(polygon?.getAttribute("points")).toBe(`0,100 ${pts} 100,100`);
  });

  test("svg frame uses the spark class and non-uniform viewBox", () => {
    const { container } = render(<Sparkline seed={1} points={3} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("spark");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("none");
  });

  test("height defaults to 28px and is overridable", () => {
    const { container, unmount } = render(<Sparkline seed={1} points={3} />);
    const defaultStyle =
      container.querySelector("svg")?.style.height ??
      container.querySelector("svg")?.getAttribute("style") ??
      "";
    expect(defaultStyle).toContain("28px");
    unmount();

    const { container: other } = render(<Sparkline seed={1} points={3} height={40} />);
    const sizedStyle =
      other.querySelector("svg")?.style.height ??
      other.querySelector("svg")?.getAttribute("style") ??
      "";
    expect(sizedStyle).toContain("40px");
  });

  test("default paint is brand-colored with 0.18 fill opacity", () => {
    const { container } = render(<Sparkline seed={1} points={3} />);
    const polygon = container.querySelector("polygon");
    const polyline = container.querySelector("polyline");
    expect(polygon?.getAttribute("fill")).toBe("var(--color-brand)");
    expect(polyline?.getAttribute("stroke")).toBe("var(--color-brand)");
    expect(polygon?.getAttribute("opacity")).toBe("0.18");
    expect(polyline?.getAttribute("fill")).toBe("none");
    expect(polyline?.getAttribute("stroke-width")).toBe("1.4");
  });

  test("custom color and fillOpacity override polygon and polyline paint", () => {
    const { container } = render(<Sparkline seed={1} points={3} color="red" fillOpacity={0.5} />);
    const polygon = container.querySelector("polygon");
    const polyline = container.querySelector("polyline");
    expect(polygon?.getAttribute("fill")).toBe("red");
    expect(polyline?.getAttribute("stroke")).toBe("red");
    expect(polygon?.getAttribute("opacity")).toBe("0.5");
  });
});

describe("StatCard", () => {
  test("root element is a card stat with the label", () => {
    const { container } = render(<StatCard label="Lanes" value={1} delta="steady" />);
    const root = container.querySelector(".card");
    expect(root?.className).toBe("card stat");
    expect(container.querySelector(".lab")?.textContent).toBe("Lanes");
  });

  test("suffix renders inside an em in the value", () => {
    const { container } = render(<StatCard label="Lanes" value={3} suffix="/8" delta="+1" />);
    expect(container.querySelector(".val")?.textContent).toBe("3/8");
    expect(container.querySelector(".val em")?.textContent).toBe("/8");
  });

  test("suffix is omitted when absent or empty", () => {
    const { container, unmount } = render(<StatCard label="Lanes" value={7} delta="+1" />);
    expect(container.querySelector(".val em")).toBeNull();
    expect(container.querySelector(".val")?.textContent).toBe("7");
    unmount();

    const { container: other } = render(<StatCard label="Lanes" value={7} suffix="" delta="+1" />);
    expect(other.querySelector(".val em")).toBeNull();
    expect(other.querySelector(".val")?.textContent).toBe("7");
  });

  test("delta element class carries deltaCls only when provided", () => {
    const { container, unmount } = render(<StatCard label="Lanes" value={1} delta="+2 today" />);
    const plain = container.querySelector(".d");
    expect(plain?.className.trim()).toBe("d");
    expect(plain?.textContent).toBe("+2 today");
    unmount();

    const { container: other } = render(
      <StatCard label="Lanes" value={1} delta="+2 today" deltaCls="up" />,
    );
    expect(other.querySelector(".d")?.className).toBe("d up");
  });

  test("seed is forwarded to the embedded sparkline", () => {
    const { container: seeded, unmount } = render(
      <StatCard label="Lanes" value={1} delta="steady" seed={7} />,
    );
    const seededPoints = polylinePoints(seeded);
    unmount();

    const { container: standalone, unmount: unmountStandalone } = render(<Sparkline seed={7} />);
    expect(seededPoints).toBe(polylinePoints(standalone));
    unmountStandalone();

    const { container: unseeded, unmount: unmountUnseeded } = render(
      <StatCard label="Lanes" value={1} delta="steady" />,
    );
    const unseededPoints = polylinePoints(unseeded);
    unmountUnseeded();

    const { container: defaultSeed } = render(<Sparkline seed={1} />);
    expect(unseededPoints).toBe(polylinePoints(defaultSeed));
  });
});

describe("EmptyState", () => {
  test("default testid and class wrap the title", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    const root = container.querySelector('[data-testid="empty-state"]');
    expect(root?.getAttribute("class")).toBe("empty-state t-tertiary");
    const firstChild = root?.firstElementChild;
    expect(firstChild?.textContent).toBe("Nothing here");
  });

  test("custom testId replaces the default entirely", () => {
    const { container } = render(<EmptyState title="Nothing here" testId="lanes-empty" />);
    const root = container.querySelector('[data-testid="lanes-empty"]');
    expect(root).toBeTruthy();
    expect(container.querySelector('[data-testid="empty-state"]')).toBeNull();
  });

  test("body omitted leaves a single child element", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    const root = container.querySelector('[data-testid="empty-state"]');
    expect(root?.children.length).toBe(1);
  });

  test("body renders as a second mono child", () => {
    const { container } = render(<EmptyState title="Nothing here" body="try later" />);
    const root = container.querySelector('[data-testid="empty-state"]');
    expect(root?.children.length).toBe(2);
    const body = root?.children[1];
    expect(body?.getAttribute("class")).toBe("mono");
    expect(body?.textContent).toBe("try later");
  });
});
