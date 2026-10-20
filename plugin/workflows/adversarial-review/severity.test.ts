import { describe, expect, test } from "bun:test";

import { countPersonaSeverity, summarizeSeverityMetrics } from "./severity.js";

describe("countPersonaSeverity", () => {
  test("counts high, medium and low; ignores info", () => {
    const counts = countPersonaSeverity([
      { severity: "high" },
      { severity: "medium" },
      { severity: "low" },
      { severity: "info" },
    ]);
    expect(counts).toEqual({ high: 1, medium: 1, low: 1, unparsed: false });
  });

  test("normalizes severity case", () => {
    const counts = countPersonaSeverity([
      { severity: "HIGH" },
      { severity: "Medium" },
      { severity: "  LOW  " },
      { severity: "Info" },
    ]);
    expect(counts).toEqual({ high: 1, medium: 1, low: 1, unparsed: false });
  });

  test("empty array is a valid zero parse", () => {
    expect(countPersonaSeverity([])).toEqual({
      high: 0,
      medium: 0,
      low: 0,
      unparsed: false,
    });
  });

  test("null, missing or non-array findings are unparsed", () => {
    expect(countPersonaSeverity(null)).toEqual({
      high: 0,
      medium: 0,
      low: 0,
      unparsed: true,
    });
    expect(countPersonaSeverity(undefined)).toEqual({
      high: 0,
      medium: 0,
      low: 0,
      unparsed: true,
    });
    expect(countPersonaSeverity({} as unknown[])).toEqual({
      high: 0,
      medium: 0,
      low: 0,
      unparsed: true,
    });
  });

  test("unknown severities such as critical mark the persona unparsed", () => {
    const counts = countPersonaSeverity([{ severity: "critical" }]);
    expect(counts).toEqual({ high: 0, medium: 0, low: 0, unparsed: true });
  });

  test("malformed rows and missing severity mark the persona unparsed", () => {
    const counts = countPersonaSeverity([
      { severity: "high" },
      "not an object",
      { title: "missing severity" },
      { severity: 42 },
    ]);
    expect(counts).toEqual({ high: 1, medium: 0, low: 0, unparsed: true });
  });

  test("mixed invalid and valid findings still count the valid ones and mark unparsed once", () => {
    const counts = countPersonaSeverity([
      { severity: "high" },
      { severity: "unknown" },
      { severity: "low" },
      { severity: "nonsense" },
    ]);
    expect(counts).toEqual({ high: 1, medium: 0, low: 1, unparsed: true });
  });

  test("multiple invalid findings in one persona count as unparsed once", () => {
    const counts = countPersonaSeverity([null, { severity: "critical" }, 123]);
    expect(counts.unparsed).toBe(true);
    expect(counts.high).toBe(0);
    expect(counts.medium).toBe(0);
    expect(counts.low).toBe(0);
  });
});

describe("summarizeSeverityMetrics", () => {
  test("aggregates counts and unparsed personas across the pool", () => {
    const metrics = summarizeSeverityMetrics([
      { findings: [{ severity: "high" }, { severity: "low" }] },
      { findings: [{ severity: "medium" }, { severity: "info" }] },
      { findings: null },
      { findings: [{ severity: "high" }, { severity: "critical" }] },
    ]);
    expect(metrics).toEqual({
      high_count: 2,
      medium_count: 1,
      low_count: 1,
      severity_unparsed_personas: 2,
    });
  });
});
