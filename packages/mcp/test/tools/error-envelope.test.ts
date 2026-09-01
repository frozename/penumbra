import { describe, expect, it } from "bun:test";

import { errorEnvelope } from "@src/tools/error-envelope.js";

describe("tool errorEnvelope", () => {
  it("returns an MCP isError text envelope with a prefixed message", () => {
    const out = errorEnvelope("session_note_drafts", "invalid_response", "invalid daemon body");

    expect(out.isError).toBe(true);
    expect(out.content).toHaveLength(1);
    expect(out.content[0]?.type).toBe("text");
    const text = out.content[0]?.text;
    if (typeof text !== "string") throw new Error("expected content[0].text");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "invalid_response",
        message: "session_note_drafts: invalid daemon body",
      },
    });
  });
});
