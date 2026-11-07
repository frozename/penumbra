import { describe, expect, test } from "bun:test";

import { IoError } from "@src/worker/write-tools-errors.js";
import { normalizeWriteTextContent } from "@src/worker/write-tools-executor.js";

function errorMessageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(IoError);
    return (err as Error).message;
  }
  throw new Error("expected normalizeWriteTextContent to throw");
}

describe("normalizeWriteTextContent pass-through", () => {
  test("returns a string content verbatim", () => {
    expect(normalizeWriteTextContent("hello\nworld")).toBe("hello\nworld");
    expect(normalizeWriteTextContent("")).toBe("");
  });

  test("concatenates string array elements in order", () => {
    expect(normalizeWriteTextContent(["a", "b", "c"])).toBe("abc");
    expect(normalizeWriteTextContent([])).toBe("");
  });

  test("extracts text fields from object elements", () => {
    expect(normalizeWriteTextContent([{ text: "foo" }, "bar", { text: "baz" }])).toBe("foobarbaz");
  });

  test("extracts a top-level text field", () => {
    expect(normalizeWriteTextContent({ text: "solo" })).toBe("solo");
  });
});

describe("normalizeWriteTextContent invalid input", () => {
  test("invalid array element throws with element type and content preview", () => {
    const message = errorMessageOf(() => normalizeWriteTextContent(["ok", 42]));
    expect(message).toBe(
      `invalid array element in content: number. content preview: ${JSON.stringify(["ok", 42])}`,
    );
  });

  test("invalid array element with object missing text throws object type", () => {
    const message = errorMessageOf(() => normalizeWriteTextContent([{ nope: true }]));
    expect(message).toContain("invalid array element in content: object.");
  });

  test("invalid array element with non-string text throws object type", () => {
    const message = errorMessageOf(() => normalizeWriteTextContent([{ text: 7 }]));
    expect(message).toContain("invalid array element in content: object.");
  });

  test("invalid top-level type throws with type and content preview", () => {
    const message = errorMessageOf(() => normalizeWriteTextContent(42));
    expect(message).toBe(`invalid content type: number. content preview: ${JSON.stringify(42)}`);
  });

  test("top-level object without text throws object type", () => {
    const message = errorMessageOf(() => normalizeWriteTextContent({ nope: 1 }));
    expect(message).toContain("invalid content type: object.");
  });
});

describe("normalizeWriteTextContent error preview length", () => {
  const longPayload = "x".repeat(500);

  test("array-element error preview is truncated to exactly 200 chars", () => {
    const content = [longPayload, 42];
    const message = errorMessageOf(() => normalizeWriteTextContent(content));
    const preview = message.slice(
      "invalid array element in content: number. content preview: ".length,
    );
    expect(preview.length).toBe(200);
    expect(preview).toBe(JSON.stringify(content).slice(0, 200));
    expect(JSON.stringify(content).startsWith(preview)).toBe(true);
  });

  test("top-level-type error preview is truncated to exactly 200 chars", () => {
    const content = { data: longPayload };
    const message = errorMessageOf(() => normalizeWriteTextContent(content));
    const preview = message.slice("invalid content type: object. content preview: ".length);
    expect(preview.length).toBe(200);
    expect(preview).toBe(JSON.stringify(content).slice(0, 200));
  });

  test("short content preview is not truncated", () => {
    const content = ["ok", 42];
    const message = errorMessageOf(() => normalizeWriteTextContent(content));
    const preview = message.slice(
      "invalid array element in content: number. content preview: ".length,
    );
    expect(preview).toBe(JSON.stringify(content));
    expect(preview.length).toBeLessThan(200);
  });
});
