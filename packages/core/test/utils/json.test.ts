import { describe, expect, test } from "bun:test";

import { safeParseJSON } from "../../src/utils/json.js";

describe("safeParseJSON", () => {
  test("parses valid JSON into the requested type", () => {
    expect(safeParseJSON<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(safeParseJSON<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });

  test("returns null for null/undefined input", () => {
    expect(safeParseJSON(null)).toBeNull();
    expect(safeParseJSON(undefined)).toBeNull();
  });

  test("returns null for malformed JSON instead of throwing", () => {
    expect(() => safeParseJSON("{not json")).not.toThrow();
    expect(safeParseJSON("{not json")).toBeNull();
    expect(safeParseJSON("")).toBeNull();
  });
});
