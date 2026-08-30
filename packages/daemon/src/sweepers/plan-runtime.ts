import type {
  PlanTaskRecord,
  PlanWriter,
  TaskEvent,
  TaskEventBus,
  TaskWriter,
  WorktreeManager,
} from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { OrchestrateAgentNotMaestroCapable } from "@penumbra/core";
import { parsePlanMetaFile } from "@penumbra/workflows";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveHandoffBranchName } from "../../../core/src/worktree/branch-name.js";

type StageMergedBaseWorktreeManager = {
  stageMergedBase(
    handoffId: string,
    ancestorRefs: string[],
    opts?: { project_id?: string },
  ): Promise<string>;
};

interface PlanRuntimeBounds {
  wall_clock_ms?: number;
  cost_cents?: number;
  max_sub_dispatches?: number;
}

interface PlanRuntimePlanDefaults {
  bounds?: PlanRuntimeBounds;
}

export interface PlanRuntimeParsedHeader {
  plan_id: string;
  home_project: string;
  plan_defaults?: PlanRuntimePlanDefaults;
}

export interface PlanRuntimeParsedTask {
  id: string;
  files: string[];
  file_scope: string;
  project?: string;
  depends_on: string[];
  preferred_agent: string;
  fallback_agent?: string;
  heading?: string;
  body?: string;
}

export interface PlanRuntimeParseResult {
  header?: PlanRuntimeParsedHeader;
  tasks: PlanRuntimeParsedTask[];
  errors: unknown[];
}

interface PlanRuntimeLog {
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
}

// PlanRuntimeLog declares warn(msg, meta) for historical reasons, but the
// production logger is pino, whose structured context must be the first arg.
// This helper is scoped to the live-verified quarantine warning; fixing the
// other historical warn(msg, meta) sites is a separate follow-up.
function warnWithContext(
  log: PlanRuntimeLog | undefined,
  meta: Record<string, unknown>,
  msg: string,
): void {
  (log?.warn as ((obj: Record<string, unknown>, msg?: string) => void) | undefined)?.(meta, msg);
}

export interface PlanRuntimeSweeperOpts {
  db: Database;
  plans: PlanWriter;
  taskWriter: TaskWriter;
  worktreeManager?: WorktreeManager;
  planParser?: (path: string) => Promise<PlanRuntimeParseResult>;
  intervalMs?: number;
  log?: PlanRuntimeLog;
  now?: () => number;
}

const defaultBounds: PlanRuntimeBounds = {
  wall_clock_ms: 600_000,
  cost_cents: 50,
  max_sub_dispatches: 3,
};

const PARSE_FAILURE_QUARANTINE_THRESHOLD = 3;

interface BranchBaseCtx {
  taskMeta: PlanRuntimeParsedTask;
  effectiveProject: string;
  planId: string;
  byCanonicalKey: Map<string, PlanTaskRecord>;
  parsedTasks: PlanRuntimeParsedTask[];
  db: Database;
  worktreeManager?: StageMergedBaseWorktreeManager;
  log?: PlanRuntimeLog;
}

interface AncestorEntry {
  task: PlanTaskRecord;
  canonical: string;
  depth: number;
}

function resolveHandoff(db: Database, task: PlanTaskRecord | undefined): string | undefined {
  if (task?.task_id_in_board === null || task?.task_id_in_board === undefined) return undefined;
  const handoffRow = db
    .query<{ chain_handoff_id: string; branch_name: string | null }, [string]>(
      `SELECT m.chain_handoff_id, h.branch_name
         FROM maestro_sessions m
         LEFT JOIN handoffs h ON h.handoff_id = m.chain_handoff_id
        WHERE m.task_id = ?
        LIMIT 1`,
    )
    .get(task.task_id_in_board);
  return handoffRow
    ? resolveHandoffBranchName({
        handoff_id: handoffRow.chain_handoff_id,
        branch_name: handoffRow.branch_name,
      })
    : undefined;
}

function collectSameProjectAncestors(ctx: BranchBaseCtx): AncestorEntry[] {
  const visited = new Set<string>();
  const ancestors: AncestorEntry[] = [];

  const walk = (canonical: string, depth: number): void => {
    if (visited.has(canonical)) return;
    visited.add(canonical);

    const depTask = ctx.byCanonicalKey.get(canonical);
    if (!depTask) return;

    const [proj] = canonical.split("/");
    if (
      proj === ctx.effectiveProject &&
      depTask.task_id_in_board !== null &&
      depTask.status === "completed"
    ) {
      ancestors.push({ task: depTask, canonical, depth });
    }

    const ancestorMeta = ctx.parsedTasks.find((candidate) => candidate.id === depTask.task_meta_id);
    for (const subdep of ancestorMeta?.depends_on ?? []) {
      const subCanonical = subdep.includes("/") ? subdep : `${proj ?? ""}/${subdep}`;
      walk(subCanonical, depth + 1);
    }
  };

  for (const dep of ctx.taskMeta.depends_on) {
    const canonical = dep.includes("/") ? dep : `${ctx.effectiveProject}/${dep}`;
    walk(canonical, 1);
  }

  ancestors.sort(
    (a, b) => (b.task.last_event_ts ?? 0) - (a.task.last_event_ts ?? 0) || a.depth - b.depth,
  );
  return ancestors;
}

async function maybeStageMergedBase(
  ctx: BranchBaseCtx,
  ancestors: AncestorEntry[],
): Promise<string | undefined> {
  const distinct = new Set(ancestors.map((ancestor) => ancestor.canonical));
  if (distinct.size <= 1 || !ctx.worktreeManager) return undefined;

  const ancestorRefs = ancestors
    .map((ancestor) => resolveHandoff(ctx.db, ancestor.task))
    .filter((ref): ref is string => Boolean(ref));
  if (ancestorRefs.length <= 1) return undefined;

  const stageHandoffId = `${ctx.planId}__${ctx.taskMeta.id}`;
  ctx.log?.warn?.(
    `[plan-runtime] leaf ${ctx.taskMeta.id} has multiple same-project ancestors ${[...distinct].join(", ")}; phase 2b will merge-stage.`,
  );
  try {
    return await ctx.worktreeManager.stageMergedBase(stageHandoffId, ancestorRefs, {
      project_id: ctx.effectiveProject,
    });
  } catch (error: unknown) {
    ctx.log?.warn?.(
      `[plan-runtime] merge-stage failed for leaf ${ctx.taskMeta.id}; falling back to latest ancestor ${ancestors[0]?.canonical ?? ""}: ${String(error)}`,
      { error: String(error), ancestorRefs },
    );
    return undefined;
  }
}

async function computeBranchBase(ctx: BranchBaseCtx): Promise<string | undefined> {
  const ancestors = collectSameProjectAncestors(ctx);
  if (ancestors.length === 0) return undefined;

  if (ancestors.length > 1) {
    const staged = await maybeStageMergedBase(ctx, ancestors);
    if (staged !== undefined) return staged;

    const distinct = new Set(ancestors.map((ancestor) => ancestor.canonical));
    const chosen = ancestors[0];
    if (distinct.size > 1 && chosen) {
      ctx.log?.warn?.(
        `[plan-runtime] leaf ${ctx.taskMeta.id} has multiple same-project ancestors ${[...distinct].join(", ")}; phase 2b will merge-stage. Using ${chosen.canonical}.`,
      );
    }
  }

  return resolveHandoff(ctx.db, ancestors[0]?.task);
}

function deriveLeafPrompt(
  taskMeta: PlanRuntimeParsedTask,
  header: PlanRuntimeParsedHeader,
  planFilePath: string,
): string {
  const lines: string[] = [];
  lines.push(`Implement Task ${taskMeta.id} of plan ${header.plan_id}.`);
  if (taskMeta.heading !== undefined) {
    lines.push("");
    lines.push(`Task: ${taskMeta.heading}`);
  }
  lines.push("");
  lines.push(`Files: ${taskMeta.files.join(", ")}`);
  lines.push(`file_scope: ${taskMeta.file_scope}`);
  lines.push(`preferred_agent: ${taskMeta.preferred_agent}`);
  if (taskMeta.body !== undefined) {
    lines.push("");
    lines.push("## Task description");
    lines.push("");
    lines.push(taskMeta.body);
  }
  lines.push("");
  lines.push(`(Plan file: ${planFilePath} — read it for cross-task context if accessible.)`);
  return lines.join("\n");
}

type ParseCacheEntry = {
  sha: string;
  parsed: PlanRuntimeParseResult;
};

function makeParsePlanFile(
  cache: Map<string, ParseCacheEntry>,
  parser: (path: string) => Promise<PlanRuntimeParseResult>,
): (filePath: string) => Promise<PlanRuntimeParseResult> {
  return async (filePath: string) => {
    const bytes = await readFile(filePath);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const cached = cache.get(filePath);
    if (cached?.sha === sha) {
      return cached.parsed;
    }

    const parsed = await parser(filePath);
    cache.set(filePath, { sha, parsed });
    return parsed;
  };
}

function isTaskReady(
  taskMeta: PlanRuntimeParsedTask,
  effectiveProject: string,
  byCanonicalKey: Map<string, PlanTaskRecord>,
): boolean {
  for (const dep of taskMeta.depends_on) {
    const canonicalKey = dep.includes("/") ? dep : `${effectiveProject}/${dep}`;
    const depTask = byCanonicalKey.get(canonicalKey);
    if (depTask?.status !== "completed") {
      return false;
    }
  }
  return true;
}

interface FireLeafContext {
  opts: PlanRuntimeSweeperOpts;
  plan: { plan_id: string; file_path: string };
  header: PlanRuntimeParsedHeader;
  parsedTasks: PlanRuntimeParsedTask[];
  byCanonicalKey: Map<string, PlanTaskRecord>;
  now: () => number;
}

async function fireLeaf(
  ctx: FireLeafContext,
  taskMeta: PlanRuntimeParsedTask,
): Promise<{ fired: boolean }> {
  const effectiveProject = taskMeta.project ?? ctx.header.home_project;
  try {
    const branchBase = await computeBranchBase({
      taskMeta,
      effectiveProject,
      planId: ctx.plan.plan_id,
      byCanonicalKey: ctx.byCanonicalKey,
      parsedTasks: ctx.parsedTasks,
      db: ctx.opts.db,
      worktreeManager: ctx.opts.worktreeManager,
      log: ctx.opts.log,
    });
    const allowAgents = [taskMeta.preferred_agent, taskMeta.fallback_agent].filter(
      (agent): agent is string => Boolean(agent),
    );
    const result = ctx.opts.taskWriter.file({
      kind: "orchestrate",
      project_id: effectiveProject,
      prompt: deriveLeafPrompt(taskMeta, ctx.header, ctx.plan.file_path),
      created_by_kind: "workflow",
      created_by_id: "plan-runtime",
      eligibility: { allow_agents: allowAgents },
      bounds: ctx.header.plan_defaults?.bounds ?? defaultBounds,
      branch_base: branchBase,
    });
    ctx.opts.plans.bindTaskToBoard(ctx.plan.plan_id, taskMeta.id, result.task_id);
    return { fired: true };
  } catch (error: unknown) {
    if (error instanceof OrchestrateAgentNotMaestroCapable) {
      const allowAgents = [taskMeta.preferred_agent, taskMeta.fallback_agent].filter(
        (agent): agent is string => Boolean(agent),
      );
      if (error.reason === "unknown") {
        ctx.opts.log?.warn?.(
          `[plan-runtime] cannot file leaf task ${ctx.plan.plan_id}/${taskMeta.id}: agent ${error.agent_name} not found in agentchat.yaml`,
        );
      } else {
        ctx.opts.log?.warn?.(
          `[plan-runtime] cannot file leaf task ${ctx.plan.plan_id}/${taskMeta.id}: agent ${error.agent_name} is not maestro_capable. Mark at least one of [${allowAgents.join(", ")}] with \`maestro_capable: true\` in ~/.config/agentchat/agentchat.yaml`,
        );
      }
    } else {
      ctx.opts.log?.warn?.("[plan-runtime] failed to file leaf task", {
        plan_id: ctx.plan.plan_id,
        task_meta_id: taskMeta.id,
        error: String(error),
      });
    }
    ctx.opts.plans.markTaskStatus(ctx.plan.plan_id, taskMeta.id, "failed", ctx.now());
    return { fired: false };
  }
}

async function fireReadyLeaves(
  opts: PlanRuntimeSweeperOpts,
  plan: { plan_id: string; file_path: string },
  parsed: PlanRuntimeParseResult & { header: PlanRuntimeParsedHeader },
  byCanonicalKey: Map<string, PlanTaskRecord>,
  tasks: PlanTaskRecord[],
  now: () => number,
  fired: string[],
): Promise<void> {
  for (const task of tasks) {
    if (task.status !== "pending" || task.task_id_in_board !== null) continue;

    const taskMeta = parsed.tasks.find((candidate) => candidate.id === task.task_meta_id);
    if (!taskMeta) continue;

    const effectiveProject = taskMeta.project ?? parsed.header.home_project;
    if (!isTaskReady(taskMeta, effectiveProject, byCanonicalKey)) continue;

    const outcome = await fireLeaf(
      {
        opts,
        plan,
        header: parsed.header,
        parsedTasks: parsed.tasks,
        byCanonicalKey,
        now,
      },
      taskMeta,
    );
    if (outcome.fired) fired.push(taskMeta.id);
  }
}

function finalizePlanStatus(opts: PlanRuntimeSweeperOpts, planId: string): void {
  const refreshedTasks = opts.plans.getTasks(planId);
  if (refreshedTasks.some((task) => task.status === "failed")) {
    opts.plans.markPlanStatus(planId, "failed");
    return;
  }
  if (refreshedTasks.length > 0 && refreshedTasks.every((task) => task.status === "completed")) {
    opts.plans.markPlanStatus(planId, "completed");
  }
}

async function processPlan(
  opts: PlanRuntimeSweeperOpts,
  plan: { plan_id: string; file_path: string },
  parsed: PlanRuntimeParseResult,
  now: () => number,
  fired: string[],
): Promise<void> {
  if (!parsed.header || parsed.errors.length > 0) {
    opts.log?.warn?.("[plan-runtime] invalid plan meta", {
      plan_id: plan.plan_id,
      file_path: plan.file_path,
      errors: parsed.errors,
    });
    return;
  }

  const tasks = opts.plans.getTasks(plan.plan_id);
  const byCanonicalKey = new Map<string, PlanTaskRecord>();
  for (const task of tasks) {
    byCanonicalKey.set(`${task.project_id}/${task.task_meta_id}`, task);
  }

  await fireReadyLeaves(
    opts,
    plan,
    { ...parsed, header: parsed.header },
    byCanonicalKey,
    tasks,
    now,
    fired,
  );
  finalizePlanStatus(opts, plan.plan_id);
}

// eslint-disable-next-line max-lines-per-function -- Preserve plan-runtime sweeper construction while grandfathering its pre-existing size.
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
  const parseFailureCounts = new Map<string, number>();
  const parsePlanFile = makeParsePlanFile(cache, planParser);
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let rerunRequested = false;
  let activeEventIterator: AsyncIterableIterator<TaskEvent> | null = null;

  async function runTickBody(): Promise<{ fired: string[] }> {
    const fired: string[] = [];
    const runningPlans = opts.plans.listPlans({ status: "running" });

    for (const plan of runningPlans) {
      let parsed: PlanRuntimeParseResult;
      try {
        parsed = await parsePlanFile(plan.file_path);
        parseFailureCounts.delete(plan.plan_id);
      } catch (error: unknown) {
        const isEnoent = (error as NodeJS.ErrnoException).code === "ENOENT";
        const attempts = (parseFailureCounts.get(plan.plan_id) ?? 0) + 1;
        parseFailureCounts.set(plan.plan_id, attempts);

        if (isEnoent || attempts >= PARSE_FAILURE_QUARANTINE_THRESHOLD) {
          const reason = isEnoent
            ? "plan file missing (ENOENT)"
            : `plan parse failed ${String(attempts)} consecutive times: ${String(error)}`;
          warnWithContext(
            opts.log,
            { plan_id: plan.plan_id, file_path: plan.file_path, error: String(error), reason },
            "[plan-runtime] quarantining plan after parse failure",
          );
          opts.plans.markPlanStatus(plan.plan_id, "failed");
          opts.db
            .query<unknown, [string, string, string]>(
              `INSERT INTO dispatch_events (handoff_id, worker_id, source, kind, ts, meta_json)
               VALUES (?, NULL, 'sweeper', 'plan.quarantined', ?, ?)`,
            )
            .run(
              plan.plan_id,
              new Date(now()).toISOString(),
              JSON.stringify({ plan_id: plan.plan_id, file_path: plan.file_path, reason }),
            );
          parseFailureCounts.delete(plan.plan_id);
        } else {
          opts.log?.warn?.("[plan-runtime] plan parse failed", {
            plan_id: plan.plan_id,
            file_path: plan.file_path,
            error: String(error),
            attempts,
          });
        }
        continue;
      }
      await processPlan(opts, plan, parsed, now, fired);
    }

    return { fired };
  }

  async function tick(): Promise<{ fired: string[] }> {
    if (running) {
      rerunRequested = true;
      return { fired: [] };
    }

    running = true;
    try {
      return await runTickBody();
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        void tick().catch((error: unknown) => {
          opts.log?.warn?.("[plan-runtime] coalesced tick failed", { error: String(error) });
        });
      }
    }
  }

  function handleTaskEvent(event: TaskEvent): void {
    const kind = event.kind;
    if (kind !== "completed" && kind !== "cancelled") return;

    const hit = opts.plans.findPlanTaskByBoardId(event.task_id);
    if (!hit) return;

    try {
      opts.plans.markTaskStatus(hit.plan_id, hit.task_meta_id, kind, event.at);
    } catch (error: unknown) {
      opts.log?.warn?.("[plan-runtime] failed to mark plan-task status from event", {
        event_task_id: event.task_id,
        event_kind: kind,
        error: String(error),
      });
      return;
    }

    void tick().catch((error: unknown) => {
      opts.log?.warn?.("[plan-runtime] immediate tick failed", { error: String(error) });
    });
  }

  function subscribe(bus: TaskEventBus): () => void {
    const iterator = bus.subscribe((event) => {
      const kind = event.kind;
      return kind === "completed" || kind === "cancelled";
    });
    activeEventIterator = iterator;
    void (async (): Promise<void> => {
      try {
        for await (const event of iterator) {
          handleTaskEvent(event);
        }
      } catch (error: unknown) {
        opts.log?.warn?.("[plan-runtime] task event loop failed", { error: String(error) });
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
        void tick().catch((error: unknown) => {
          opts.log?.warn?.("[plan-runtime] interval tick failed", { error: String(error) });
        });
      }, intervalMs);
      intervalHandle.unref();
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
