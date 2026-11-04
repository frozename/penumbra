import { describe, expect, test } from "bun:test";
import { z, ZodError } from "zod";

import { deepFreeze, formatZodIssue, loaderError } from "@src/files/_loader-util.js";

function parseError(schema: z.ZodType, input: unknown): ZodError {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error("expected safeParse to fail");
  }
  return result.error;
}

describe("deepFreeze", () => {
  test("returns the same reference it was given", () => {
    const obj = { a: 1 };
    expect(deepFreeze(obj)).toBe(obj);
  });

  test("recursively freezes nested objects and arrays", () => {
    const root: { a: { b: { c: number } }; list: { x: number }[] } = {
      a: { b: { c: 1 } },
      list: [{ x: 1 }],
    };
    deepFreeze(root);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.a)).toBe(true);
    expect(Object.isFrozen(root.a.b)).toBe(true);
    expect(Object.isFrozen(root.list)).toBe(true);
    expect(Object.isFrozen(root.list[0])).toBe(true);
  });

  test("passes primitives and null through unchanged", () => {
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze("s")).toBe("s");
    const undefinedInput: unknown = undefined;
    expect(deepFreeze(undefinedInput)).toBe(undefined);
  });

  test("short-circuits on an already frozen value without descending", () => {
    const child = { n: 1 };
    const root = Object.freeze({ child });
    deepFreeze(root);
    expect(Object.isFrozen(child)).toBe(false);
  });
});

describe("formatZodIssue", () => {
  test("joins path segments with dots and keeps numeric indices", () => {
    const schema = z.object({ items: z.array(z.object({ name: z.string() })) });
    const error = parseError(schema, { items: [{ name: 1 }] });
    expect(error.issues.length).toBe(1);
    const issue = error.issues[0];
    if (!issue) {
      throw new Error("expected an issue");
    }
    expect(formatZodIssue(error)).toBe(`items.0.name: ${issue.message}`);
  });

  test("renders an empty path as (root)", () => {
    const error = parseError(z.string(), 1);
    const issue = error.issues[0];
    if (!issue) {
      throw new Error("expected an issue");
    }
    expect(formatZodIssue(error)).toBe(`(root): ${issue.message}`);
  });

  test("joins several issues with a semicolon separator in issue order", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const error = parseError(schema, { a: 1, b: "x" });
    expect(error.issues.length).toBe(2);
    const expected = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    expect(formatZodIssue(error)).toBe(expected);
    expect(formatZodIssue(error)).toContain("; ");
  });
});

describe("loaderError", () => {
  test("formats a ZodError message as filePath plus formatted issue", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const error = parseError(schema, { a: 1, b: "x" });
    const result = loaderError("/cfg/x.yaml", error);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(`/cfg/x.yaml: ${formatZodIssue(error)}`);
  });

  test("falls back to String(error) for non-Zod errors", () => {
    expect(loaderError("/p.yaml", new Error("boom")).message).toBe("/p.yaml: Error: boom");
    expect(loaderError("/p.yaml", "plain").message).toBe("/p.yaml: plain");
  });

  test("keeps the original error object as cause", () => {
    const original = new Error("boom");
    expect(loaderError("/p.yaml", original).cause).toBe(original);
    const zodError = parseError(z.string(), 1);
    expect(loaderError("/p.yaml", zodError).cause).toBe(zodError);
  });
});
