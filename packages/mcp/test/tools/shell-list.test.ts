import { describe, expect, it, mock } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { shellListHandler } from "../../src/tools/shell-list.js";
import { fakeDaemon } from "../helpers.js";

type ShellListFn = DaemonClient["shellList"];

describe("shellListHandler", () => {
  it("calls daemon.shellList with handoff_id and wraps the response", async () => {
    const sessions = [
      {
        session_id: "s1",
        created_at: "2026-05-02T10:00:00.000Z",
        last_used_at: "2026-05-02T10:00:01.000Z",
        cwd: "/tmp",
        pty: false,
      },
    ];
    const shellList: ShellListFn = mock(() => Promise.resolve({ sessions }));
    const handler = shellListHandler(fakeDaemon({ shellList }));
    const result = await handler({ handoff_id: "h-1" });
    expect(shellList).toHaveBeenCalledTimes(1);
    const block = result.content[0];
    if (block === undefined) throw new Error("expected content[0]");
    const parsed = JSON.parse(block.text) as { sessions: unknown[] };
    expect(parsed.sessions).toHaveLength(1);
  });
});
