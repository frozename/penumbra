import { expect, mock, test } from "bun:test";

import type { DaemonClient } from "@src/daemon-client.js";
import { DaemonHttpError } from "@src/daemon-client.js";
import { brainstormHandler } from "@src/tools/brainstorm.js";

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
