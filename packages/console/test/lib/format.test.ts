import { describe, expect, test } from "bun:test";
import { fmtDur } from "../../src/lib/format";

describe("fmtDur", () => {
  test("formats minute and hour durations", () => {
    expect(fmtDur(0)).toBe("0m");
    expect(fmtDur(60)).toBe("1m");
    expect(fmtDur(3600)).toBe("1h");
    expect(fmtDur(14400)).toBe("4h 0m");
    expect(fmtDur(14460)).toBe("4h 1m");
  });
});
