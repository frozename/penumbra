import { describe, expect, it, mock } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { shellCloseHandler } from "@src/tools/shell-close.js";

import { fakeDaemon } from "../helpers.js";

type ShellCloseFn = DaemonClient["shellClose"];

describe("shellCloseHandler", () => {
  it("calls daemon.shellClose and wraps the response", async () => {
    const shellClose: ShellCloseFn = mock(() => Promise.resolve({ closed: true }));
    const handler = shellCloseHandler(fakeDaemon({ shellClose }));
    const result = await handler({ handoff_id: "h-1", session_id: "s1" });
    expect(shellClose).toHaveBeenCalledTimes(1);
    const block = result.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    expect(JSON.parse(block.text)).toEqual({ closed: true });
  });
});
