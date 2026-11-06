import { describe, expect, test } from "bun:test";

import { hasNonWhitespaceCharacter, nonBlankStringSchema } from "@src/schemas/non-blank.js";

describe("hasNonWhitespaceCharacter", () => {
  test("true for a regular character", () => {
    expect(hasNonWhitespaceCharacter("a")).toBe(true);
  });

  test("false for the empty string", () => {
    expect(hasNonWhitespaceCharacter("")).toBe(false);
  });

  test("false for whitespace only", () => {
    expect(hasNonWhitespaceCharacter(" \t\n")).toBe(false);
  });

  test("false for zero-width characters only", () => {
    expect(hasNonWhitespaceCharacter("\u200B\u200C\u200D\u2060\uFEFF")).toBe(false);
  });

  test("false for a Unicode space separator", () => {
    expect(hasNonWhitespaceCharacter(" \u3000")).toBe(false);
  });

  test("true when a real character follows a zero-width character", () => {
    expect(hasNonWhitespaceCharacter("\u200Bx")).toBe(true);
  });
});

describe("nonBlankStringSchema", () => {
  test("trims outer whitespace and keeps inner whitespace", () => {
    expect(nonBlankStringSchema("name").parse("  hi there  ")).toBe("hi there");
  });

  test("rejects a whitespace-only string with the field name in the message", () => {
    const result = nonBlankStringSchema("name").safeParse("   ");
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]?.message).toBe("name must contain a non-whitespace character");
  });

  test("interpolates the fieldName argument into the message", () => {
    const result = nonBlankStringSchema("description").safeParse("   ");
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]?.message).toBe(
      "description must contain a non-whitespace character",
    );
  });

  test("rejects a zero-width string via the refine, not trim", () => {
    const result = nonBlankStringSchema("name").safeParse("\u200B");
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues[0]?.message).toBe("name must contain a non-whitespace character");
  });

  test("rejects a non-string input", () => {
    const result = nonBlankStringSchema("name").safeParse(42);
    expect(result.success).toBe(false);
  });
});
