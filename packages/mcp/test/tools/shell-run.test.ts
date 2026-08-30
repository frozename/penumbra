import type { DaemonClient } from "@src/daemon-client.js";

import { shellRunHandler } from "@src/tools/shell-run.js";
import { describe, expect, it, mock } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type ShellRunFn = DaemonClient["shellRun"];

describe("shellRunHandler", () => {
  it("calls daemon.shellRun with the input and wraps the response", async () => {
    const shellRun: ShellRunFn = mock(() =>
      Promise.resolve({
        session_id: "s1",
        exit_code: 0,
        stdout: "hi\n",
        stderr: "",
        truncated: false,
      }),
    );
    const handler = shellRunHandler(fakeDaemon({ shellRun }));
    const result = await handler({ handoff_id: "h-1", agent_name: "a", command: "echo hi" });
    expect(shellRun).toHaveBeenCalledTimes(1);
    const block = result.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(block).toMatchObject({ type: "text" });
    const parsed = JSON.parse(block.text) as { session_id: string; exit_code: number };
    expect(parsed.session_id).toBe("s1");
    expect(parsed.exit_code).toBe(0);
  });
});
