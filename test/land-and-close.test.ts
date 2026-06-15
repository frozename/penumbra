import { expect, test, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("land-and-close escapes newlines and strips control chars so injected values can't forge instructions", async () => {
  const src = readFileSync(resolve(".claude/workflows/land-and-close.js"), "utf8").replace(
    /^export const meta = /m,
    "const meta = ",
  );

  let agentMock = mock(async (_prompt: string, opts: any) => {
    if (opts.label === "land") return { commit_sha: "123456", error: "" };
    if (opts.label === "verify")
      return { head: "123456", commit_sha: "123456", files_changed: 1, verified: true };
    if (opts.label === "close") {
      return { lane_status: "skipped", task_status: "skipped" };
    }
  });

  // Newlines are legitimate in commit bodies, so the workflow does NOT strip
  // them — it escapes them at the interpolation site via JSON.stringify, which
  // keeps an injected newline INSIDE the quoted value (it cannot forge a new
  // physical "STEP" line). Raw control chars (here ESC, \x1b) are dropped.
  const commitMessage = "multi\nline\x1bmessage";
  const laneId = "lane\n1";
  const summary = "summary\nwith\nnewlines";

  const sandbox = {
    args: {
      handoff_id: "handoff-1",
      commit_message: commitMessage,
      mode: "squash",
      lane_id: laneId,
      board_task_id: "task-1",
      board_task_result_summary: summary,
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
  expect(landCall).toBeDefined();
  const landPrompt = landCall![0] as string;
  // Control char dropped outright.
  expect(landPrompt).not.toContain("\x1b");
  // The raw value (with REAL newlines) must NOT appear verbatim — a real newline
  // would forge a new instruction line. It survives only JSON-escaped + quoted.
  expect(landPrompt).not.toContain(commitMessage);
  expect(landPrompt).toContain(JSON.stringify("multi\nlinemessage"));

  const closeCall = agentMock.mock.calls.find((c) => c[1].label === "close");
  expect(closeCall).toBeDefined();
  const closePrompt = closeCall![0] as string;
  // Injected lane_id / summary newlines are escaped, not passed through raw.
  expect(closePrompt).not.toContain(laneId);
  expect(closePrompt).toContain(JSON.stringify(laneId));
  expect(closePrompt).not.toContain(summary);
});
