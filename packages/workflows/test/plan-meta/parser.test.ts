import { expect, test } from "bun:test";
import { parsePlanMeta } from "../../src/plan-meta/parser.js";

test("parses valid yaml meta blocks in document order", () => {
  const markdown = [
    "# Plan",
    "",
    "### Task 1.1 - First task",
    "",
    "```yaml meta",
    'id: "1.1"',
    "files:",
    "  - packages/workflows/src/a.ts",
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    "preferred_agent: codex-acp-fast",
    "fallback_agent: claude-acp-sonnet",
    "task_size: small",
    "risk_class: paste-ready",
    "```",
    "",
    "First task body line 1.",
    "",
    "First task body line 2.",
    "",
    "### Task 1.2 - Second task",
    "",
    "```yaml meta",
    'id: "1.2"',
    "files:",
    "  - packages/workflows/src/b.ts",
    "file_scope: modify-existing",
    'depends_on: ["1.1"]',
    "parallel_with: []",
    "preferred_agent: gemini-acp-flash",
    "fallback_agent: claude-acp-sonnet",
    "task_size: substantial",
    "risk_class: schema-aware",
    "```",
  ].join("\n");

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(2);
  expect(result.errors).toHaveLength(0);
  expect(result.tasks.map((task) => task.id)).toEqual(["1.1", "1.2"]);
  expect(result.tasks[0]?.heading).toBe("Task 1.1 - First task");
  expect(result.tasks[0]?.body).toBe("First task body line 1.\n\nFirst task body line 2.");
  expect(result.tasks[1]?.heading).toBe("Task 1.2 - Second task");
  expect(result.tasks[1]?.body).toBeUndefined();
});

test("bounds task prose by the next task heading and phase heading", () => {
  const markdown = [
    "### Task 1.1 - First",
    "",
    "```yaml meta",
    'id: "1.1"',
    "files:",
    "  - packages/workflows/src/a.ts",
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    "preferred_agent: codex-acp-fast",
    "fallback_agent: claude-acp-sonnet",
    "task_size: small",
    "risk_class: paste-ready",
    "```",
    "",
    "alpha",
    "",
    "### Task 1.2 - Second",
    "",
    "```yaml meta",
    'id: "1.2"',
    "files:",
    "  - packages/workflows/src/b.ts",
    "file_scope: modify-existing",
    "depends_on: []",
    "parallel_with: []",
    "preferred_agent: gemini-acp-flash",
    "fallback_agent: claude-acp-sonnet",
    "task_size: substantial",
    "risk_class: schema-aware",
    "```",
    "",
    "beta",
    "",
    "## Phase 2 - Later work",
  ].join("\n");

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(2);
  expect(result.tasks[0]?.body).toBe("alpha");
  expect(result.tasks[1]?.body).toBe("beta");
});

test("omits body when there is no prose after the meta block", () => {
  const markdown = [
    "### Task 1.1 - First",
    "",
    "```yaml meta",
    'id: "1.1"',
    "files:",
    "  - packages/workflows/src/a.ts",
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    "preferred_agent: codex-acp-fast",
    "fallback_agent: claude-acp-sonnet",
    "task_size: small",
    "risk_class: paste-ready",
    "```",
    "",
    "## Phase 2 - Later work",
  ].join("\n");

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0]?.body).toBeUndefined();
});

test("reports malformed yaml as an error", () => {
  const markdown = [
    "```yaml meta",
    'id: "1.1"',
    "files:",
    "  - packages/workflows/src/a.ts",
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    "preferred_agent: codex-acp-fast",
    "fallback_agent: claude-acp-sonnet",
    "task_size: small",
    "risk_class: paste-ready",
    "```",
    "",
    "```yaml meta",
    'id: "1.2"',
    "files:",
    "  - packages/workflows/src/b.ts",
    "file_scope: modify-existing",
    "depends_on: [",
    "parallel_with: []",
    "preferred_agent: gemini-acp-flash",
    "fallback_agent: claude-acp-sonnet",
    "task_size: substantial",
    "risk_class: schema-aware",
    "```",
  ].join("\n");

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(1);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].line).toBeGreaterThan(0);
  expect(result.errors[0].reason.length).toBeGreaterThan(0);
});

test("reports schema rejection as an error", () => {
  const markdown = [
    "```yaml meta",
    'id: "1.1"',
    "files:",
    "  - packages/workflows/src/a.ts",
    "file_scope: new",
    "depends_on: []",
    "parallel_with: []",
    "preferred_agent: codex-acp-fast",
    "fallback_agent: claude-acp-sonnet",
    "risk_class: paste-ready",
    "```",
  ].join("\n");

  const result = parsePlanMeta(markdown);
  expect(result.tasks).toHaveLength(0);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].line).toBe(1);
  expect(result.errors[0].reason.length).toBeGreaterThan(0);
});

test("returns an empty result when no yaml meta blocks exist", () => {
  const result = parsePlanMeta("# Nothing here\n\n```ts\nconst x = 1;\n```\n");
  expect(result.tasks).toHaveLength(0);
  expect(result.errors).toHaveLength(0);
});
