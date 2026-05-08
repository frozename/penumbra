import { z } from 'zod';
import {
  FileTaskInputSchema,
  TaskStatusSchema,
  TaskKindSchema,
  CompleteTaskInputSchema,
  HeartbeatTaskInputSchema,
  FailTaskInputSchema,
  CancelTaskInputSchema,
} from '../../../core/src/tasks/schema.js';
import {
  TaskWriter,
  TaskNotFound,
  InvalidTaskStatus,
  LeaseInvalid,
  LeaseConflict,
  MissingReviewVerdict,
  UnexpectedReviewVerdict,
  ReviewParentInvalidState,
  type TaskInclude,
} from '../../../core/src/tasks/writer.js';
import { EmitCapExceeded } from '../../../core/src/tasks/emit-caps.js';
import type { GhTaskSyncService, GhTaskSyncSummary } from '../sweepers/gh-task-sync.js';

const TaskIncludeSchema = z.enum(['lease', 'events', 'descendants']);

const ListTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  kind: TaskKindSchema.optional(),
  eligible_for: z.string().min(1).optional(),
  parent_task_id: z.string().min(1).optional(),
  origin: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
}).strict();

const LeaseTaskRequestSchema = z.object({
  agent_id: z.string().min(1),
  tags: z.array(z.string()).optional(),
  max_cost_cents: z.number().nonnegative().optional(),
}).strict();

const HeartbeatTaskRequestSchema = HeartbeatTaskInputSchema.omit({ task_id: true });
const CompleteTaskRequestSchema = CompleteTaskInputSchema.omit({ task_id: true });
const FailTaskRequestSchema = FailTaskInputSchema.omit({ task_id: true });
const CancelTaskRequestSchema = CancelTaskInputSchema.omit({ task_id: true });
const LinkGhRequestSchema = z.object({
  repo: z.string().min(1),
  issue_number: z.number().int().positive(),
}).strict();
const SyncGhRequestSchema = z.object({
  task_id: z.string().min(1).optional(),
}).strict();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

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

function mapTaskError(err: unknown): Response {
  if (err instanceof TaskNotFound) {
    return json({ error: 'task_not_found', task_id: err.task_id }, 404);
  }
  if (
    err instanceof InvalidTaskStatus
    || err instanceof LeaseInvalid
    || err instanceof LeaseConflict
    || err instanceof MissingReviewVerdict
    || err instanceof UnexpectedReviewVerdict
    || err instanceof ReviewParentInvalidState
  ) {
    return json({ error: err.name, message: err.message }, 409);
  }
  if (err instanceof EmitCapExceeded) {
    return json({
      error: err.name,
      scope: err.scope,
      limit: err.limit,
      observed: err.observed,
    }, 429);
  }
  throw err;
}

function parseIncludeParam(url: URL): TaskInclude[] | Response {
  const includeParam = url.searchParams.get('include');
  if (!includeParam) return [];
  const items = includeParam
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const parsed = z.array(TaskIncludeSchema).safeParse(items);
  if (!parsed.success) {
    return invalidInput(parsed.error.issues);
  }
  return [...new Set(parsed.data)];
}

export async function tasksFileRoute(req: Request, writer: TaskWriter): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = FileTaskInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const originHeader = req.headers.get('x-penumbra-origin');
  const input = originHeader
    ? { ...parsed.data, origin: originHeader }
    : parsed.data;

  try {
    const result = writer.file(input);
    return json(result, 201);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksListRoute(req: Request, writer: TaskWriter): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ListTasksQuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    eligible_for: url.searchParams.get('eligible_for') ?? undefined,
    parent_task_id: url.searchParams.get('parent_task_id') ?? undefined,
    origin: url.searchParams.get('origin') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? undefined,
  });
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const tasks = writer.list(parsed.data);
    return json({ tasks });
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksGetRoute(req: Request, task_id: string, writer: TaskWriter): Promise<Response> {
  const url = new URL(req.url);
  const include = parseIncludeParam(url);
  if (include instanceof Response) return include;

  try {
    const task = writer.get(task_id, include.length > 0 ? { include } : undefined);
    return json(task);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksCancelRoute(
  req: Request,
  task_id: string,
  writer: TaskWriter,
  ghSync?: GhTaskSyncService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = CancelTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const result = writer.cancel({ task_id, ...parsed.data });
    if (ghSync) {
      const sync = await ghSync.pushStatusNow(task_id);
      if (sync?.action === 'error') {
        writer.touch(task_id);
      }
    }
    return json(result);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksLinkGhRoute(
  req: Request,
  task_id: string,
  writer: TaskWriter,
  ghSync: GhTaskSyncService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = LinkGhRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    writer.linkGhIssue(task_id, parsed.data);
    const sync = await ghSync.syncLinkedTask(task_id);
    return json({
      task_id,
      gh_issue_url: buildGhIssueUrl(parsed.data.repo, parsed.data.issue_number),
      gh_state: sync.gh_state,
      last_sync_ts: sync.last_sync_ts,
    });
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksUnlinkGhRoute(
  _req: Request,
  task_id: string,
  writer: TaskWriter,
): Promise<Response> {
  try {
    writer.unlinkGhIssue(task_id);
    return json({ ok: true });
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksSyncGhNowRoute(
  req: Request,
  ghSync: GhTaskSyncService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = SyncGhRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  if (parsed.data.task_id) {
    const result = await ghSync.pushStatusNow(parsed.data.task_id);
    if (!result) {
      return json({
        linked: 0,
        pushed: 0,
        pulled: 0,
        errored: 0,
        skipped: false,
        results: [],
      });
    }
    const summary: GhTaskSyncSummary = {
      linked: 1,
      pushed: result.action === 'pushed' ? 1 : 0,
      pulled: result.action === 'pulled' ? 1 : 0,
      errored: result.action === 'error' ? 1 : 0,
      skipped: false,
      results: [result],
    };
    return json(summary);
  }

  return json(await ghSync.syncAllLinkedTasks());
}

export async function tasksLeaseRoute(req: Request, writer: TaskWriter): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = LeaseTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const leased = await writer.next(parsed.data);
    if (!leased) {
      // TODO(task 4.1): distinguish NotPreferred from empty queue when writer exposes it.
      return noContent();
    }
    return json(leased);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksHeartbeatRoute(req: Request, task_id: string, writer: TaskWriter): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = HeartbeatTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const result = writer.heartbeat({ task_id, ...parsed.data });
    return json(result);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksCompleteRoute(
  req: Request,
  task_id: string,
  writer: TaskWriter,
  ghSync?: GhTaskSyncService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = CompleteTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const result = writer.complete({ task_id, ...parsed.data });
    if (ghSync) {
      const sync = await ghSync.pushStatusNow(task_id);
      if (sync?.action === 'error') {
        writer.touch(task_id);
      }
    }
    return json(result);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksFailRoute(
  req: Request,
  task_id: string,
  writer: TaskWriter,
  ghSync?: GhTaskSyncService,
): Promise<Response> {
  const raw = await safeJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = FailTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const result = writer.fail({ task_id, ...parsed.data });
    if (ghSync) {
      const sync = await ghSync.pushStatusNow(task_id);
      if (sync?.action === 'error') {
        writer.touch(task_id);
      }
    }
    return json(result);
  } catch (err) {
    return mapTaskError(err);
  }
}

function buildGhIssueUrl(repo: string, issue_number: number): string {
  return `https://github.com/${repo}/issues/${issue_number}`;
}
