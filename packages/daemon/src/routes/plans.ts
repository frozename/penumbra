import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  PlanStatusSchema,
  derivePlanId,
  PlanAlreadyRegistered,
  PlanNotFound,
  type Services,
} from '@penumbra/core';
import { parsePlanMetaFile, validatePlan } from '@penumbra/workflows';
import { TaskNotFound, InvalidTaskStatus } from '../../../core/src/tasks/writer.js';
import type { TaskWriter } from '../../../core/src/tasks/writer.js';

import { json } from './_helpers.js';
const RegisterPlanRequestSchema = z.object({
  file_path: z.string().min(1),
}).strict();

const ListPlansQuerySchema = z.object({
  status: PlanStatusSchema.optional(),
}).strict();

async function safeJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function invalidInput(details: unknown): Response {
  return json({ error: 'invalid_input', details }, 400);
}

function knownAgentsFromServices(services: Services): Set<string> {
  const cfg = (services as Services & { agentchatConfig?: { agents?: Array<{ name: string }> } })
    .agentchatConfig;
  if (!cfg?.agents) return new Set<string>();
  return new Set(cfg.agents.map((a) => a.name));
}

export async function plansRegisterRoute(req: Request, services: Services): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = RegisterPlanRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { file_path } = parsed.data;

  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(file_path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return json({ error: 'plan_file_not_found', file_path }, 404);
    }
    throw err;
  }

  const parseResult = await parsePlanMetaFile(file_path);
  if (parseResult.errors.length > 0) {
    return json({
      error: 'parse_failed',
      details: parseResult.errors.map((e) => ({ line: e.line, reason: e.reason })),
    }, 400);
  }
  if (parseResult.tasks.length === 0) {
    return json({ error: 'no_tasks_found' }, 400);
  }

  const header = parseResult.header;
  if (!header?.home_project) {
    return json({ error: 'missing_home_project' }, 400);
  }
  const home_project = header.home_project;

  const knownAgents = knownAgentsFromServices(services);
  const validationErrors = await validatePlan(parseResult.tasks, {
    repoRoot: process.cwd(),
    knownAgents,
    projectRegistry: services.projectRegistry,
    header: { home_project },
  });
  if (validationErrors.length > 0) {
    return json({
      error: 'validation_failed',
      details: validationErrors.map((e) => ({
        task_id: e.task_id,
        rule: e.rule,
        message: e.message,
      })),
    }, 400);
  }

  const plan_id = derivePlanId(fileBytes, Date.now());

  try {
    services.planWriter.register({
      plan_id,
      file_path,
      home_project,
      tasks: parseResult.tasks.map((t) => ({
        task_meta_id: t.id,
        project_id: t.project ?? home_project,
      })),
    });
  } catch (err) {
    if (err instanceof PlanAlreadyRegistered) {
      return json({ error: 'plan_already_registered', plan_id: err.plan_id }, 409);
    }
    throw err;
  }

  return json({ plan_id, status: 'running' }, 201);
}

export async function plansListRoute(req: Request, services: Services): Promise<Response> {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status') ?? undefined;
  const parsed = ListPlansQuerySchema.safeParse({ status: statusParam });
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const plans = services.planWriter.listPlans({ status: parsed.data.status });
  return json({ plans });
}

export async function plansGetRoute(
  _req: Request,
  plan_id: string,
  services: Services,
): Promise<Response> {
  const plan = services.planWriter.getPlan(plan_id);
  if (!plan) {
    return json({ error: 'plan_not_found', plan_id }, 404);
  }
  const tasks = services.planWriter.getTasks(plan_id);
  return json({ plan, tasks });
}

export async function plansCancelRoute(
  _req: Request,
  plan_id: string,
  services: Services,
  taskWriter: TaskWriter,
): Promise<Response> {
  const tasksBefore = services.planWriter.getTasks(plan_id);

  try {
    services.planWriter.markPlanStatus(plan_id, 'cancelled');
  } catch (err) {
    if (err instanceof PlanNotFound) {
      return json({ error: 'plan_not_found', plan_id }, 404);
    }
    throw err;
  }

  let cancelled_running_count = 0;
  for (const t of tasksBefore) {
    if (t.status !== 'running' || !t.task_id_in_board) continue;
    try {
      taskWriter.cancel({ task_id: t.task_id_in_board, reason: 'plan_cancelled' });
      cancelled_running_count += 1;
    } catch (err) {
      if (err instanceof TaskNotFound || err instanceof InvalidTaskStatus) {
        services.log?.warn?.({
          err,
          plan_id,
          task_id_in_board: t.task_id_in_board,
        }, 'plan cancel: child task already terminal or missing');
        continue;
      }
      services.log?.warn?.({
        err,
        plan_id,
        task_id_in_board: t.task_id_in_board,
      }, 'plan cancel: child task cancel failed');
    }
  }

  return json({ plan_id, status: 'cancelled', cancelled_running_count });
}
