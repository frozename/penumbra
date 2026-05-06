import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OrchestrateAgentNotMaestroCapable } from '@penumbra/core';
import type { PlanWriter, TaskEventBus, TaskEvent, TaskWriter } from '@penumbra/core';
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

function computeBranchBase(
  taskMeta: any,
  effectiveProject: string,
  byCanonicalKey: Map<string, any>,
  db: Database,
  log?: { warn?: (msg: string, meta?: any) => void },
): string | undefined {
  const deps = taskMeta.depends_on ?? [];
  if (deps.length === 0) return undefined;

  const sameProjectDeps = deps.filter((dep: string) => {
    const canonical = dep.includes('/') ? dep : `${effectiveProject}/${dep}`;
    const [proj] = canonical.split('/');
    return proj === effectiveProject;
  });

  if (sameProjectDeps.length === 0) {
    return undefined;
  }

  if (sameProjectDeps.length > 1) {
    log?.warn?.(
      `[plan-runtime] leaf ${taskMeta.id} has ${sameProjectDeps.length} same-project deps; phase 1 falls back to default base. Phase 2 will merge-stage all dep tips.`,
    );
    return undefined;
  }

  const depKey = sameProjectDeps[0].includes('/')
    ? sameProjectDeps[0]
    : `${effectiveProject}/${sameProjectDeps[0]}`;
  const depTask = byCanonicalKey.get(depKey);
  if (!depTask || depTask.task_id_in_board == null) return undefined;

  const handoffRow = db
    .query<{ chain_handoff_id: string }, [string]>(
      'SELECT chain_handoff_id FROM maestro_sessions WHERE task_id = ? LIMIT 1',
    )
    .get(depTask.task_id_in_board);
  if (!handoffRow) return undefined;

  // Look up the board task's handoff_id. Plan-task → board-task → maestro session → handoff.
  // Phase 2 will walk transitive same-project ancestors and merge-stage multiple dep tips.
  return `agent/${handoffRow.chain_handoff_id}`;
}

function deriveLeafPrompt(taskMeta: any, header: any, plan: any): string {
  const lines: string[] = [];
  lines.push(`Implement Task ${taskMeta.id} of plan ${header?.plan_id ?? 'unknown'}.`);
  if (taskMeta.heading) {
    lines.push('');
    lines.push(`Task: ${taskMeta.heading}`);
  }
  lines.push('');
  lines.push(`Files: ${(taskMeta.files ?? []).join(', ')}`);
  lines.push(`file_scope: ${taskMeta.file_scope}`);
  lines.push(`preferred_agent: ${taskMeta.preferred_agent}`);
  if (taskMeta.body) {
    lines.push('');
    lines.push('## Task description');
    lines.push('');
    lines.push(taskMeta.body);
  }
  lines.push('');
  lines.push(`(Plan file: ${plan.file_path} — read it for cross-task context if accessible.)`);
  return lines.join('\n');
}

type ParseCacheEntry = { sha: string; parsed: Awaited<ReturnType<NonNullable<PlanRuntimeSweeperOpts['planParser']>>> };

export function createPlanRuntimeSweeper(opts: PlanRuntimeSweeperOpts): {
  start(): void;
  stop(): void;
  tick(): Promise<{ fired: string[] }>;
  subscribe(bus: TaskEventBus): () => void;
} {
  const intervalMs = opts.intervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const planParser = opts.planParser ?? parsePlanMetaFile;
  const cache = new Map<string, ParseCacheEntry>();
  let intervalHandle: NodeJS.Timeout | null = null;
  let running = false;
  let activeEventIterator: AsyncIterableIterator<TaskEvent> | null = null;
  let eventLoopRunning = false;

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
          const branchBase = computeBranchBase(taskMeta, effectiveProject, byCanonicalKey, opts.db, opts.log);
          const result = opts.taskWriter.file({
            kind: 'orchestrate',
            prompt: deriveLeafPrompt(taskMeta, header, plan),
            created_by_kind: 'workflow',
            created_by_id: 'plan-runtime',
            eligibility: {
              allow_agents: [taskMeta.preferred_agent, taskMeta.fallback_agent].filter(Boolean),
            },
            bounds: header.plan_defaults?.bounds ?? defaultBounds,
            branch_base: branchBase,
          } as any);
          opts.plans.bindTaskToBoard(plan.plan_id, taskMeta.id, result.task_id);
          fired.push(taskMeta.id);
        } catch (error) {
          if (error instanceof OrchestrateAgentNotMaestroCapable) {
            if (error.reason === 'unknown') {
              opts.log?.warn?.(
                `[plan-runtime] cannot file leaf task ${plan.plan_id}/${taskMeta.id}: agent ${error.agent_name} not found in agentchat.yaml`,
              );
            } else {
              const allowAgents = [taskMeta.preferred_agent, taskMeta.fallback_agent].filter(Boolean);
              opts.log?.warn?.(
                `[plan-runtime] cannot file leaf task ${plan.plan_id}/${taskMeta.id}: agent ${error.agent_name} is not maestro_capable. Mark at least one of [${allowAgents.join(', ')}] with \`maestro_capable: true\` in ~/.config/agentchat/agentchat.yaml`,
              );
            }
          } else {
            opts.log?.warn?.('[plan-runtime] failed to file leaf task', {
              plan_id: plan.plan_id,
              task_meta_id: taskMeta.id,
              error: String(error),
            });
          }
          opts.plans.markTaskStatus(plan.plan_id, taskMeta.id, 'failed', now());
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

  async function handleTaskEvent(event: TaskEvent): Promise<void> {
    const kind = event.kind as string;
    if (kind !== 'completed' && kind !== 'failed' && kind !== 'cancelled') return;

    const hit = opts.plans.findPlanTaskByBoardId(event.task_id);
    if (!hit) return;

    try {
      opts.plans.markTaskStatus(hit.plan_id, hit.task_meta_id, kind as any, event.at);
    } catch (error) {
      opts.log?.warn?.('[plan-runtime] failed to mark plan-task status from event', {
        event,
        error: String(error),
      });
      return;
    }

    void tick().catch((error) => {
      opts.log?.warn?.('[plan-runtime] immediate tick failed', { error: String(error) });
    });
  }

  function subscribe(bus: TaskEventBus): () => void {
    const iterator = bus.subscribe((event) => {
      const kind = event.kind as string;
      return kind === 'completed' || kind === 'failed' || kind === 'cancelled';
    });
    activeEventIterator = iterator;
    void (async () => {
      try {
        for await (const event of iterator) {
          await handleTaskEvent(event);
        }
      } catch (error) {
        opts.log?.warn?.('[plan-runtime] task event loop failed', { error: String(error) });
      } finally {
        if (activeEventIterator === iterator) {
          activeEventIterator = null;
        }
      }
    })();

    return () => {
      if (activeEventIterator === iterator) {
        activeEventIterator = null;
      }
      void iterator.return?.();
    };
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
    subscribe,
  };
}
