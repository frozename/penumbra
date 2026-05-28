import { describe, expect, it } from "bun:test";
import {
  parseLines,
  summarize,
  type InvocationSummaryInputRow,
} from "../src/invocation-summary.js";

const ROWS: InvocationSummaryInputRow[] = [
  {
    ts: "2026-01-01T00:00:01Z",
    tool: "tool_a",
    origin: "cc",
    args_bytes: 10,
    result_bytes: 100,
    duration_ms: 50,
    ok: true,
    error_kind: null,
  },
  {
    ts: "2026-01-01T00:00:02Z",
    tool: "tool_a",
    origin: "cc",
    args_bytes: 20,
    result_bytes: 200,
    duration_ms: 150,
    ok: true,
    error_kind: null,
  },
  {
    ts: "2026-01-01T00:00:03Z",
    tool: "tool_b",
    origin: "api",
    args_bytes: 5,
    result_bytes: 0,
    duration_ms: 10,
    ok: false,
    error_kind: "TimeoutError",
  },
];

describe("invocation-summary", () => {
  it("counts calls and errors per tool", () => {
    const summary = summarize(ROWS);
    expect(summary.get("tool_a")!.calls).toBe(2);
    expect(summary.get("tool_b")!.errors).toBe(1);
  });

  it("computes p50/p95 result_bytes", () => {
    const summary = summarize(ROWS);
    expect(summary.get("tool_a")!.p50_bytes_out).toBeGreaterThan(0);
    expect(summary.get("tool_a")!.p95_bytes_out).toBeGreaterThanOrEqual(
      summary.get("tool_a")!.p50_bytes_out,
    );
  });

  it("skips malformed JSONL lines", () => {
    expect(parseLines(["{not json", JSON.stringify(ROWS[0])])).toHaveLength(1);
  });

  it("tracks first_error and origins set", () => {
    const summary = summarize([
      ...ROWS,
      {
        ts: "2026-01-01T00:00:04Z",
        tool: "tool_b",
        origin: "cli",
        args_bytes: 7,
        result_bytes: 10,
        duration_ms: 5,
        ok: false,
        error_kind: "RateLimitError",
      },
    ]);
    const toolB = summary.get("tool_b")!;
    expect(toolB.first_error).toBe("TimeoutError");
    expect([...toolB.origins].sort()).toEqual(["api", "cli"]);
  });
});
