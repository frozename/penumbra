import { expect, test } from "bun:test";

import { WorkflowSpecSchema } from "../src/schema.js";

test("parses canonical session-handoff playbook spec", () => {
  const input = {
    name: "session-handoff",
    description: "Compose a continuation prompt at end-of-session",
    triggers: [
      { kind: "lifecycle", event: "pre-compact" },
      { kind: "lifecycle", event: "stop" },
      { kind: "slash", command: "handoff" },
    ],
    recall: [
      {
        source: "memory_search",
        args: { query: "session", dateStart: "{{today}}", project: "{{project}}" },
      },
      { source: "git.log", args: { range: "since=midnight" } },
      { source: "git.show", args: { since: "midnight" } },
      { source: "file.contents", args: { path: "README.md", max_bytes: 4096 } },
      { source: "dispatch_events", args: { outcomes_only: true } },
    ],
    recall_budget_tokens: 8000,
    process_gates: ["verification-before-complete"],
    output: [
      { kind: "file", path: "docs/notes/maestro-continuation-{{date}}-{{period}}.md" },
      { kind: "clipboard" },
      { kind: "next-session-prompt" },
    ],
    run: { kind: "markdown-template", template: "# Session Handoff\n\n{{recall.git.log}}" },
  };
  const parsed = WorkflowSpecSchema.parse(input);
  expect(parsed.name).toBe("session-handoff");
  expect(parsed.triggers).toHaveLength(3);
  expect(parsed.process_gates).toEqual(["verification-before-complete"]);
  expect(parsed.recall.some((r) => r.source === "git.show")).toBe(true);
  expect(parsed.recall.some((r) => r.source === "file.contents")).toBe(true);
  expect(parsed.recall.some((r) => r.source === "dispatch_events")).toBe(true);
});

test("rejects unknown trigger kind", () => {
  const bad = {
    name: "x",
    description: "y",
    triggers: [{ kind: "cron", when: "0 0 * * *" }],
    recall: [],
    output: [],
    run: { kind: "markdown-template", template: "" },
  };
  const r = WorkflowSpecSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("rejects unknown recall source", () => {
  const bad = {
    name: "x",
    description: "y",
    triggers: [{ kind: "manual" }],
    recall: [{ source: "twitter.search", args: {} }],
    output: [],
    run: { kind: "markdown-template", template: "" },
  };
  const r = WorkflowSpecSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("rejects unknown gate name", () => {
  const bad = {
    name: "x",
    description: "y",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    process_gates: ["non-existent-gate"],
    run: { kind: "markdown-template", template: "" },
  };
  const r = WorkflowSpecSchema.safeParse(bad);
  expect(r.success).toBe(false);
});

test("accepts ts-function run kind", () => {
  const input = {
    name: "x",
    description: "y",
    triggers: [{ kind: "manual" }],
    recall: [],
    output: [],
    run: { kind: "ts-function" },
  };
  const r = WorkflowSpecSchema.parse(input);
  expect(r.run.kind).toBe("ts-function");
});

test("TriggerSchema accepts kind:lifecycle, event:session-end", () => {
  const input = {
    name: "session-end-workflow",
    description: "y",
    triggers: [{ kind: "lifecycle", event: "session-end" }],
    recall: [],
    output: [],
    run: { kind: "markdown-template", template: "" },
  };
  const r = WorkflowSpecSchema.parse(input);
  expect(r.triggers).toEqual([{ kind: "lifecycle", event: "session-end" }]);
});
