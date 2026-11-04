import { describe, expect, test } from "bun:test";

import {
  isRecord,
  numberFrom,
  parseJsonRecord,
  readNumber,
  readRecord,
  readString,
} from "@src/usage-readers/json-guards.js";

describe("isRecord", () => {
  test("accepts plain and empty objects", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  test("rejects null", () => {
    expect(isRecord(null)).toBe(false);
  });

  test("rejects arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1])).toBe(false);
  });

  test("rejects primitives", () => {
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("parseJsonRecord", () => {
  test("parses a JSON object", () => {
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
  });

  test("returns null for invalid JSON without throwing", () => {
    expect(parseJsonRecord("{not json")).toBeNull();
    expect(parseJsonRecord("")).toBeNull();
  });

  test("returns null for valid JSON that is not an object", () => {
    expect(parseJsonRecord("[1,2]")).toBeNull();
    expect(parseJsonRecord('"s"')).toBeNull();
    expect(parseJsonRecord("42")).toBeNull();
    expect(parseJsonRecord("null")).toBeNull();
  });
});

describe("readRecord", () => {
  test("returns a nested object value as the same reference", () => {
    const nested = { b: 2 };
    expect(readRecord({ nested }, "nested")).toBe(nested);
  });

  test("returns null for an array value", () => {
    expect(readRecord({ v: [1] }, "v")).toBeNull();
  });

  test("returns null for a string value", () => {
    expect(readRecord({ v: "s" }, "v")).toBeNull();
  });

  test("returns null for a missing key", () => {
    expect(readRecord({}, "missing")).toBeNull();
  });
});

describe("readString", () => {
  test("returns a string value, including the empty string", () => {
    expect(readString({ v: "hi" }, "v")).toBe("hi");
    expect(readString({ v: "" }, "v")).toBe("");
  });

  test("returns null for a number value", () => {
    expect(readString({ v: 1 }, "v")).toBeNull();
  });

  test("returns null for a null value", () => {
    expect(readString({ v: null }, "v")).toBeNull();
  });

  test("returns null for a missing key", () => {
    expect(readString({}, "missing")).toBeNull();
  });
});

describe("readNumber", () => {
  test("returns finite numbers unchanged", () => {
    expect(readNumber({ v: 0 }, "v")).toBe(0);
    expect(readNumber({ v: -3.5 }, "v")).toBe(-3.5);
  });

  test("returns null for non-finite numbers", () => {
    expect(readNumber({ v: NaN }, "v")).toBeNull();
    expect(readNumber({ v: Infinity }, "v")).toBeNull();
    expect(readNumber({ v: -Infinity }, "v")).toBeNull();
  });

  test("returns null for a numeric string (no coercion)", () => {
    expect(readNumber({ v: "5" }, "v")).toBeNull();
  });

  test("returns null for a missing key", () => {
    expect(readNumber({}, "missing")).toBeNull();
  });
});

describe("numberFrom", () => {
  test("returns a finite number unchanged", () => {
    expect(numberFrom(2.5)).toBe(2.5);
  });

  test("coerces numeric strings via Number", () => {
    expect(numberFrom("12")).toBe(12);
    expect(numberFrom(" 7 ")).toBe(7);
  });

  test("returns the default fallback for a non-numeric string", () => {
    expect(numberFrom("abc")).toBe(0);
    expect(numberFrom("abc", 9)).toBe(9);
  });

  test("returns the fallback for NaN and Infinity inputs", () => {
    expect(numberFrom(NaN, 9)).toBe(9);
    expect(numberFrom(Infinity, 9)).toBe(9);
  });

  test("returns the fallback for undefined", () => {
    expect(numberFrom(undefined, 9)).toBe(9);
  });

  test("returns 0 for null and empty string even with a fallback", () => {
    expect(numberFrom(null, 9)).toBe(0);
    expect(numberFrom("", 9)).toBe(0);
  });
});
