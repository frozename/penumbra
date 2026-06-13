import { z } from "zod";
// Deep import (core/src, not the @penumbra/core barrel): the barrel's built .d.ts
// lags newly-added exports, so the daemon typecheck wouldn't see this function.
import { getTaskDraftPromotionInfo } from "../../../core/src/readers/task-draft.js";
import {
  FileTaskInputSchema,
  TaskStatusSchema,
  TaskKindSchema,
  CompleteTaskInputSchema,
  HeartbeatTaskInputSchema,
  FailTaskInputSchema,
  CancelTaskInputSchema,
  TaskWriter,
  TaskNotFound,
  InvalidTaskStatus,
  LeaseInvalid,
  LeaseConflict,
  MissingReviewVerdict,
  UnexpectedReviewVerdict,
  ReviewParentInvalidState,
  type TaskInclude,
  EmitCapExceeded,
  type Services,
  TaskDraftPromotedPayloadSchema,
  getGithubRepo,
} from "@penumbra/core";
import { getPrincipal } from "../auth.js";
import type { GhTaskSyncService, GhTaskSyncSummary } from "../sweepers/gh-task-sync.js";
import { bodyJson, json } from "./_helpers.js";
const TaskIncludeSchema = z.enum(["lease", "events", "descendants"]);

const ListTasksQuerySchema = z
  .object({
    status: TaskStatusSchema.optional(),
    kind: TaskKindSchema.optional(),
    eligible_for: z.string().min(1).optional(),
    parent_task_id: z.string().min(1).optional(),
    origin: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

const LeaseTaskRequestSchema = z
  .object({
    agent_id: z.string().min(1),
    tags: z.array(z.string()).optional(),
    max_cost_cents: z.number().nonnegative().optional(),
  })
  .strict();

const HeartbeatTaskRequestSchema = HeartbeatTaskInputSchema.omit({ task_id: true });
const CompleteTaskRequestSchema = CompleteTaskInputSchema.omit({
  task_id: true,
  lease_id: true,
}).extend({
  lease_id: z.string().optional(),
});
const FailTaskRequestSchema = FailTaskInputSchema.omit({ task_id: true });
const CancelTaskRequestSchema = CancelTaskInputSchema.omit({ task_id: true });
const LinkGhRequestSchema = z
  .object({
    repo: z.string().min(1),
    issue_number: z.number().int().positive(),
  })
  .strict();
const SyncGhRequestSchema = z
  .object({
    task_id: z.string().min(1).optional(),
  })
  .strict();
const CommentGhRequestSchema = z
  .object({
    body: z.string().min(1),
  })
  .strict();
const DRAFT_ORIGIN_RE = /^draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUSTED_PROMOTERS = new Set([
  "maestro",
  "task-refiner-primary",
  "task-refiner-escalation",
  "claude",
]);
const DEFAULT_ORCHESTRATE_ALLOW_AGENT = "openai-codex-deep-acp";

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function invalidInput(details: unknown): Response {
  return json({ error: "invalid_input", details }, 400);
}

function mapTaskError(err: unknown): Response {
  if (err instanceof TaskNotFound) {
    return json({ error: "task_not_found", task_id: err.task_id }, 404);
  }
  if (
    err instanceof InvalidTaskStatus ||
    err instanceof LeaseInvalid ||
    err instanceof MissingReviewVerdict ||
    err instanceof UnexpectedReviewVerdict ||
    err instanceof ReviewParentInvalidState
  ) {
    return json({ error: err.name, message: err.message }, 409);
  }
  if (err instanceof LeaseConflict) {
    return json(
      { error: err.name, message: err.message, active_lease_id: err.active_lease_id ?? null },
      409,
    );
  }
  if (err instanceof EmitCapExceeded) {
    return json(
      {
        error: err.name,
        scope: err.scope,
        limit: err.limit,
        observed: err.observed,
      },
      429,
    );
  }
  throw err;
}

function parseIncludeParam(url: URL): TaskInclude[] | Response {
  const includeParam = url.searchParams.get("include");
  if (!includeParam) return [];
  const items = includeParam
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const parsed = z.array(TaskIncludeSchema).safeParse(items);
  if (!parsed.success) {
    return invalidInput(parsed.error.issues);
  }
  return [...new Set(parsed.data)];
}

// Status-transition → gh_outbox enqueue is centralized in TaskWriter
// (complete/fail/cancel/lease/next) so every caller — routes, maestro
// orchestration, plan cancellation, lease expiry — stays in sync without each
// path remembering to call the gh-task-sync service. Routes therefore only
// enqueue the route-specific extras below (verdict / dispatch-failure comments,
// issue creation, manual link/push).

export async function tasksFileRoute(
  req: Request,
  writer: TaskWriter,
  services: Pick<
    Services,
    | "db"
    | "projectRegistry"
    | "taskDraftReader"
    | "t0Writer"
    | "uuid"
    | "clock"
    | "machineId"
    | "log"
  >,
  ghSync?: GhTaskSyncService,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = FileTaskInputSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const originHeader = req.headers.get("x-penumbra-origin");
  const input = originHeader ? { ...parsed.data, origin: originHeader } : parsed.data;
  const origin = input.origin;
  if (typeof origin === "string" && origin.startsWith("draft:") && !DRAFT_ORIGIN_RE.test(origin)) {
    return invalidInput([
      { message: "origin: draft:<uuid> requires a valid UUID suffix", path: ["origin"] },
    ]);
  }
  const isRefinerPromotion = typeof origin === "string" && DRAFT_ORIGIN_RE.test(origin);
  let inputForFile = input;
  if (isRefinerPromotion) {
    const draftId = origin.slice("draft:".length).toLowerCase();
    const info = getTaskDraftPromotionInfo(services.db, draftId);
    if (!info.exists) {
      return invalidInput([{ message: "origin draft not found", path: ["origin"] }]);
    }
    if (info.already_promoted) {
      return json({ task_id: null, error: "draft already promoted" }, 409);
    }
    const autoPromote =
      info.auto_ok === true &&
      info.filed_by_agent !== null &&
      TRUSTED_PROMOTERS.has(info.filed_by_agent);
    if (autoPromote) {
      const allowAgents =
        input.eligibility?.allow_agents?.length && input.eligibility.allow_agents.length > 0
          ? input.eligibility.allow_agents
          : [DEFAULT_ORCHESTRATE_ALLOW_AGENT];
      inputForFile = {
        ...input,
        kind: "orchestrate",
        eligibility: { ...(input.eligibility ?? {}), allow_agents: allowAgents },
      };
    }
  }
  const inputWithDefaults =
    isRefinerPromotion && !inputForFile.gh_create
      ? {
          ...inputForFile,
          gh_create: { labels: ["task-draft", "refiner-promoted"] },
        }
      : inputForFile;

  let task_id = "";
  try {
    const result = writer.file(inputWithDefaults);
    task_id = result.task_id;
  } catch (err) {
    return mapTaskError(err);
  }

  if (isRefinerPromotion) {
    const draftId = origin.slice("draft:".length).toLowerCase();
    try {
      const payload = TaskDraftPromotedPayloadSchema.parse({
        draft_id: draftId,
        task_ids: [task_id],
      });
      const now = services.clock().toISOString();
      services.t0Writer.write({
        event_id: services.uuid(),
        ts: now,
        ingest_ts: now,
        source: "daemon",
        source_detail: "task_file:refiner_promoted",
        project_id: input.project_id ?? null,
        user_id: services.machineId.get(),
        machine_id: services.machineId.get(),
        session_id: null,
        event_type: "task_draft_promoted",
        lane: "unknown",
        provider: null,
        model: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        latency_ms: null,
        request_id: null,
        payload_json: payload,
        payload_summary: null,
        origin: null,
      });
    } catch (err) {
      services.log?.warn?.(
        { err: String(err), task_id, draft_id: draftId },
        "task_file: failed to emit task_draft_promoted",
      );
    }
  }

  if (!inputWithDefaults.gh_create) {
    return json({ task_id }, 201);
  }

  let effectiveRepo = inputWithDefaults.gh_create.repo ?? null;
  if (!effectiveRepo) {
    const projectId = inputWithDefaults.project_id ?? null;
    if (projectId) {
      const entry = services.projectRegistry?.get(projectId);
      effectiveRepo = getGithubRepo(entry) ?? null;
    }
  }
  if (!effectiveRepo) {
    writer.setGhCreateStatus(
      task_id,
      "failed",
      "gh_create.repo missing and project_registry has no gh_repo for project_id",
    );
    return json(
      {
        task_id,
        gh_create_status: "failed",
        gh_create_error:
          "gh_create.repo missing and project_registry has no gh_repo for project_id",
      },
      201,
    );
  }

  if (!ghSync) {
    writer.setGhCreateStatus(task_id, "failed", "github sync service unavailable");
    return json(
      { task_id, gh_create_status: "failed", gh_create_error: "github sync service unavailable" },
      201,
    );
  }

  const issueTitle = inputWithDefaults.gh_create.title ?? conciseTitle(inputWithDefaults.prompt);
  const issueBody = inputWithDefaults.gh_create.body ?? inputWithDefaults.prompt;

  ghSync.enqueueTaskGhCreate(task_id, {
    repo: effectiveRepo,
    title: issueTitle,
    body: issueBody,
    labels: inputWithDefaults.gh_create.labels,
    assignees: inputWithDefaults.gh_create.assignees,
  });
  return json(
    {
      task_id,
      gh_create_status: "queued",
      gh_create_error: null,
    },
    201,
  );
}

export async function tasksListRoute(req: Request, writer: TaskWriter): Promise<Response> {
  const url = new URL(req.url);
  const parsed = ListTasksQuerySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    kind: url.searchParams.get("kind") ?? undefined,
    eligible_for: url.searchParams.get("eligible_for") ?? undefined,
    parent_task_id: url.searchParams.get("parent_task_id") ?? undefined,
    origin: url.searchParams.get("origin") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
  });
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const tasks = writer.list(parsed.data);
    return json({ tasks });
  } catch (err) {
    return mapTaskError(err);
  }
}

export async function tasksGetRoute(
  req: Request,
  task_id: string,
  writer: TaskWriter,
): Promise<Response> {
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
  _ghSync?: GhTaskSyncService, // status sync now enqueued by TaskWriter.cancel; kept for signature symmetry
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = CancelTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const result = writer.cancel({ task_id, ...parsed.data });
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
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = LinkGhRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    writer.linkGhIssue(task_id, parsed.data);
    ghSync.enqueueSyncLinkedTask(task_id);
    return json({
      task_id,
      gh_issue_url: buildGhIssueUrl(parsed.data.repo, parsed.data.issue_number),
      gh_state: "queued",
      last_sync_ts: null,
      gh_sync_status: "queued",
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
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

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
      pushed: result.action === "pushed" ? 1 : 0,
      pulled: result.action === "pulled" ? 1 : 0,
      errored: result.action === "error" ? 1 : 0,
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
  _ghSync?: GhTaskSyncService, // status sync now enqueued by TaskWriter.next; kept for signature symmetry
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

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

export async function tasksHeartbeatRoute(
  req: Request,
  task_id: string,
  writer: TaskWriter,
): Promise<Response> {
  const raw = await bodyJson(req);
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

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
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = CompleteTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const principal = getPrincipal(req);
  if (!principal) {
    return json(
      {
        error: "unauthorized",
        message: "this route requires a bearer principal",
      },
      401,
    );
  }
  if (principal?.kind === "worker" && parsed.data.lease_id === undefined) {
    return json(
      {
        error: "worker_token_required",
        message: "this route requires a lease_id for worker-token principals",
      },
      403,
    );
  }

  try {
    // Positive allowlist: only the shared (operator/maestro) principal may
    // complete without a lease; any future principal kind must opt in here.
    if (principal.kind === "shared" && parsed.data.lease_id === undefined) {
      const result = writer.completeWithoutLease(
        { task_id, ...parsed.data },
        principalActor(principal),
      );
      return json(result);
    }

    const result = writer.complete({ task_id, ...parsed.data, lease_id: parsed.data.lease_id! });
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
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = FailTaskRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const result = writer.fail({ task_id, ...parsed.data });
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
  if (raw === null) return invalidInput([{ message: "request body was not valid JSON" }]);

  const parsed = CommentGhRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  try {
    const out = await ghSync.postManualComment(task_id, parsed.data.body);
    if (!out) {
      return json({ error: "task_not_linked_gh", task_id }, 409);
    }
    return json(out);
  } catch (err) {
    const msg = errorMessage(err).toLowerCase();
    if (
      msg.includes("github client unavailable") ||
      msg.includes("no such file or directory") ||
      msg.includes("command not found")
    ) {
      return json({ error: "github_client_unavailable" }, 503);
    }
    return mapTaskError(err);
  }
}

function principalActor(principal: NonNullable<ReturnType<typeof getPrincipal>>): string {
  if (principal.kind === "shared") return `shared:${principal.via}`;
  return `worker:${principal.worker_id}`;
}

function buildGhIssueUrl(repo: string, issue_number: number): string {
  return `https://github.com/${repo}/issues/${issue_number}`;
}

export function conciseTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (!collapsed) return "task";

  const sentenceMatch = collapsed.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch) {
    const sentence = sentenceMatch[1]!.trim();
    if (sentence.length <= 100) return sentence;
  }

  if (collapsed.length <= 100) return collapsed;

  const truncated = collapsed.slice(0, 100);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trimEnd()}…`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return String(err);
}
