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
import { bodyJson, json } from './_helpers.js';
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
const CommentGhRequestSchema = z.object({
  body: z.string().min(1),
}).strict();

function noContent(): Response {
  return new Response(null, { status: 204 });
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

function queueTaskStatusSync(
  writer: TaskWriter,
  task_id: string,
  ghSync?: GhTaskSyncService,
  fromStatus?: string | null,
  toStatus?: string | null,
): void {
  if (!ghSync) return;
  const task = writer.get(task_id);
  if (!task.gh_issue_repo || !task.gh_issue_number) return;
  ghSync.queueStatusUpdate(task_id, fromStatus ?? null, toStatus ?? null);
}

export async function tasksFileRoute(
  req: Request,
  writer: TaskWriter,
  ghSync?: GhTaskSyncService,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = FileTaskInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const originHeader = req.headers.get('x-penumbra-origin');
  const input = originHeader
    ? { ...parsed.data, origin: originHeader }
    : parsed.data;

  let task_id = '';
  try {
    const result = writer.file(input);
    task_id = result.task_id;
  } catch (err) {
    return mapTaskError(err);
  }

  if (!input.gh_create) {
    return json({ task_id }, 201);
  }

  if (!ghSync) {
    writer.setGhCreateStatus(task_id, 'failed', 'github sync service unavailable');
    return json({ task_id, gh_create_status: 'failed', gh_create_error: 'github sync service unavailable' }, 201);
  }

  const issueTitle = input.gh_create.title ?? firstLine(input.prompt);
  const issueBody = input.gh_create.body ?? input.prompt;

  ghSync.enqueueTaskGhCreate(task_id, {
    repo: input.gh_create.repo,
    title: issueTitle,
    body: issueBody,
    labels: input.gh_create.labels,
    assignees: input.gh_create.assignees,
  });
  return json({
    task_id,
    gh_create_status: 'queued',
    gh_create_error: null,
  }, 201);
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
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = CancelTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const before = writer.get(task_id).status;
    const result = writer.cancel({ task_id, ...parsed.data });
    queueTaskStatusSync(writer, task_id, ghSync, before, result.status);
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
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = LinkGhRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    writer.linkGhIssue(task_id, parsed.data);
    ghSync.enqueueSyncLinkedTask(task_id);
    return json({
      task_id,
      gh_issue_url: buildGhIssueUrl(parsed.data.repo, parsed.data.issue_number),
      gh_state: 'queued',
      last_sync_ts: null,
      gh_sync_status: 'queued',
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
  const raw = await bodyJson(req);
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

export async function tasksLeaseRoute(
  req: Request,
  writer: TaskWriter,
  ghSync?: GhTaskSyncService,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = LeaseTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const leased = await writer.next(parsed.data);
    if (!leased) {
      // TODO(task 4.1): distinguish NotPreferred from empty queue when writer exposes it.
      return noContent();
    }
    queueTaskStatusSync(writer, leased.task_id, ghSync, 'pending', 'leased');
    return json(leased);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksHeartbeatRoute(req: Request, task_id: string, writer: TaskWriter): Promise<Response> {
  const raw = await bodyJson(req);
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
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = CompleteTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const before = writer.get(task_id).status;
    const result = writer.complete({ task_id, ...parsed.data });
    queueTaskStatusSync(writer, task_id, ghSync, before, result.status);
    if (ghSync && parsed.data.review_verdict) {
      const task = writer.get(task_id);
      if (task.gh_issue_repo && task.gh_issue_number) {
        ghSync.queueVerdictComment(task_id, parsed.data.review_verdict);
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
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = FailTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const before = writer.get(task_id).status;
    const result = writer.fail({ task_id, ...parsed.data });
    queueTaskStatusSync(writer, task_id, ghSync, before, result.status);
    if (ghSync) {
      const task = writer.get(task_id);
      if (task.gh_issue_repo && task.gh_issue_number) {
        ghSync.queueDispatchFailureComment(task_id, parsed.data.reason);
      }
    }
    return json(result);
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksCommentGhRoute(
  req: Request,
  task_id: string,
  ghSync: GhTaskSyncService,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: 'request body was not valid JSON' }]);

  const parsed = CommentGhRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const out = await ghSync.postManualComment(task_id, parsed.data.body);
    if (!out) {
      return json({ error: 'task_not_linked_gh', task_id }, 409);
    }
    return json(out);
  } catch (err) {
    const msg = errorMessage(err).toLowerCase();
    if (msg.includes('github client unavailable') || msg.includes('no such file or directory') || msg.includes('command not found')) {
      return json({ error: 'github_client_unavailable' }, 503);
    }
    return mapTaskError(err);
  }
}

function buildGhIssueUrl(repo: string, issue_number: number): string {
  return `https://github.com/${repo}/issues/${issue_number}`;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim();
  return line && line.length > 0 ? line : text;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return String(err);
}
