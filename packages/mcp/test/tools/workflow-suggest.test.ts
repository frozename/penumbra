import type { DaemonClient } from "@src/daemon-client.js";

import { workflowSuggestHandler } from "@src/tools/workflow-suggest.js";
import { expect, mock, test } from "bun:test";

import { fakeDaemon } from "../helpers.js";

type WorkflowSuggestFn = DaemonClient["workflowSuggest"];

test("passes now to daemon.workflowSuggest and returns wrapped text content", async () => {
  const workflowSuggest = mock<WorkflowSuggestFn>(() =>
    Promise.resolve({ suggestions: [{ name: "demo", score: 0.9 }] }),
  );
  const handler = workflowSuggestHandler(fakeDaemon({ workflowSuggest }));
  const r = await handler({ now: "2026-05-04T00:00:00.000Z" });
  expect(workflowSuggest).toHaveBeenCalledWith({ now: "2026-05-04T00:00:00.000Z" });
  const block = r.content[0];
  if (!block) {
    throw new Error("expected content[0]");
  }
  expect(JSON.parse(block.text)).toEqual({ suggestions: [{ name: "demo", score: 0.9 }] });
});
