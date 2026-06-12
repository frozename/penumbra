import type { Registry } from "./registry.js";
import type { Trigger, WorkflowSpec } from "./schema.js";

export function evaluateTriggerEvent(reg: Registry, event: Trigger): WorkflowSpec[] {
  return reg.findByTrigger(event);
}

export type StateMetrics = {
  "queue-idle-min": number;
  "time-since-last-handoff-min": number;
  "pending-handoffs": number;
  "commits-since-last-handoff": number;
  "context-window-percent": number;
  "pending-review-lanes": number;
};

export function evaluateStateThresholds(reg: Registry, metrics: StateMetrics): WorkflowSpec[] {
  const out: WorkflowSpec[] = [];
  for (const spec of reg.list()) {
    for (const t of spec.triggers) {
      if (t.kind !== "state-threshold") continue;
      const cur = metrics[t.metric];
      const ok = t.op === ">" ? cur > t.value : cur < t.value;
      if (ok) {
        out.push(spec);
        break;
      }
    }
  }
  return out;
}
