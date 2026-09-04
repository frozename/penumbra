/**
 * MCP tool-result envelope unwrapper.
 *
 * For ~3.5 months the e2e suite filed real failures as environmental noise
 * because the 2026-05-15 registry rename (dotted -> underscore tool ids,
 * b8faf93e) made the MCP server answer every call with a NON-throwing
 * { isError: true, content: [{ text: "MCP error -32602: Tool <name> not found" }] }
 * envelope, and the blind `JSON.parse(content[0].text)` downstream died as
 * `SyntaxError: Unexpected identifier "MCP"`. This helper surfaces the
 * envelope text as the thrown error message so a tool-level error can never
 * again masquerade as a JSON syntax error.
 *
 * It must never be softened into a fallback that returns a value: returning
 * anything on an isError or non-JSON envelope reintroduces the exact silent
 * failure mode this file exists to prevent.
 */

interface McpToolResultLike {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

/** Returns the envelope text, throwing it as the message when isError is set. */
export function toolResultText(out: unknown): string {
  const result = out as McpToolResultLike | null | undefined;
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError === true) {
    throw new Error(`MCP tool call returned an error envelope: ${text}`);
  }
  return text;
}

/** Parses the envelope text as JSON, throwing the raw text on any failure. */
// The generic is return-position-only by design: callers tag the parsed shape
// (e.g. parseToolResultJson<TaskListItem>(out)) exactly as the prior inline
// `JSON.parse(...) as T` casts did, but throwing the readable envelope text
// instead of a SyntaxError. Mirrors safeParseJSON in packages/core/src/utils/json.ts.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseToolResultJson<T>(out: unknown): T {
  const text = toolResultText(out);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`MCP tool result text is not valid JSON: ${text}`);
  }
}
