import { access } from "node:fs/promises";
import { resolve } from "node:path";

import type { TaskMeta } from "./schema.js";

export type ValidationError = { task_id: string; rule: string; message: string };

export type ValidatorTask = TaskMeta & { project?: string };

export type ValidatorPlanHeader = { home_project?: string };

export interface ProjectRegistryLike {
  has(project_id: string): boolean;
}

export interface ValidateOpts {
  repoRoot: string;
  knownAgents: Set<string>;
  projectRegistry?: ProjectRegistryLike;
  header?: ValidatorPlanHeader;
}

const NO_PROJECT_KEY = "__noproject__";

type TaskIndex = Map<string, number>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function effectiveProject(
  task: ValidatorTask,
  header: ValidatorPlanHeader | undefined,
): string | undefined {
  const fromTask =
    typeof task.project === "string" && task.project.length > 0 ? task.project : undefined;
  if (fromTask) return fromTask;
  const fromHeader =
    header && typeof header.home_project === "string" && header.home_project.length > 0
      ? header.home_project
      : undefined;
  return fromHeader;
}

function canonicalKey(project: string | undefined, id: string): string {
  return `${project ?? NO_PROJECT_KEY}/${id}`;
}

function parseDep(
  dep: string,
  declarerProject: string | undefined,
): { project: string | undefined; id: string; qualified: boolean } {
  const slash = dep.indexOf("/");
  if (slash > 0 && slash < dep.length - 1) {
    return { project: dep.slice(0, slash), id: dep.slice(slash + 1), qualified: true };
  }
  return { project: declarerProject, id: dep, qualified: false };
}

function recordCycleFromStack(
  key: string,
  stack: string[],
  stackIndex: Map<string, number>,
  cycleNodes: Set<string>,
): void {
  const start = stackIndex.get(key);
  if (start !== undefined) {
    for (let index = start; index < stack.length; index += 1) {
      const cycleNode = stack[index];
      if (cycleNode !== undefined) {
        cycleNodes.add(cycleNode);
      }
    }
  }
  cycleNodes.add(key);
}

function collectCycleNodes(
  tasks: ValidatorTask[],
  header: ValidatorPlanHeader | undefined,
): Set<string> {
  const canonicalIndex = new Map<string, ValidatorTask>();
  for (const task of tasks) {
    const eff = effectiveProject(task, header);
    canonicalIndex.set(canonicalKey(eff, task.id), task);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const cycleNodes = new Set<string>();

  const visit = (key: string): void => {
    const current = state.get(key);
    if (current === 1) {
      recordCycleFromStack(key, stack, stackIndex, cycleNodes);
      return;
    }
    if (current === 2) {
      return;
    }

    state.set(key, 1);
    stackIndex.set(key, stack.length);
    stack.push(key);

    const task = canonicalIndex.get(key);
    if (task) {
      const declarerProject = effectiveProject(task, header);
      for (const dependency of task.depends_on) {
        const { project, id } = parseDep(dependency, declarerProject);
        const depKey = canonicalKey(project, id);
        if (canonicalIndex.has(depKey)) {
          visit(depKey);
        }
      }
    }

    stack.pop();
    stackIndex.delete(key);
    state.set(key, 2);
  };

  for (const task of tasks) {
    const eff = effectiveProject(task, header);
    const key = canonicalKey(eff, task.id);
    if (state.get(key) !== 2) {
      visit(key);
    }
  }

  return cycleNodes;
}

function validateParallel(
  task: ValidatorTask,
  eff: string | undefined,
  canonicalIndex: Map<string, ValidatorTask>,
  header: ValidatorPlanHeader | undefined,
  errors: ValidationError[],
): void {
  for (const parallelId of task.parallel_with) {
    const parsed = parseDep(parallelId, eff);
    const parallelKey = canonicalKey(parsed.project, parsed.id);
    const parallelTask = canonicalIndex.get(parallelKey);
    if (!parallelTask) {
      errors.push({
        task_id: task.id,
        rule: "parallel_with_unknown",
        message: `parallel_with references unknown task id "${parallelId}"`,
      });
      continue;
    }
    const targetEff = effectiveProject(parallelTask, header);
    const reciprocalKey = canonicalKey(eff, task.id);
    const targetParallelKeys = new Set(
      parallelTask.parallel_with.map((entry) => {
        const targetParsed = parseDep(entry, targetEff);
        return canonicalKey(targetParsed.project, targetParsed.id);
      }),
    );
    if (!targetParallelKeys.has(reciprocalKey)) {
      errors.push({
        task_id: task.id,
        rule: "parallel_with_not_reciprocal",
        message: `parallel_with must be reciprocated by task "${parallelId}"`,
      });
    }
  }
}

async function validateFiles(
  task: ValidatorTask,
  repoRoot: string,
  errors: ValidationError[],
): Promise<void> {
  if (task.file_scope !== "new") return;
  for (const file of task.files) {
    const filePath = resolve(repoRoot, file);
    if (await pathExists(filePath)) {
      errors.push({
        task_id: task.id,
        rule: "file_already_exists",
        message: `file already exists: ${file}`,
      });
    }
  }
}

function validateAgents(
  task: ValidatorTask,
  knownAgents: Set<string>,
  errors: ValidationError[],
): void {
  if (!knownAgents.has(task.preferred_agent)) {
    errors.push({
      task_id: task.id,
      rule: "preferred_agent_unknown",
      message: `preferred_agent "${task.preferred_agent}" is not in the registry`,
    });
  }
  if (!knownAgents.has(task.fallback_agent)) {
    errors.push({
      task_id: task.id,
      rule: "fallback_agent_unknown",
      message: `fallback_agent "${task.fallback_agent}" is not in the registry`,
    });
  }
}

function validateDeps(
  task: ValidatorTask,
  eff: string | undefined,
  canonicalIndex: Map<string, ValidatorTask>,
  cycleNodes: Set<string>,
  errors: ValidationError[],
): void {
  for (const dependency of task.depends_on) {
    const parsed = parseDep(dependency, eff);
    const depKey = canonicalKey(parsed.project, parsed.id);
    if (!canonicalIndex.has(depKey)) {
      errors.push({
        task_id: task.id,
        rule: "unknown_dep_target",
        message: `depends_on "${dependency}" not found in plan`,
      });
    }
  }
  if (cycleNodes.has(canonicalKey(eff, task.id))) {
    errors.push({
      task_id: task.id,
      rule: "depends_on_cycle",
      message: "depends_on cycle detected",
    });
  }
}

export async function validatePlan(
  tasks: ValidatorTask[],
  opts: ValidateOpts,
): Promise<ValidationError[]> {
  const taskIndex: TaskIndex = new Map(tasks.map((task, index) => [task.id, index]));
  const errors: ValidationError[] = [];
  const cycleNodes = collectCycleNodes(tasks, opts.header);

  const canonicalIndex = new Map<string, ValidatorTask>();
  for (const task of tasks) {
    const eff = effectiveProject(task, opts.header);
    canonicalIndex.set(canonicalKey(eff, task.id), task);
  }

  for (const task of tasks) {
    const eff = effectiveProject(task, opts.header);
    validateParallel(task, eff, canonicalIndex, opts.header, errors);
    await validateFiles(task, opts.repoRoot, errors);
    validateAgents(task, opts.knownAgents, errors);
    if (opts.projectRegistry && eff && !opts.projectRegistry.has(eff)) {
      errors.push({
        task_id: task.id,
        rule: "unknown_project",
        message: `unknown project "${eff}" (not in registry)`,
      });
    }
    validateDeps(task, eff, canonicalIndex, cycleNodes, errors);
  }

  return errors.sort((left, right) => {
    const leftIndex = taskIndex.get(left.task_id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = taskIndex.get(right.task_id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return left.rule.localeCompare(right.rule);
  });
}
