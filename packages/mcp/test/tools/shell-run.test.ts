import { describe, expect, it, mock } from "bun:test";
import { shellRunHandler } from "../../src/tools/shell-run.js";

describe("shellRunHandler", () => {
  it("calls daemon.shellRun with the input and wraps the response", async () => {
    const daemon = {
      shellRun: mock(async () => ({
        session_id: "s1",
        exit_code: 0,
        stdout: "hi\n",
        stderr: "",
        truncated: false,
      })),
    };
    const handler = shellRunHandler(daemon as any);
    const result = await handler({ handoff_id: "h-1", agent_name: "a", command: "echo hi" });
    expect(daemon.shellRun).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.session_id).toBe("s1");
    expect(parsed.exit_code).toBe(0);
  });
});
