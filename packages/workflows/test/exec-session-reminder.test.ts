import { expect, test } from "bun:test";
import { executeWorkflow } from "../src/exec.js";
import type { WorkflowSpec } from "../src/schema.js";

test("session-reminder sink populates result.sessionReminder with rendered template", async () => {
  const spec: WorkflowSpec = {
    name: "remind",
    description: "remind",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [{ kind: "session-reminder" }],
    run: { kind: "markdown-template", template: "Hello {{recall.note}}" },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: { note: "maestro" }, warnings: [], estimatedTokens: 0 },
    storageRoot: "/tmp",
  });
  expect(result.outcome).toBe("success");
  expect(result.sessionReminder).toBe("Hello maestro");
});

test("multiple session-reminder sinks join with double-newline", async () => {
  const spec: WorkflowSpec = {
    name: "remind2",
    description: "remind2",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [{ kind: "session-reminder" }, { kind: "session-reminder" }],
    run: { kind: "markdown-template", template: "pulse" },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: "/tmp",
  });
  expect(result.sessionReminder).toBe("pulse\n\npulse");
});

test("absent session-reminder sink leaves result.sessionReminder undefined", async () => {
  const spec: WorkflowSpec = {
    name: "no-remind",
    description: "no-remind",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    run: { kind: "markdown-template", template: "plain" },
  };
  const result = await executeWorkflow({
    spec,
    bundle: { byKey: {}, warnings: [], estimatedTokens: 0 },
    storageRoot: "/tmp",
  });
  expect(result.sessionReminder).toBeUndefined();
});
