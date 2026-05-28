import { describe, expect, it, mock } from "bun:test";
import { shellCloseHandler } from "../../src/tools/shell-close.js";

describe("shellCloseHandler", () => {
  it("calls daemon.shellClose and wraps the response", async () => {
    const daemon = { shellClose: mock(async () => ({ closed: true })) };
    const handler = shellCloseHandler(daemon as any);
    const result = await handler({ handoff_id: "h-1", session_id: "s1" });
    expect(daemon.shellClose).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual({ closed: true });
  });
});
