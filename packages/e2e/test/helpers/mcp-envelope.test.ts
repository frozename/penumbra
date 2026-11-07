import { describe, expect, test } from "bun:test";

import { parseToolResultJson, toolResultText } from "./mcp-envelope.js";

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
}

describe("toolResultText", () => {
  test("returns the text of a plain envelope exactly", () => {
    expect(toolResultText({ content: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  test("returns the text when isError is explicitly false", () => {
    expect(toolResultText({ isError: false, content: [{ text: "fine" }] })).toBe("fine");
  });

  test("returns a defined empty string without throwing; only undefined counts as missing", () => {
    expect(toolResultText({ content: [{ text: "" }] })).toBe("");
  });

  test("throws the error-envelope message when isError is true", () => {
    expect(() =>
      toolResultText({
        isError: true,
        content: [{ text: "MCP error -32602: Tool x not found" }],
      }),
    ).toThrow("MCP tool call returned an error envelope: MCP error -32602: Tool x not found");
  });

  test("throws on an error envelope even when the text is valid JSON", () => {
    expect(() => toolResultText({ isError: true, content: [{ text: '{"ok":true}' }] })).toThrow(
      'MCP tool call returned an error envelope: {"ok":true}',
    );
  });

  test("throws the error-envelope message with empty text when content is missing", () => {
    expect(() => toolResultText({ isError: true })).toThrow(
      "MCP tool call returned an error envelope: ",
    );
  });

  test("isError only fires on strict boolean true", () => {
    expect(toolResultText({ isError: "true", content: [{ text: "x" }] })).toBe("x");
  });

  test("throws the missing-text message for an empty content array", () => {
    expect(() => toolResultText({ content: [] })).toThrow(
      'MCP tool result is missing content[0].text: got {"content":[]}',
    );
  });

  test("consults only content[0] and does not fall through to later entries", () => {
    expect(() => toolResultText({ content: [{ type: "image" }, { text: "second" }] })).toThrow(
      "MCP tool result is missing content[0].text",
    );
  });

  test("throws the missing-text message for null and undefined inputs", () => {
    expect(thrownMessage(() => toolResultText(null))).toBe(
      "MCP tool result is missing content[0].text: got null",
    );
    expect(thrownMessage(() => toolResultText(undefined))).toBe(
      "MCP tool result is missing content[0].text: got null",
    );
  });

  test("caps the serialized result in the missing-text message at 500 characters", () => {
    const input = { content: [], pad: "a".repeat(2000) };
    const prefix = "MCP tool result is missing content[0].text: got ";
    const expected = prefix + JSON.stringify(input).slice(0, 500);
    expect(thrownMessage(() => toolResultText(input))).toBe(expected);
    expect(thrownMessage(() => toolResultText(input)).length).toBe(prefix.length + 500);
  });
});

describe("parseToolResultJson", () => {
  test("parses an object envelope text", () => {
    const parsed = parseToolResultJson<{ a: number; b: number[] }>({
      content: [{ type: "text", text: '{"a":1,"b":[2,3]}' }],
    });
    expect(parsed).toEqual({ a: 1, b: [2, 3] });
  });

  test("returns a JSON scalar", () => {
    expect(parseToolResultJson<number>({ content: [{ text: "42" }] })).toBe(42);
  });

  test("throws the raw text, not a SyntaxError, on non-JSON text", () => {
    const input = { content: [{ text: "MCP error -32602: Tool x not found" }] };
    expect(thrownMessage(() => parseToolResultJson(input))).toBe(
      "MCP tool result text is not valid JSON: MCP error -32602: Tool x not found",
    );
    expect(thrownMessage(() => parseToolResultJson(input))).not.toMatch(/Unexpected/);
    expect(() => parseToolResultJson(input)).toThrow(
      "MCP tool result text is not valid JSON: MCP error -32602: Tool x not found",
    );
  });

  test("throws the error-envelope message instead of returning the parsed value", () => {
    expect(() => parseToolResultJson({ isError: true, content: [{ text: '{"a":1}' }] })).toThrow(
      'MCP tool call returned an error envelope: {"a":1}',
    );
  });

  test("throws the not-valid-JSON message for an empty string text", () => {
    expect(() => parseToolResultJson({ content: [{ text: "" }] })).toThrow(
      "MCP tool result text is not valid JSON: ",
    );
  });

  test("propagates the missing-text error when content is missing", () => {
    expect(thrownMessage(() => parseToolResultJson({ content: [] }))).toMatch(
      /^MCP tool result is missing content\[0\]\.text/,
    );
  });
});
