import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  validatePlan,
  type ProjectRegistryLike,
  type ValidatorTask,
} from "../../src/plan-meta/validator.js";

function fakeRegistry(ids: string[]): ProjectRegistryLike {
  const set = new Set(ids);
  return { has: (id) => set.has(id) };
}

function task(overrides: Partial<ValidatorTask> & Pick<ValidatorTask, "id">): ValidatorTask {
  return {
    id: overrides.id,
    files: overrides.files ?? ["src/task.md"],
    file_scope: overrides.file_scope ?? "modify-existing",
    depends_on: overrides.depends_on ?? [],
    parallel_with: overrides.parallel_with ?? [],
    preferred_agent: overrides.preferred_agent ?? "codex-acp-fast",
    fallback_agent: overrides.fallback_agent ?? "claude-acp-sonnet",
    task_size: overrides.task_size ?? "small",
    risk_class: overrides.risk_class ?? "paste-ready",
    ...(overrides.project !== undefined ? { project: overrides.project } : {}),
  };
}

const KNOWN_AGENTS = new Set(["codex-acp-fast", "claude-acp-sonnet"]);

async function emptyRepoRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "plan-meta-validator-cross-project-"));
}

describe("validatePlan cross-project rules", () => {
  test("happy path — qualified deps resolve cleanly", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks: ValidatorTask[] = [
      task({ id: "1.1", project: "penumbra" }),
      task({ id: "2.1", project: "sirius", depends_on: ["penumbra/1.1"] }),
    ];
    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: KNOWN_AGENTS,
      projectRegistry: fakeRegistry(["penumbra", "sirius"]),
      header: { home_project: "penumbra" },
    });
    expect(errors).toEqual([]);
  });

  test("unknown project on a task is flagged", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks: ValidatorTask[] = [task({ id: "1.1", project: "nonexistent" })];
    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: KNOWN_AGENTS,
      projectRegistry: fakeRegistry(["penumbra"]),
      header: { home_project: "penumbra" },
    });
    expect(
      errors.some((e) => e.rule === "unknown_project" && e.message.includes("nonexistent")),
    ).toBe(true);
  });

  test("qualified dep referencing missing task is flagged", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks: ValidatorTask[] = [
      task({ id: "1.1", project: "penumbra", depends_on: ["sirius/9.9"] }),
    ];
    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: KNOWN_AGENTS,
      projectRegistry: fakeRegistry(["penumbra", "sirius"]),
      header: { home_project: "penumbra" },
    });
    expect(
      errors.some((e) => e.rule === "unknown_dep_target" && e.message.includes("sirius/9.9")),
    ).toBe(true);
  });

  test("cross-project cycle is detected", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks: ValidatorTask[] = [
      task({ id: "1.1", project: "penumbra", depends_on: ["sirius/1.1"] }),
      task({ id: "1.1", project: "sirius", depends_on: ["penumbra/1.1"] }),
    ];
    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: KNOWN_AGENTS,
      projectRegistry: fakeRegistry(["penumbra", "sirius"]),
      header: { home_project: "penumbra" },
    });
    expect(errors.some((e) => /cycle/i.test(e.message))).toBe(true);
  });

  test("bare dep resolves to declaring task project", async () => {
    const repoRoot = await emptyRepoRoot();
    const tasks: ValidatorTask[] = [
      task({ id: "1.1", project: "sirius" }),
      task({ id: "1.2", project: "sirius", depends_on: ["1.1"] }),
    ];
    const errors = await validatePlan(tasks, {
      repoRoot,
      knownAgents: KNOWN_AGENTS,
      projectRegistry: fakeRegistry(["penumbra", "sirius"]),
      header: { home_project: "penumbra" },
    });
    expect(errors).toEqual([]);
  });
});
