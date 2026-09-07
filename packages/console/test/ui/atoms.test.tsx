import "../setup";
import { render, within } from "@testing-library/react";
import { describe, expect, test } from "bun:test";

import { Badge } from "@src/ui/Badge";
import { Button } from "@src/ui/Button";
import { Card, CardHead } from "@src/ui/Card";
import { StatusBadge } from "@src/ui/StatusBadge";

describe("Badge", () => {
  test("renders all variants with default info", () => {
    const variants = ["ok", "warn", "err", "info", "brand", "muted"] as const;

    for (const variant of variants) {
      const { container, unmount } = render(<Badge variant={variant}>{variant}</Badge>);
      const badge = container.querySelector(".badge");

      expect(badge?.className).toBe(`badge badge-${variant}`);
      expect(badge?.textContent).toBe(variant);
      unmount();
    }

    const { container } = render(<Badge>default</Badge>);
    expect(container.querySelector(".badge")?.className).toBe("badge badge-info");
    // `within(container)` binds the query at call time. `screen` from
    // @testing-library/dom captures document.body at module-eval time, which
    // is undefined before happy-dom registers when the suite runs from the
    // repo root (root bunfig preloads a non-DOM setup), permanently poisoning
    // every `screen.*` into a throwing stub. Querying the render container
    // sidesteps that ordering trap.
    expect(within(container).getByText("default")).toBeTruthy();
  });
});

describe("Button", () => {
  test("renders all variants, defaults, and forwards native props", () => {
    const variants = ["primary", "secondary", "ghost", "danger", "ok"] as const;

    for (const variant of variants) {
      const { container, unmount } = render(<Button variant={variant}>go</Button>);
      const button = container.querySelector("button");

      expect(button?.className).toBe(`btn btn-${variant}`);
      unmount();
    }

    let clicked = 0;
    const { container } = render(
      <Button
        aria-label="Approve"
        className="extra"
        disabled
        onClick={() => {
          clicked += 1;
        }}
      >
        Save
      </Button>,
    );
    const button = container.querySelector("button");

    expect(button?.className).toBe("btn btn-secondary extra");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.getAttribute("aria-label")).toBe("Approve");
    expect(button?.disabled).toBe(true);

    button?.click();
    expect(clicked).toBe(0);
  });
});

describe("Card", () => {
  test("renders root card with appended className", () => {
    const { container } = render(<Card className="card-mini">hello</Card>);
    expect(container.firstElementChild?.className).toBe("card card-mini");
  });

  test("CardHead renders title id dot and actions", () => {
    const { container } = render(
      <CardHead actions={<button type="button">x</button>} dot="dot-ok" id="HF-12" title="Inbox" />,
    );

    expect(container.querySelector("h3")?.textContent).toContain("Inbox");
    expect(container.querySelector(".id")?.textContent).toBe("HF-12");
    expect(container.querySelector(".card-head .dot")?.className).toBe("dot dot-ok");
    expect(container.querySelector(".card-head-actions button")?.textContent).toBe("x");
  });
});

describe("StatusBadge", () => {
  test("renders known statuses with the expected styling and label", () => {
    const cases = [
      ["in-progress", "badge-info", "dot-brand dot-live", "in-progress"],
      ["claimed", "badge-info", "dot-brand", "claimed"],
      ["completed", "badge-ok", "dot-ok", "completed"],
      ["failed", "badge-err", "dot-err", "failed"],
      ["rejected", "badge-err", "dot-err", "rejected"],
      ["filed", "badge-warn", "dot-warn", "filed"],
      ["ok", "badge-ok", "dot-ok", "ok"],
      ["concerns", "badge-warn", "dot-warn", "concerns"],
    ] as const;

    for (const [status, cls, dot, label] of cases) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      const badge = container.querySelector(".badge");

      expect(badge?.className).toContain(cls);
      expect(container.querySelector(".dot")?.className).toBe(`dot ${dot}`);
      expect(badge?.textContent).toContain(label);
      unmount();
    }
  });

  test("falls back to filed for unknown status and respects monoLabel", () => {
    const { container, rerender } = render(<StatusBadge status="mystery" />);
    expect(container.querySelector(".badge")?.className).toContain("badge-warn");
    expect(container.querySelector(".dot")?.className).toBe("dot dot-warn");
    expect(container.querySelector(".badge")?.textContent).toContain("filed");

    rerender(<StatusBadge monoLabel="HF-12" status="completed" />);
    expect(container.querySelector(".badge")?.textContent).toContain("HF-12");
  });
});
