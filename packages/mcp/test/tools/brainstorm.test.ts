import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { brainstormHandler } from "@src/tools/brainstorm.js";
import { TOOL_REGISTRY } from "@src/tools/registry.js";

import { fakeDaemon } from "../helpers.js";

type WorkflowRunFn = DaemonClient["workflowRun"];

function firstBlockText(envelope: { content: { text: string }[] }): string {
  const block = envelope.content[0];
  if (block === undefined) throw new Error("expected content[0]");
  return block.text;
}

test("brainstorm proxies to workflowRun with workflow name and args", async () => {
  const workflowRun: WorkflowRunFn = mock(() =>
    Promise.resolve({ outcome: "success", run_id: "wf-1" }),
  );
  const handler = brainstormHandler(fakeDaemon({ workflowRun }));
  const out = await handler({
    topic: "Improve dispatch reliability",
    constraints: "No daemon schema changes",
  });
  expect(workflowRun).toHaveBeenCalledWith({
    name: "brainstorm",
    wait: true,
    args: {
      topic: "Improve dispatch reliability",
      constraints: "No daemon schema changes",
    },
  });
  expect(JSON.parse(firstBlockText(out))).toEqual({ outcome: "success", run_id: "wf-1" });
});

test("brainstorm keeps explicit cwd and skips fallback resolution", async () => {
  const workflowRun: WorkflowRunFn = mock(() =>
    Promise.resolve({ outcome: "success", run_id: "wf-explicit" }),
  );
  const resolveCwd = mock(() => "/daemon/repo");
  const handler = brainstormHandler(fakeDaemon({ workflowRun }), { resolveCwd });
  const out = await handler({
    topic: "Improve dispatch reliability",
    constraints: "No daemon schema changes",
    cwd: "/repos/llamactl",
  });
  expect(resolveCwd).toHaveBeenCalledTimes(0);
  expect(workflowRun).toHaveBeenCalledWith({
    name: "brainstorm",
    wait: true,
    cwd: "/repos/llamactl",
    args: {
      topic: "Improve dispatch reliability",
      constraints: "No daemon schema changes",
    },
  });
  expect(JSON.parse(firstBlockText(out))).toEqual({
    outcome: "success",
    run_id: "wf-explicit",
  });
});

test("brainstorm fills omitted cwd from handler opts and returns a resolution warning", async () => {
  const workflowRun: WorkflowRunFn = mock(() =>
    Promise.resolve({ outcome: "success", run_id: "wf-inferred" }),
  );
  const handler = brainstormHandler(fakeDaemon({ workflowRun }), {
    resolveCwd: () => "/mcp/subprocess/cwd",
  });
  const out = await handler({ topic: "Improve dispatch reliability" });
  expect(workflowRun).toHaveBeenCalledWith({
    name: "brainstorm",
    wait: true,
    cwd: "/mcp/subprocess/cwd",
    args: {
      topic: "Improve dispatch reliability",
    },
  });
  expect(JSON.parse(firstBlockText(out))).toEqual({
    outcome: "success",
    run_id: "wf-inferred",
    resolution_warning: "brainstorm_cwd_inferred_from_mcp_cwd",
  });
});

test("brainstorm registry handler opts resolve cwd from the MCP subprocess", async () => {
  const workflowRun: WorkflowRunFn = mock(() =>
    Promise.resolve({ outcome: "success", run_id: "wf-registry" }),
  );
  const handler = TOOL_REGISTRY.brainstorm!.makeHandler(fakeDaemon({ workflowRun }), {});
  await handler({ topic: "Improve dispatch reliability" });
  expect(workflowRun).toHaveBeenCalledWith({
    name: "brainstorm",
    wait: true,
    cwd: process.cwd(),
    args: {
      topic: "Improve dispatch reliability",
    },
  });
});

test("brainstorm returns structured workflow_missing error when brainstorm workflow is absent", async () => {
  const workflowRun: WorkflowRunFn = mock(() =>
    Promise.reject(
      new DaemonHttpError("daemon /workflows/run: HTTP 404", 404, {
        error: { code: "not_found", message: "workflow brainstorm not found" },
      }),
    ),
  );
  const handler = brainstormHandler(fakeDaemon({ workflowRun }));
  const out = await handler({ topic: "Find alternatives" });
  expect(JSON.parse(firstBlockText(out))).toEqual({
    error: {
      code: "workflow_missing",
      workflow: "brainstorm",
      message: "workflow brainstorm is not registered",
    },
  });
});
