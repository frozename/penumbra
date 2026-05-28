import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { validatePlan } from "../../src/plan-meta/validator.js";
import type { TaskMeta } from "../../src/plan-meta/schema.js";

function task(overrides: Partial<TaskMeta> & Pick<TaskMeta, "id">): TaskMeta {
  return {
    id: overrides.id,
    files: overrides.files ?? ["src/task.md"],
    file_scope: overrides.file_scope ?? "modify-existing",
    depends_on: overrides.depends_on ?? [],
    parallel_with: overrides.parallel_with ?? [],
    preferred_agent: overrides.preferred_agent ?? "claude-acp-sonnet",
    fallback_agent: overrides.fallback_agent ?? "claude-acp-sonnet",
    task_size: overrides.task_size ?? "small",
    risk_class: overrides.risk_class ?? "paste-ready",
  };
}

async function emptyRepoRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plan-meta-validator-"));
}

describe("validatePlan", () => {
  test("happy path returns no errors", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks = [
      task({ id: "A", parallel_with: ["B"] }),
      task({ id: "B", parallel_with: ["A"] }),
    ];

    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: new Set(["claude-acp-sonnet"]),
    });

    expect(errors).toEqual([]);
  });

  test("flags unknown parallel_with id", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks = [task({ id: "A", parallel_with: ["X"] })];

    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: new Set(["claude-acp-sonnet"]),
    });

    expect(errors).toEqual([
      {
        task_id: "A",
        rule: "parallel_with_unknown",
        message: 'parallel_with references unknown task id "X"',
      },
    ]);
  });

  test("flags non-reciprocal parallel_with", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks = [task({ id: "A", parallel_with: ["B"] }), task({ id: "B" })];

    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: new Set(["claude-acp-sonnet"]),
    });

    expect(errors).toEqual([
      {
        task_id: "A",
        rule: "parallel_with_not_reciprocal",
        message: 'parallel_with must be reciprocated by task "B"',
      },
    ]);
  });

  test("flags depends_on cycles", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks = [task({ id: "A", depends_on: ["B"] }), task({ id: "B", depends_on: ["A"] })];

    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: new Set(["claude-acp-sonnet"]),
    });

    expect(errors).toEqual([
      {
        task_id: "A",
        rule: "depends_on_cycle",
        message: "depends_on cycle detected",
      },
      {
        task_id: "B",
        rule: "depends_on_cycle",
        message: "depends_on cycle detected",
      },
    ]);
  });

  test("flags existing files for file_scope new", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "plan-meta-validator-"));
    const existing = join(repoRoot, "created.txt");
    await writeFile(existing, "present");
    const tasks = [task({ id: "A", file_scope: "new", files: ["created.txt"] })];

    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: new Set(["claude-acp-sonnet"]),
    });

    expect(errors).toEqual([
      {
        task_id: "A",
        rule: "file_already_exists",
        message: "file already exists: created.txt",
      },
    ]);
  });

  test("flags unknown preferred_agent", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks = [task({ id: "A", preferred_agent: "fake-bot" })];

    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: new Set(["claude-acp-sonnet"]),
    });

    expect(errors).toEqual([
      {
        task_id: "A",
        rule: "preferred_agent_unknown",
        message: 'preferred_agent "fake-bot" is not in the registry',
      },
    ]);
  });
});
