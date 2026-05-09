import { describe, expect, test } from "bun:test";
import { fmtDur, summarizeWords } from "../../src/lib/format";

describe("fmtDur", () => {
  test("formats minute and hour durations", () => {
    expect(fmtDur(0)).toBe("0m");
    expect(fmtDur(60)).toBe("1m");
    expect(fmtDur(3600)).toBe("1h");
    expect(fmtDur(14400)).toBe("4h 0m");
    expect(fmtDur(14460)).toBe("4h 1m");
  });
});

describe("summarizeWords", () => {
  test("returns the first n words with an ellipsis when truncated", () => {
    expect(summarizeWords("one two three four five six", 5)).toBe("one two three four five…");
  });

  test("returns the full string when it already fits", () => {
    expect(summarizeWords("one two three", 5)).toBe("one two three");
  });
});
