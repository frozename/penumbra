import { describe, expect, test } from "bun:test";

import { normalizePressureSnapshot } from "@src/hooks/usePressureSnapshot";

describe("usePressureSnapshot", () => {
  test("loads windows and computes peak usage", () => {
    const result = normalizePressureSnapshot({
      windows: [
        {
          used_pct: 0.5,
          refuse_pct: 0.95,
          warn_pct: 0.8,
          provider: "openai",
          model: "gpt-5",
          window_label: "5m",
        },
        {
          used_pct: 0.7,
          refuse_pct: 0.95,
          warn_pct: 0.8,
          provider: "openai",
          model: "gpt-5",
          window_label: "1h",
        },
      ],
    });

    expect(result.windows).toHaveLength(2);
    expect(result.peakUsedPct).toBe(0.7);
  });

  test("handles empty windows", () => {
    const result = normalizePressureSnapshot({ windows: [] });
    expect(result.windows).toHaveLength(0);
    expect(result.peakUsedPct).toBe(0);
  });

  test("handles missing windows field", () => {
    const result = normalizePressureSnapshot({});
    expect(result.windows).toHaveLength(0);
    expect(result.peakUsedPct).toBe(0);
  });

  test("filters malformed windows", () => {
    const result = normalizePressureSnapshot({
      windows: [
        {
          used_pct: "0.5",
          refuse_pct: 0.95,
          warn_pct: 0.8,
          provider: "openai",
          model: "gpt-5",
          window_label: "5m",
        },
      ],
    });

    expect(result.windows).toHaveLength(0);
    expect(result.peakUsedPct).toBe(0);
  });
});
