import { expect, mock, test } from "bun:test";
import { workflowSuggestHandler } from "../../src/tools/workflow-suggest.js";

test("passes now to daemon.workflowSuggest and returns wrapped text content", async () => {
  const daemon = {
    workflowSuggest: mock(async () => ({ suggestions: [{ name: "demo", score: 0.9 }] })),
  };
  const handler = workflowSuggestHandler(daemon as any);
  const r = await handler({ now: "2026-05-04T00:00:00.000Z" });
  expect(daemon.workflowSuggest).toHaveBeenCalledWith({ now: "2026-05-04T00:00:00.000Z" });
  expect(JSON.parse(r.content[0].text)).toEqual({ suggestions: [{ name: "demo", score: 0.9 }] });
});
