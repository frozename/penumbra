import { describe, expect, test } from "bun:test";

import { runWorkflowCapturingPrompts } from "./harness.js";

const SWARM = ".claude/workflows/penumbra-swarm.js";

interface FanoutArgs {
  tasks?: Array<Record<string, unknown>>;
  defaults?: Record<string, unknown>;
  dispatcherModel?: string;
  repo?: string;
}

describe("penumbra-swarm argument forwarding", () => {
  test("maxTasks:0 dispatches nothing and makes no planner agent call", async () => {
    const { prompts, workflowCalls, error } = await runWorkflowCapturingPrompts(SWARM, {
      goal: "ship it",
      maxTasks: 0,
      defaults: { project_id: "penumbra" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeUndefined();
    expect(workflowCalls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  test("defaults.task_name reaches penumbra-fanout", async () => {
    const { workflowCalls, error } = await runWorkflowCapturingPrompts(SWARM, {
      goal: "ship it",
      defaults: { project_id: "penumbra", task_name: "SWARM-DEFAULT" },
    });

    expect(error).toBeUndefined();
    const fanout = workflowCalls.find((call) => call.name === "penumbra-fanout");
    expect(fanout).toBeDefined();
    const args = fanout!.args as FanoutArgs;
    expect(args.defaults?.task_name).toBe("SWARM-DEFAULT");
  });
});
