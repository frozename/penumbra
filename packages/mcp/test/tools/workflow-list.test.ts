import { expect, mock, test } from "bun:test";
import { workflowListHandler } from "../../src/tools/workflow-list.js";

test("calls daemon.workflowList and returns wrapped text content", async () => {
  const daemon = {
    workflowList: mock(async () => ({
      workflows: [{ name: "a", description: "D", triggers: [] }],
    })),
  };
  const handler = workflowListHandler(daemon as any);
  const r = await handler({});
  expect(daemon.workflowList).toHaveBeenCalled();
  expect(JSON.parse(r.content[0].text)).toEqual({
    workflows: [{ name: "a", description: "D", triggers: [] }],
  });
});
