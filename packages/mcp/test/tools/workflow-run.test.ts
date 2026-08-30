import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import type { DaemonClient } from "../../src/daemon-client.js";

import { WorkflowCwdRequiredError, workflowRunHandler } from "../../src/tools/workflow-run.js";
import { fakeDaemon } from "../helpers.js";

type WorkflowRunFn = DaemonClient["workflowRun"];
type WorkflowOutput = {
  resolution_warning?: string;
  workflow_run_id?: string;
};

function makeWorkflowRun(
  result: unknown = { outcome: "success" },
): ReturnType<typeof mock<WorkflowRunFn>> {
  return mock<WorkflowRunFn>(() => Promise.resolve(result));
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject but it resolved");
}

const originalEnv = process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
beforeEach(() => {
  delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID;
  else process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = originalEnv;
});

test("passes name to daemon.workflowRun and returns wrapped text content", async () => {
  const workflowRun = makeWorkflowRun({ outcome: "success", composedPrompt: "OK" });
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }));
  const r = await handler({ name: "demo" });
  expect(workflowRun).toHaveBeenCalledWith({ name: "demo" });
  const block = r.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  expect(JSON.parse(block.text)).toEqual({ outcome: "success", composedPrompt: "OK" });
});

test("forwards wait:true to daemon.workflowRun", async () => {
  const workflowRun = makeWorkflowRun({ workflow_run_id: "wf-1", started_at: 123 });
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }));
  await handler({ name: "demo", wait: true });
  expect(workflowRun).toHaveBeenCalledWith({ name: "demo", wait: true });
});

test("forwards optional session_id and cwd to daemon.workflowRun", async () => {
  const workflowRun = makeWorkflowRun();
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }));
  await handler({ name: "demo", cwd: "/tmp/demo", session_id: "sess-123" });
  expect(workflowRun).toHaveBeenCalledWith({
    name: "demo",
    cwd: "/tmp/demo",
    session_id: "sess-123",
  });
});

test("forwards optional args to daemon.workflowRun", async () => {
  const workflowRun = makeWorkflowRun();
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }));
  await handler({ name: "demo", args: { base_ref: "main", target_ref: "HEAD" } });
  expect(workflowRun).toHaveBeenCalledWith({
    name: "demo",
    args: { base_ref: "main", target_ref: "HEAD" },
  });
});

test("fills cwd from handler opts when caller omits cwd, with resolution_warning surfaced to caller", async () => {
  const workflowRun = makeWorkflowRun({ workflow_run_id: "w" });
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }), {
    resolveCwd: (): string => "/some/path",
  });
  const r = await handler({ name: "demo" });
  expect(workflowRun).toHaveBeenCalledWith({
    name: "demo",
    cwd: "/some/path",
  });
  const block = r.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  const parsed: unknown = JSON.parse(block.text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid workflow output");
  const output = parsed as WorkflowOutput;
  expect(output.resolution_warning).toBe("workflow_cwd_inferred_from_mcp_cwd");
  expect(output.workflow_run_id).toBe("w");
});

test("throws WorkflowCwdRequiredError when env gate set and cwd omitted", async () => {
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const workflowRun = makeWorkflowRun();
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }), {
    resolveCwd: (): string => "/daemon/cwd",
  });
  const err = await captureRejection(handler({ name: "demo" }));
  expect(err).toBeInstanceOf(WorkflowCwdRequiredError);
  expect(workflowRun).not.toHaveBeenCalled();
});

test("env gate accepts true/yes/on values", async () => {
  for (const v of ["true", "yes", "on"]) {
    process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = v;
    const workflowRun = makeWorkflowRun();
    const handler = workflowRunHandler(fakeDaemon({ workflowRun }), {
      resolveCwd: (): string => "/daemon/cwd",
    });
    const err = await captureRejection(handler({ name: "demo" }));
    expect(err).toBeInstanceOf(WorkflowCwdRequiredError);
  }
});

test("env gate does NOT fire when caller passes explicit cwd", async () => {
  process.env.PENUMBRA_REQUIRE_EXPLICIT_PROJECT_ID = "1";
  const workflowRun = makeWorkflowRun();
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }), {
    resolveCwd: (): string => "/daemon/cwd",
  });
  await handler({ name: "demo", cwd: "/caller/cwd" });
  expect(workflowRun).toHaveBeenCalledWith({ name: "demo", cwd: "/caller/cwd" });
});

test("keeps caller cwd when provided", async () => {
  const workflowRun = makeWorkflowRun();
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }), {
    resolveCwd: (): string => "/some/path",
  });
  await handler({ name: "demo", cwd: "/caller/path" });
  expect(workflowRun).toHaveBeenCalledWith({ name: "demo", cwd: "/caller/path" });
});

test("leaves cwd unset when no opts are provided", async () => {
  const workflowRun = makeWorkflowRun();
  const handler = workflowRunHandler(fakeDaemon({ workflowRun }));
  await handler({ name: "demo" });
  expect(workflowRun).toHaveBeenCalledWith({ name: "demo" });
});
