import "../setup";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { PressureOrb, providerLabel, type PressureWindowSnapshot } from "@src/ui/PressureOrb";
import { EventTypeChip } from "@src/ui/EventTypeChip";
const C = 2 * Math.PI * 18;

describe("PressureOrb", () => {
  const base = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    window_label: "5h",
    warn_pct: 0.8,
    refuse_pct: 0.95,
  };

  function renderOrb(used: number) {
    const p: PressureWindowSnapshot = { ...base, used_pct: used };
    return render(<PressureOrb p={p} />);
  }

  test("ok state below warn threshold", () => {
    const { container } = renderOrb(0);
    const root = container.querySelector(".orb")!;
    expect(root.className).toBe("orb ok");
    expect(container.querySelector("text")!.textContent).toBe("0");
  });

  test("ok state strictly below warn (0.5)", () => {
    const { container } = renderOrb(0.5);
    expect(container.querySelector(".orb")!.className).toBe("orb ok");
    expect(container.querySelector("text")!.textContent).toBe("50");
  });

  test("warn state at/above warn threshold but below refuse", () => {
    const { container } = renderOrb(0.85);
    expect(container.querySelector(".orb")!.className).toBe("orb warn");
    expect(container.querySelector("text")!.textContent).toBe("85");
  });

  test("crit state at/above refuse threshold", () => {
    const { container } = renderOrb(0.96);
    expect(container.querySelector(".orb")!.className).toBe("orb crit");
    expect(container.querySelector("text")!.textContent).toBe("96");
  });

  test("used arc strokeDashoffset == C * (1 - used_pct)", () => {
    const { container } = renderOrb(0.42);
    const circles = container.querySelectorAll("circle");
    // Layout: track (0), warn marker (1), refuse marker (2), used arc (3)
    const usedArc = circles[3]!;
    const offsetAttr = usedArc.getAttribute("stroke-dashoffset");
    expect(offsetAttr).not.toBeNull();
    const offset = Number.parseFloat(offsetAttr!);
    expect(offset).toBeCloseTo(C * (1 - 0.42), 4);
  });

  test("providerLabel maps known providers and passes through unknown", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("google")).toBe("Google");
    expect(providerLabel("opencode-go")).toBe("OpenCode-Go");
    expect(providerLabel("mystery-vendor")).toBe("mystery-vendor");
  });
});

describe("EventTypeChip", () => {
  test("known type → mapped label (agent-prompt → '→prompt')", () => {
    const { container } = render(<EventTypeChip type="agent-prompt" />);
    expect(container.querySelector("span")!.textContent).toBe("→prompt");
  });

  test("known type → mapped label (usage-update → 'usage')", () => {
    const { container } = render(<EventTypeChip type="usage-update" />);
    expect(container.querySelector("span")!.textContent).toBe("usage");
  });

  test("known type → mapped label (rate-limit-snapshot → 'limit')", () => {
    const { container } = render(<EventTypeChip type="rate-limit-snapshot" />);
    expect(container.querySelector("span")!.textContent).toBe("limit");
  });

  test("unknown type renders verbatim", () => {
    const { container } = render(<EventTypeChip type="foo-bar" />);
    expect(container.querySelector("span")!.textContent).toBe("foo-bar");
  });
});
