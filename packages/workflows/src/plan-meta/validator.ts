import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskMeta } from './schema.js';

export type ValidationError = { task_id: string; rule: string; message: string };

export interface ValidateOpts {
  repoRoot: string;
  knownAgents: Set<string>;
}

type TaskIndex = Map<string, number>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function collectCycleNodes(tasks: TaskMeta[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const cycleNodes = new Set<string>();

  const visit = (taskId: string): void => {
    const current = state.get(taskId);
    if (current === 1) {
      const start = stackIndex.get(taskId);
      if (start !== undefined) {
        for (let index = start; index < stack.length; index += 1) {
          cycleNodes.add(stack[index]);
        }
      }
      cycleNodes.add(taskId);
      return;
    }
    if (current === 2) {
      return;
    }

    state.set(taskId, 1);
    stackIndex.set(taskId, stack.length);
    stack.push(taskId);

    const task = byId.get(taskId);
    if (task) {
      for (const dependency of task.depends_on) {
        if (byId.has(dependency)) {
          visit(dependency);
        }
      }
    }

    stack.pop();
    stackIndex.delete(taskId);
    state.set(taskId, 2);
  };

  for (const task of tasks) {
    if (state.get(task.id) !== 2) {
      visit(task.id);
    }
  }

  return cycleNodes;
}

export async function validatePlan(tasks: TaskMeta[], opts: ValidateOpts): Promise<ValidationError[]> {
  const taskIndex: TaskIndex = new Map(tasks.map((task, index) => [task.id, index]));
  const errors: ValidationError[] = [];
  const cycleNodes = collectCycleNodes(tasks);

  for (const task of tasks) {
    for (const parallelId of task.parallel_with) {
      if (!taskIndex.has(parallelId)) {
        errors.push({
          task_id: task.id,
          rule: 'parallel_with_unknown',
          message: `parallel_with references unknown task id "${parallelId}"`,
        });
        continue;
      }

      const parallelTask = tasks[taskIndex.get(parallelId)!];
      if (!parallelTask.parallel_with.includes(task.id)) {
        errors.push({
          task_id: task.id,
          rule: 'parallel_with_not_reciprocal',
          message: `parallel_with must be reciprocated by task "${parallelId}"`,
        });
      }
    }

    if (task.file_scope === 'new') {
      for (const file of task.files) {
        const filePath = resolve(opts.repoRoot, file);
        if (await pathExists(filePath)) {
          errors.push({
            task_id: task.id,
            rule: 'file_already_exists',
            message: `file already exists: ${file}`,
          });
        }
      }
    }

    if (!opts.knownAgents.has(task.preferred_agent)) {
      errors.push({
        task_id: task.id,
        rule: 'preferred_agent_unknown',
        message: `preferred_agent "${task.preferred_agent}" is not in the registry`,
      });
    }

    if (!opts.knownAgents.has(task.fallback_agent)) {
      errors.push({
        task_id: task.id,
        rule: 'fallback_agent_unknown',
        message: `fallback_agent "${task.fallback_agent}" is not in the registry`,
      });
    }

    if (cycleNodes.has(task.id)) {
      errors.push({
        task_id: task.id,
        rule: 'depends_on_cycle',
        message: 'depends_on cycle detected',
      });
    }
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
