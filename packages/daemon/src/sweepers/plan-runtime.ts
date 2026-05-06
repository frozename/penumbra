import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PlanWriter } from '@penumbra/core';
import type { TaskWriter } from '@penumbra/core';
import { parsePlanMetaFile } from '@penumbra/workflows';

export interface PlanRuntimeSweeperOpts {
  db: Database;
  plans: PlanWriter;
  taskWriter: TaskWriter;
  planParser?: (path: string) => Promise<{ header?: any; tasks: any[]; errors: any[] }>;
  intervalMs?: number;
  log?: { warn: (msg: string, meta?: any) => void; info?: any };
  now?: () => number;
}

const defaultBounds = { wall_clock_ms: 600_000, cost_cents: 50, max_sub_dispatches: 3 };

function deriveLeafPrompt(taskMeta: any, header: any, plan: any): string {
  return `Implement Task ${taskMeta.id} of plan ${header?.plan_id ?? 'unknown'}.\n\n` +
    `Plan file: ${plan.file_path}\n` +
    `Files: ${(taskMeta.files ?? []).join(', ')}\n` +
    `file_scope: ${taskMeta.file_scope}\n` +
    `preferred_agent: ${taskMeta.preferred_agent}\n\n` +
    `Refer to the plan file for the full task spec, tests, and acceptance criteria.`;
}

type ParseCacheEntry = { sha: string; parsed: Awaited<ReturnType<NonNullable<PlanRuntimeSweeperOpts['planParser']>>> };

export function createPlanRuntimeSweeper(opts: PlanRuntimeSweeperOpts): {
  start(): void;
  stop(): void;
  tick(): Promise<{ fired: string[] }>;
} {
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const planParser = opts.planParser ?? parsePlanMetaFile;
  const cache = new Map<string, ParseCacheEntry>();
  let intervalHandle: NodeJS.Timeout | null = null;
  let running = false;

  async function parsePlanFile(filePath: string) {
    const bytes = await readFile(filePath);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const cached = cache.get(filePath);
    if (cached && cached.sha === sha) {
      return cached.parsed;
    }

    const parsed = await planParser(filePath);
    cache.set(filePath, { sha, parsed });
    return parsed;
  }

  async function tick(): Promise<{ fired: string[] }> {
    const fired: string[] = [];
    const runningPlans = opts.plans.listPlans({ status: 'running' });

    for (const plan of runningPlans) {
      let parsed;
      try {
        parsed = await parsePlanFile(plan.file_path);
      } catch (error) {
        opts.log?.warn?.('[plan-runtime] plan parse failed', { plan_id: plan.plan_id, file_path: plan.file_path, error: String(error) });
        continue;
      }

      if (!parsed.header || parsed.errors.length > 0) {
        opts.log?.warn?.('[plan-runtime] invalid plan meta', {
          plan_id: plan.plan_id,
          file_path: plan.file_path,
          errors: parsed.errors,
        });
        continue;
      }

      const header = parsed.header;
      const tasks = opts.plans.getTasks(plan.plan_id);
      const byCanonicalKey = new Map<string, (typeof tasks)[number]>();
      for (const task of tasks) {
        const effectiveProject = task.project_id;
        byCanonicalKey.set(`${effectiveProject}/${task.task_meta_id}`, task);
      }

      for (const task of tasks) {
        if (task.status !== 'pending' || task.task_id_in_board !== null) {
          continue;
        }

        const taskMeta = parsed.tasks.find((candidate) => candidate.id === task.task_meta_id);
        if (!taskMeta) {
          continue;
        }

        const effectiveProject = taskMeta.project ?? header.home_project;
        let ready = true;
        for (const dep of taskMeta.depends_on ?? []) {
          const canonicalKey = dep.includes('/') ? dep : `${effectiveProject}/${dep}`;
          const depTask = byCanonicalKey.get(canonicalKey);
          if (!depTask || depTask.status !== 'completed') {
            ready = false;
            break;
          }
        }
        if (!ready) {
          continue;
        }

        try {
          const result = opts.taskWriter.file({
            kind: 'orchestrate',
            prompt: deriveLeafPrompt(taskMeta, header, plan),
            created_by_kind: 'workflow',
            created_by_id: 'plan-runtime',
            eligibility: {
              allow_agents: [taskMeta.preferred_agent, taskMeta.fallback_agent].filter(Boolean),
            },
            bounds: header.plan_defaults?.bounds ?? defaultBounds,
          } as any);
          opts.plans.bindTaskToBoard(plan.plan_id, taskMeta.id, result.task_id);
          fired.push(taskMeta.id);
        } catch (error) {
          opts.log?.warn?.('[plan-runtime] failed to file leaf task', {
            plan_id: plan.plan_id,
            task_meta_id: taskMeta.id,
            error: String(error),
          });
        }
      }

      const refreshedTasks = opts.plans.getTasks(plan.plan_id);
      if (refreshedTasks.some((task) => task.status === 'failed')) {
        opts.plans.markPlanStatus(plan.plan_id, 'failed');
        continue;
      }
      if (refreshedTasks.length > 0 && refreshedTasks.every((task) => task.status === 'completed')) {
        opts.plans.markPlanStatus(plan.plan_id, 'completed');
      }
    }

    return { fired };
  }

  return {
    start(): void {
      if (intervalHandle) return;
      intervalHandle = setInterval(() => {
        if (running) return;
        running = true;
        tick().finally(() => {
          running = false;
        });
      }, intervalMs);
      if (typeof (intervalHandle as any).unref === 'function') {
        (intervalHandle as any).unref();
      }
    },
    stop(): void {
      if (!intervalHandle) return;
      clearInterval(intervalHandle);
      intervalHandle = null;
    },
    tick,
  };
}
