import { expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("land-and-close strips newlines from variables to prevent injection", async () => {
  const src = readFileSync(resolve(".claude/workflows/land-and-close.js"), "utf8").replace(
    /^export const meta = /m,
    "const meta = ",
  );

  let agentMock = mock(async (prompt: string, opts: any) => {
    if (opts.label === "land") return { commit_sha: "123456", error: "" };
    if (opts.label === "verify")
      return { head: "123456", commit_sha: "123456", files_changed: 1, verified: true };
    if (opts.label === "close") {
      return { lane_status: "skipped", task_status: "skipped" };
    }
  });

  const sandbox = {
    args: {
      handoff_id: "handoff-1",
      commit_message: "multi\nline\nmessage",
      mode: "squash",
      lane_id: "lane\n1",
      board_task_id: "task-1",
      board_task_result_summary: "summary\nwith\nnewlines",
    },
    agent: agentMock,
    phase: () => {},
  };

  const fn = new Function(
    "args",
    "agent",
    "phase",
    `
    return (async () => {
      ${src}
    })();
  `,
  );

  await fn(sandbox.args, sandbox.agent, sandbox.phase);

  const landCall = agentMock.mock.calls.find((c) => c[1].label === "land");
  expect(landCall[0]).not.toContain("\\n");

  const closeCall = agentMock.mock.calls.find((c) => c[1].label === "close");
  expect(closeCall).toBeDefined();

  const closePrompt = closeCall[0];
  expect(closePrompt).not.toContain("\\n");
});
