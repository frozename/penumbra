import { expect, mock, test } from "bun:test";
import { workflowStatusHandler, workflowWaitHandler } from "../../src/tools/workflow-status.js";

test("workflow_status proxies workflow_run_id to daemon.workflowStatus", async () => {
  const daemon = { workflowStatus: mock(async () => ({ status: "running" })) };
  const handler = workflowStatusHandler(daemon as any);
  const res = await handler({ workflow_run_id: "wfrun-1" });
  expect(daemon.workflowStatus).toHaveBeenCalledWith({ workflow_run_id: "wfrun-1" });
  expect(JSON.parse(res.content[0].text)).toEqual({ status: "running" });
});

test("workflow_wait proxies workflow_run_id and timeout_ms to daemon.workflowWait", async () => {
  const daemon = { workflowWait: mock(async () => ({ status: "completed", started_at: 1 })) };
  const handler = workflowWaitHandler(daemon as any);
  await handler({ workflow_run_id: "wfrun-1", timeout_ms: 1234 });
  expect(daemon.workflowWait).toHaveBeenCalledWith({
    workflow_run_id: "wfrun-1",
    timeout_ms: 1234,
  });
});
