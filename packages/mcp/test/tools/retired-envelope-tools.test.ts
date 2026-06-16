import { describe, expect, it } from "bun:test";
import { SearchInputShape } from "../../src/tools/search.js";
import { TaskListInputShape } from "../../src/tools/task-list.js";
import { ChainGetMessagesInputShape } from "../../src/tools/chain-get-messages.js";
import { ChainGetResponseInputShape } from "../../src/tools/chain-get-response.js";
import { HandoffGetInputShape } from "../../src/tools/handoff-get.js";
import { DispatchTimelineInputShape } from "../../src/tools/dispatch-timeline.js";
import { DispatchAuditInputShape } from "../../src/tools/dispatch-audit.js";
import { ChainHistoryInputShape } from "../../src/tools/chain-history.js";
import { ReconcilerVerdictsInputShape } from "../../src/tools/reconciler-verdicts.js";
import { PermissionGetInputShape } from "../../src/tools/permission-get.js";

function shapeOf(inputShape: unknown): Record<string, unknown> {
  if (typeof inputShape === "object" && inputShape !== null && "shape" in inputShape) {
    return (inputShape as { shape: Record<string, unknown> }).shape;
  }
  return inputShape as Record<string, unknown>;
}

describe("retired per-tool envelope flag", () => {
  it("removes envelope from the lossy tool schemas", () => {
    const cases: Array<[string, unknown]> = [
      ["memory_search", SearchInputShape],
      ["task_list", TaskListInputShape],
      ["chain_get_messages", ChainGetMessagesInputShape],
      ["chain_get_response", ChainGetResponseInputShape],
      ["handoff_get", HandoffGetInputShape],
      ["dispatch_timeline", DispatchTimelineInputShape],
      ["dispatch_audit", DispatchAuditInputShape],
      ["chain_history", ChainHistoryInputShape],
      ["reconciler_verdicts", ReconcilerVerdictsInputShape],
      ["permission_get", PermissionGetInputShape],
    ];

    for (const [name, inputShape] of cases) {
      expect("envelope" in shapeOf(inputShape), name).toBe(false);
    }
  });
});
