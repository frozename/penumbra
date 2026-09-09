import { expect, test } from "bun:test";

import { logWorkflowRegistryErrors } from "../src/commands/start.js";

type LoggedCall = { obj: Record<string, unknown>; msg: string };

function collectingLog(): { calls: LoggedCall[]; error: (o: Record<string, unknown>, m: string) => void } {
  const calls: LoggedCall[] = [];
  return {
    calls,
    error: (obj: Record<string, unknown>, msg: string): void => {
      calls.push({ obj, msg });
    },
  };
}

test("logWorkflowRegistryErrors is silent for a clean registry", () => {
  const log = collectingLog();
  expect(logWorkflowRegistryErrors(log, { errors: [] })).toBe(0);
  expect(log.calls).toEqual([]);
});

test("logWorkflowRegistryErrors is silent when the registry is unavailable", () => {
  const log = collectingLog();
  expect(logWorkflowRegistryErrors(log, undefined)).toBe(0);
  expect(log.calls).toEqual([]);
});

test("logWorkflowRegistryErrors reports every failed workflow plus a summary", () => {
  const log = collectingLog();
  const count = logWorkflowRegistryErrors(log, {
    errors: [
      { path: "plugin/workflows/penumbra-fanout/workflow.ts", error: "Could not resolve @penumbra/x" },
      { path: "plugin/workflows/dupe/workflow.ts", error: "duplicate workflow name: dupe" },
    ],
  });
  expect(count).toBe(2);
  expect(log.calls).toHaveLength(3);
  expect(log.calls[0]?.obj.path).toBe("plugin/workflows/penumbra-fanout/workflow.ts");
  expect(log.calls[0]?.obj.err).toContain("Could not resolve");
  expect(log.calls[0]?.msg).toBe("workflow failed to load");
  expect(log.calls[1]?.obj.path).toBe("plugin/workflows/dupe/workflow.ts");
  expect(log.calls[2]?.obj.failed_count).toBe(2);
  expect(log.calls[2]?.msg).toContain("2 failed workflow");
});
