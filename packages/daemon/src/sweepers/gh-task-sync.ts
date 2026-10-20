import type { Database } from "bun:sqlite";

import type { GhClient, GhIssueComment, GhIssueState } from "../services/gh-client.js";
import type { GhReconcileCursorStore } from "./gh-task-sync-scope.js";

import { createGhCliClient } from "../services/gh-client.js";
import { formatPenumbraComment, isPenumbraAuthoredComment } from "../services/gh-comment-format.js";
import { createGhReconcileCursorStore, planChangedOnlyReconcile } from "./gh-task-sync-scope.js";

type PushCloseReason = "completed" | "not planned";

export interface GhTaskSyncResult {
  task_id: string;
  repo: string;
  issue_number: number;
  gh_state: GhIssueState;
  action: "noop" | "pushed" | "pulled" | "error" | "already_in_progress";
  direction?: "push" | "pull";
  error?: string;
  last_sync_ts: string;
}

export interface GhTaskSyncSummary {
  linked: number;
  pushed: number;
  pulled: number;
  errored: number;
  skipped: boolean;
  results: GhTaskSyncResult[];
}

export type GhTaskSyncAllOptions = { fullReconcile?: boolean; changedOnly?: boolean };

export interface GhTaskSyncService {
  syncLinkedTask(task_id: string): Promise<GhTaskSyncResult>;
  syncAllLinkedTasks(options?: GhTaskSyncAllOptions): Promise<GhTaskSyncSummary>;
  pushStatusNow(task_id: string): Promise<GhTaskSyncResult | null>;
  enqueueTaskGhCreate(
    task_id: string,
    input: {
      repo: string;
      title: string;
      body: string;
      labels?: string[];
      assignees?: string[];
    },
  ): void;
  enqueueSyncLinkedTask(task_id: string): void;
  queueVerdictComment(task_id: string, verdict: { passed: boolean; notes: string }): void;
  queueDispatchFailureComment(task_id: string, reason: string): void;
  postStatusChangeComment(
    task_id: string,
    from_status: string,
    to_status: string,
  ): Promise<{ comment_url: string } | null>;
  postManualComment(task_id: string, body: string): Promise<{ comment_url: string } | null>;
  postVerdictComment(
    task_id: string,
    verdict: { passed: boolean; notes: string },
  ): Promise<{ comment_url: string } | null>;
  postDispatchFailureComment(
    task_id: string,
    reason: string,
  ): Promise<{ comment_url: string } | null>;
}

interface GhTaskSyncServiceOpts {
  taskWriter: {
    get(task_id: string): TaskRecordLike;
    cancel(input: { task_id: string; reason?: string }): { status: string };
    completeWithoutLease(
      input: { task_id: string; result_summary: string },
      actor: string,
    ): { status: string };
    reopenFromGh(task_id: string): { status: "pending" };
    linkGhIssue(
      task_id: string,
      opts: { repo: string; issue_number: number },
    ): { task_id: string; gh_issue_repo: string; gh_issue_number: number };
    listLinkedTasks(): TaskRecordLike[];
    setGhLastCommentId(
      task_id: string,
      comment_id: string,
    ): { task_id: string; gh_last_comment_id: string };
    setGhCommentsSyncedAt(
      task_id: string,
      synced_at: number,
    ): { task_id: string; gh_comments_synced_at: number };
    setGhCreateStatus(
      task_id: string,
      status: "queued" | "pending" | "created" | "failed",
      error?: string | null,
    ): { task_id: string; gh_create_status: string; gh_create_error: string | null };
    enqueueGhOutbox(
      task_id: string,
      op:
        | "gh_create_issue"
        | "gh_sync_linked_task"
        | "gh_push_status"
        | "gh_post_status_comment"
        | "gh_post_verdict_comment"
        | "gh_post_dispatch_failure_comment",
      payload: unknown,
    ): { id: number };
    listPendingGhOutbox(limit?: number): {
      id: number;
      task_id: string;
      op:
        | "gh_create_issue"
        | "gh_sync_linked_task"
        | "gh_push_status"
        | "gh_post_status_comment"
        | "gh_post_verdict_comment"
        | "gh_post_dispatch_failure_comment";
      payload_json: string;
    }[];
    markGhOutboxAttempt(id: number): boolean;
    requeueStaleGhOutboxProcessing(staleBefore: number): number;
    markGhOutboxDone(id: number): void;
    markGhOutboxFailed(id: number, error: string): void;
  };
  ghClient?: GhClient;
  reconcileCursors?: GhReconcileCursorStore;
  t0Writer: {
    write(event: {
      event_id: string;
      ts: string;
      ingest_ts: string;
      source: string;
      source_detail: string | null;
      project_id: string | null;
      user_id: string;
      machine_id: string;
      session_id: string | null;
      event_type: string;
      lane: string;
      provider: string | null;
      model: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
      cost_usd: number | null;
      latency_ms: number | null;
      request_id: string | null;
      payload_json: unknown;
      payload_summary: string | null;
      origin?: string | null;
    }): void;
  };
  now: () => Date;
  uuid: () => string;
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
  userId?: string;
  machineId?: string;
  /**
   * Idempotency probe for the gh_create_issue path. Before calling
   * ghClient.createIssue, the outbox processor invokes this with the repo and
   * a retry-stable marker embedded in the issue body. If a prior attempt
   * already created the issue but crashed before linkGhIssue ran (later
   * requeued by requeueStaleGhOutboxProcessing), this lookup must return that
   * issue so we link it instead of creating a duplicate. When absent, the
   * pre-fix at-least-once behavior is preserved.
   */
  findOpenIssueByMarker?: (repo: string, marker: string) => Promise<{ number: number } | null>;
}

type TaskStatusLike =
  | "pending"
  | "leased"
  | "done_pending_review"
  | "done"
  | "failed"
  | "cancelled";

interface TaskRecordLike {
  id: string;
  project_id: string | null;
  updated_at: number;
  status: TaskStatusLike;
  gh_issue_repo?: string | null;
  gh_issue_number?: number | null;
  gh_last_comment_id?: string | null;
  gh_comments_synced_at?: number | null;
}

interface SyncDecision {
  desiredGhState: GhIssueState;
  closeReason: PushCloseReason | null;
}

const GH_TASK_SYNC_BATCH_SIZE = 6;
const GH_OUTBOX_PROCESSING_STALE_MS_DEFAULT = 10 * 60 * 1000;

type UnrefableTimer = ReturnType<typeof setInterval> & { unref?: () => void };

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const unrefable = timer as UnrefableTimer;
  if (typeof unrefable.unref === "function") unrefable.unref();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw || "{}");
  return isRecord(parsed) ? parsed : {};
}

function toDecision(status: TaskStatusLike): SyncDecision {
  switch (status) {
    case "pending":
    case "leased":
    case "done_pending_review":
      return { desiredGhState: "OPEN", closeReason: null };
    case "done":
      return { desiredGhState: "CLOSED", closeReason: "completed" };
    case "failed":
    case "cancelled":
      return { desiredGhState: "CLOSED", closeReason: "not planned" };
  }
}

function isoToMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildIssueUrl(repo: string, issue_number: number): string {
  return `https://github.com/${repo}/issues/${String(issue_number)}`;
}

function isLinked(
  task: TaskRecordLike,
): task is TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number } {
  return (
    typeof task.gh_issue_repo === "string" &&
    task.gh_issue_repo.length > 0 &&
    typeof task.gh_issue_number === "number" &&
    Number.isInteger(task.gh_issue_number) &&
    task.gh_issue_number > 0
  );
}

function writePulledEvent(opts: {
  t0Writer: GhTaskSyncServiceOpts["t0Writer"];
  nowIso: string;
  uuid: () => string;
  task: TaskRecordLike;
  gh_state: GhIssueState;
  gh_updated_at: string;
  repo: string;
  issue_number: number;
  userId: string;
  machineId: string;
}): void {
  opts.t0Writer.write({
    event_id: `evt_${opts.uuid().toLowerCase()}`,
    ts: opts.nowIso,
    ingest_ts: opts.nowIso,
    source: "daemon",
    source_detail: "gh-task-sync",
    project_id: opts.task.project_id,
    user_id: opts.userId,
    machine_id: opts.machineId,
    session_id: null,
    event_type: "task.gh_state_pulled",
    lane: "system",
    provider: "github",
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      task_id: opts.task.id,
      from_status: opts.task.status,
      gh_state: opts.gh_state,
      gh_updated_at: opts.gh_updated_at,
      gh_issue_repo: opts.repo,
      gh_issue_number: opts.issue_number,
    },
    payload_summary: `Pulled GH issue ${opts.repo}#${String(opts.issue_number)} state=${opts.gh_state} into task ${opts.task.id}`,
    origin: "dispatch",
  });
}

function toIsoFromMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

function isCommentAfterLastSeen(comment: GhIssueComment, lastSeenId: string | null): boolean {
  if (!lastSeenId) return true;
  if (comment.id === lastSeenId) return false;
  const current = Number(comment.id);
  const previous = Number(lastSeenId);
  if (!Number.isNaN(current) && !Number.isNaN(previous)) {
    return current > previous;
  }
  return true;
}

function pickMaxCommentId(comments: GhIssueComment[]): string | null {
  let maxNumeric = -1;
  let maxNumericRaw: string | null = null;
  let maxLex: string | null = null;
  for (const comment of comments) {
    const n = Number(comment.id);
    if (!Number.isNaN(n) && n > maxNumeric) {
      maxNumeric = n;
      maxNumericRaw = comment.id;
    }
    if (maxLex === null || comment.id > maxLex) {
      maxLex = comment.id;
    }
  }
  return maxNumericRaw ?? maxLex;
}

function writeInboundCommentEvent(opts: {
  t0Writer: GhTaskSyncServiceOpts["t0Writer"];
  uuid: () => string;
  nowIso: string;
  task: TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number };
  comment: GhIssueComment;
  userId: string;
  machineId: string;
}): void {
  opts.t0Writer.write({
    event_id: `evt_${opts.uuid().toLowerCase()}`,
    ts: opts.comment.created_at || opts.nowIso,
    ingest_ts: opts.nowIso,
    source: "daemon",
    source_detail: "gh-task-sync",
    project_id: opts.task.project_id,
    user_id: opts.userId,
    machine_id: opts.machineId,
    session_id: null,
    event_type: "gh_issue_comment",
    lane: "system",
    provider: "github",
    model: null,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    latency_ms: null,
    request_id: null,
    payload_json: {
      task_id: opts.task.id,
      gh_repo: opts.task.gh_issue_repo,
      gh_issue_number: opts.task.gh_issue_number,
      comment_id: opts.comment.id,
      author_login: opts.comment.author_login,
      body: opts.comment.body,
      created_at: opts.comment.created_at,
      url: opts.comment.url,
      source: "gh_comment",
      trust: "untrusted",
    },
    payload_summary: `GitHub comment ${opts.comment.id} mirrored to task ${opts.task.id} (${opts.task.gh_issue_repo}#${String(opts.task.gh_issue_number)})`,
    origin: "dispatch",
  });
}

async function pushToGh(args: {
  task: TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number };
  ghState: GhIssueState;
  client: GhClient;
}): Promise<void> {
  const decision = toDecision(args.task.status);
  if (decision.desiredGhState === args.ghState) return;
  if (decision.desiredGhState === "OPEN") {
    await args.client.reopenIssue(args.task.gh_issue_repo, args.task.gh_issue_number);
    return;
  }
  if (decision.closeReason === null) return;
  await args.client.closeIssue(
    args.task.gh_issue_repo,
    args.task.gh_issue_number,
    decision.closeReason,
  );
}

function createErrorResult(
  task: TaskRecordLike,
  message: string,
  nowIso: string,
): GhTaskSyncResult {
  return {
    task_id: task.id,
    repo: task.gh_issue_repo ?? "",
    issue_number: task.gh_issue_number ?? 0,
    gh_state: "OPEN",
    action: "error",
    error: message,
    last_sync_ts: nowIso,
  };
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

async function runInBatches<T, R>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((item) => worker(item)));
    results.push(...batchResults);
  }
  return results;
}

function skippedGhTaskSyncSummary(): GhTaskSyncSummary {
  return { linked: 0, pushed: 0, pulled: 0, errored: 0, skipped: true, results: [] };
}

export function createGhTaskSyncSingleFlight(
  service: GhTaskSyncService,
  log?: { warn?: (obj: unknown, msg?: string) => void },
): GhTaskSyncService {
  let inFlight = false;
  return {
    ...service,
    async syncAllLinkedTasks(options?: GhTaskSyncAllOptions): Promise<GhTaskSyncSummary> {
      if (inFlight) {
        log?.warn?.(
          { event: "gh-task-sync.skip_in_flight", sweeper: "gh-task-sync" },
          "gh-task-sync.skip_in_flight",
        );
        return skippedGhTaskSyncSummary();
      }
      inFlight = true;
      try {
        return await service.syncAllLinkedTasks(options);
      } finally {
        inFlight = false;
      }
    },
  };
}

type GhOutboxRow = ReturnType<GhTaskSyncServiceOpts["taskWriter"]["listPendingGhOutbox"]>[number];
type LinkedTaskRecord = TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number };
type CommentInput = Parameters<typeof formatPenumbraComment>[0];

interface GhTaskSyncRuntime {
  opts: GhTaskSyncServiceOpts;
  ghClient: GhClient;
  userId: string;
  machineId: string;
  knownPenumbraLogin: string | null | undefined;
  inFlightByTask: Set<string>;
  inFlightOutboxIds: Set<number>;
}

function createGhTaskSyncRuntime(opts: GhTaskSyncServiceOpts): GhTaskSyncRuntime {
  return {
    opts,
    ghClient: opts.ghClient ?? createGhCliClient(),
    userId: opts.userId ?? "penumbra",
    machineId: opts.machineId ?? process.env.HOSTNAME ?? "unknown",
    knownPenumbraLogin: undefined,
    inFlightByTask: new Set(),
    inFlightOutboxIds: new Set(),
  };
}

async function resolvePenumbraLogin(runtime: GhTaskSyncRuntime): Promise<string | null> {
  if (runtime.knownPenumbraLogin !== undefined) return runtime.knownPenumbraLogin;
  if (typeof runtime.ghClient.getAuthenticatedLogin !== "function") {
    runtime.knownPenumbraLogin = null;
    return runtime.knownPenumbraLogin;
  }
  try {
    runtime.knownPenumbraLogin = await runtime.ghClient.getAuthenticatedLogin();
  } catch {
    runtime.knownPenumbraLogin = null;
  }
  return runtime.knownPenumbraLogin;
}

function isGhUnavailable(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("github client unavailable") ||
    lower.includes("no such file or directory") ||
    lower.includes("command not found")
  );
}

function stringListField(payload: Record<string, unknown>, key: string): string[] | undefined {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : undefined;
}

async function findExistingIssue(
  runtime: GhTaskSyncRuntime,
  repo: string,
  marker: string,
): Promise<{ number: number } | null> {
  if (!runtime.opts.findOpenIssueByMarker) return null;
  try {
    return await runtime.opts.findOpenIssueByMarker(repo, marker);
  } catch {
    return null;
  }
}

async function processGhCreateIssue(
  runtime: GhTaskSyncRuntime,
  row: GhOutboxRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const task = runtime.opts.taskWriter.get(row.task_id);
  if (isLinked(task)) return;
  const repo = stringField(payload, "repo").trim();
  const title = clampGhIssueTitle(stringField(payload, "title"));
  const rawBody = stringField(payload, "body");
  if (!repo || !title) throw new Error("gh_create_issue missing repo/title");

  const marker = buildGhCreateIssueMarker(row.id);
  const body = embedGhCreateIssueMarker(rawBody, marker);
  runtime.opts.taskWriter.setGhCreateStatus(row.task_id, "pending", null);
  const existing = await findExistingIssue(runtime, repo, marker);
  if (existing) {
    runtime.opts.taskWriter.linkGhIssue(row.task_id, { repo, issue_number: existing.number });
    runtime.opts.taskWriter.setGhCreateStatus(row.task_id, "created", null);
    return;
  }
  const created = await runtime.ghClient.createIssue({
    repo,
    title,
    body,
    labels: stringListField(payload, "labels"),
    assignees: stringListField(payload, "assignees"),
  });
  runtime.opts.taskWriter.linkGhIssue(row.task_id, { repo, issue_number: created.number });
  runtime.opts.taskWriter.setGhCreateStatus(row.task_id, "created", null);
}

async function processGhOutboxRow(
  runtime: GhTaskSyncRuntime,
  row: GhOutboxRow,
  payload: Record<string, unknown>,
): Promise<void> {
  switch (row.op) {
    case "gh_create_issue":
      await processGhCreateIssue(runtime, row, payload);
      return;
    case "gh_sync_linked_task":
      await syncLinkedTask(runtime, row.task_id);
      return;
    case "gh_push_status":
      await pushStatusNow(runtime, row.task_id);
      return;
    case "gh_post_status_comment":
      await processStatusCommentOutbox(runtime, row, payload);
      return;
    case "gh_post_verdict_comment":
      await processVerdictCommentOutbox(runtime, row, payload);
      return;
    case "gh_post_dispatch_failure_comment":
      await processDispatchFailureCommentOutbox(runtime, row, payload);
      return;
  }
}

async function processStatusCommentOutbox(
  runtime: GhTaskSyncRuntime,
  row: GhOutboxRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const from_status = stringField(payload, "from_status");
  const to_status = stringField(payload, "to_status");
  if (from_status && to_status) {
    await postStatusChangeComment(runtime, row.task_id, from_status, to_status, String(row.id));
  }
}

async function processVerdictCommentOutbox(
  runtime: GhTaskSyncRuntime,
  row: GhOutboxRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const verdict = payload.verdict;
  if (
    !isRecord(verdict) ||
    typeof verdict.passed !== "boolean" ||
    typeof verdict.notes !== "string"
  ) {
    throw new Error("gh_post_verdict_comment missing verdict payload");
  }
  await postVerdictComment(
    runtime,
    row.task_id,
    { passed: verdict.passed, notes: verdict.notes },
    String(row.id),
  );
}

async function processDispatchFailureCommentOutbox(
  runtime: GhTaskSyncRuntime,
  row: GhOutboxRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const reason = stringField(payload, "reason").trim();
  if (reason) await postDispatchFailureComment(runtime, row.task_id, reason, String(row.id));
}

async function processGhOutbox(runtime: GhTaskSyncRuntime): Promise<void> {
  const rows = runtime.opts.taskWriter.listPendingGhOutbox(100);
  for (const row of rows) {
    if (runtime.inFlightOutboxIds.has(row.id)) continue;
    if (!runtime.opts.taskWriter.markGhOutboxAttempt(row.id)) continue;
    runtime.inFlightOutboxIds.add(row.id);
    try {
      await processGhOutboxRow(runtime, row, parseJsonRecord(row.payload_json));
      runtime.opts.taskWriter.markGhOutboxDone(row.id);
    } catch (error) {
      markOutboxFailed(runtime, row, error);
    } finally {
      runtime.inFlightOutboxIds.delete(row.id);
    }
  }
}

function markOutboxFailed(runtime: GhTaskSyncRuntime, row: GhOutboxRow, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (row.op === "gh_create_issue") {
    runtime.opts.taskWriter.setGhCreateStatus(row.task_id, "failed", message);
  }
  runtime.opts.taskWriter.markGhOutboxFailed(
    row.id,
    isGhUnavailable(error) ? "github client unavailable" : message,
  );
}

async function mirrorInboundComments(
  runtime: GhTaskSyncRuntime,
  task: LinkedTaskRecord,
  nowIso: string,
): Promise<void> {
  // Capture the cursor timestamp BEFORE the awaited listComments so a comment
  // created between fetch start and cursor stamp is included by the next
  // sweep's `since` filter. gh_last_comment_id/isCommentAfterLastSeen dedupes
  // the resulting overlap.
  const fetchStartedAtMs = runtime.opts.now().getTime();
  const since =
    task.gh_comments_synced_at !== null && task.gh_comments_synced_at !== undefined
      ? toIsoFromMs(task.gh_comments_synced_at)
      : undefined;
  const comments = await runtime.ghClient.listComments(task.gh_issue_repo, task.gh_issue_number, {
    since,
  });
  const expectedAuthorLogin = await resolvePenumbraLogin(runtime);
  const filtered = comments
    .filter(
      (comment) =>
        !isPenumbraAuthoredComment({
          body: comment.body,
          author_login: comment.author_login,
          expected_author_login: expectedAuthorLogin,
        }),
    )
    .filter((comment) => isCommentAfterLastSeen(comment, task.gh_last_comment_id ?? null));

  for (const comment of filtered) {
    writeInboundCommentEvent({
      t0Writer: runtime.opts.t0Writer,
      uuid: runtime.opts.uuid,
      nowIso,
      task,
      comment,
      userId: runtime.userId,
      machineId: runtime.machineId,
    });
  }
  const maxCommentId = pickMaxCommentId(filtered);
  if (maxCommentId) runtime.opts.taskWriter.setGhLastCommentId(task.id, maxCommentId);
  runtime.opts.taskWriter.setGhCommentsSyncedAt(task.id, fetchStartedAtMs);
}

async function postCommentForLinkedTask(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  input: CommentInput,
): Promise<{ comment_url: string } | null> {
  const task = runtime.opts.taskWriter.get(task_id);
  if (!isLinked(task)) return null;
  if (await hasAlreadyPostedComment(runtime, task, input.idempotency_key)) return null;
  return await runtime.ghClient.commentIssue(
    task.gh_issue_repo,
    task.gh_issue_number,
    formatPenumbraComment(input),
  );
}

async function hasAlreadyPostedComment(
  runtime: GhTaskSyncRuntime,
  task: LinkedTaskRecord,
  idempotencyKey: string | undefined,
): Promise<boolean> {
  if (!idempotencyKey) return false;
  const existingComments = await runtime.ghClient.listComments(
    task.gh_issue_repo,
    task.gh_issue_number,
  );
  const expectedAuthorLogin = await resolvePenumbraLogin(runtime);
  return existingComments.some(
    (comment) =>
      isPenumbraAuthoredComment({
        body: comment.body,
        author_login: comment.author_login,
        expected_author_login: expectedAuthorLogin,
      }) && comment.body.includes(`idempotency_key=${idempotencyKey}`),
  );
}

async function syncLinkedTask(
  runtime: GhTaskSyncRuntime,
  task_id: string,
): Promise<GhTaskSyncResult> {
  const nowIso = runtime.opts.now().toISOString();
  if (runtime.inFlightByTask.has(task_id)) return alreadyInProgressResult(runtime, task_id, nowIso);
  runtime.inFlightByTask.add(task_id);
  try {
    return await syncLinkedTaskLocked(runtime, task_id, nowIso);
  } finally {
    runtime.inFlightByTask.delete(task_id);
  }
}

function alreadyInProgressResult(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  nowIso: string,
): GhTaskSyncResult {
  const existing = runtime.opts.taskWriter.get(task_id);
  return {
    task_id,
    repo: existing.gh_issue_repo ?? "",
    issue_number: existing.gh_issue_number ?? 0,
    gh_state: "OPEN",
    action: "already_in_progress",
    last_sync_ts: nowIso,
  };
}

async function syncLinkedTaskLocked(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  nowIso: string,
): Promise<GhTaskSyncResult> {
  const task = runtime.opts.taskWriter.get(task_id);
  if (!isLinked(task)) return unlinkedTaskResult(task, nowIso);
  try {
    return await syncLinkedTaskWithGithub(runtime, task, nowIso);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.opts.log?.warn?.(
      {
        taskId: task.id,
        ghRef: `${task.gh_issue_repo}#${String(task.gh_issue_number)}`,
        err: message,
        code: getErrorCode(error),
      },
      "gh-task-sync: linked task sync failed",
    );
    return createErrorResult(task, message, nowIso);
  }
}

function unlinkedTaskResult(task: TaskRecordLike, nowIso: string): GhTaskSyncResult {
  return {
    task_id: task.id,
    repo: task.gh_issue_repo ?? "",
    issue_number: task.gh_issue_number ?? 0,
    gh_state: "OPEN",
    action: "noop",
    last_sync_ts: nowIso,
  };
}

async function syncLinkedTaskWithGithub(
  runtime: GhTaskSyncRuntime,
  task: LinkedTaskRecord,
  nowIso: string,
): Promise<GhTaskSyncResult> {
  const gh = await runtime.ghClient.viewIssue(task.gh_issue_repo, task.gh_issue_number);
  const update = await reconcileTaskWithGh(runtime, task, gh, nowIso);
  const refreshed = runtime.opts.taskWriter.get(task.id);
  if (isLinked(refreshed)) await mirrorInboundComments(runtime, refreshed, nowIso);
  return {
    task_id: task.id,
    repo: task.gh_issue_repo,
    issue_number: task.gh_issue_number,
    gh_state: gh.state,
    action: update.action,
    direction: update.direction,
    last_sync_ts: nowIso,
  };
}

async function reconcileTaskWithGh(
  runtime: GhTaskSyncRuntime,
  task: LinkedTaskRecord,
  gh: Awaited<ReturnType<GhClient["viewIssue"]>>,
  nowIso: string,
): Promise<Pick<GhTaskSyncResult, "action" | "direction">> {
  const decision = toDecision(task.status);
  if (decision.desiredGhState === gh.state) return { action: "noop", direction: undefined };
  if (task.updated_at > isoToMs(gh.updatedAt)) {
    await pushToGh({ task, ghState: gh.state, client: runtime.ghClient });
    return { action: "pushed", direction: "push" };
  }
  pullGhStateIntoTask(runtime, task, gh, nowIso);
  return { action: "pulled", direction: "pull" };
}

function pullGhStateIntoTask(
  runtime: GhTaskSyncRuntime,
  task: LinkedTaskRecord,
  gh: Awaited<ReturnType<GhClient["viewIssue"]>>,
  nowIso: string,
): void {
  if (gh.state === "CLOSED") {
    applyClosedGhState(runtime, task, gh.stateReason);
  } else {
    runtime.opts.taskWriter.reopenFromGh(task.id);
  }
  writePulledEvent({
    t0Writer: runtime.opts.t0Writer,
    nowIso,
    uuid: runtime.opts.uuid,
    task,
    gh_state: gh.state,
    gh_updated_at: gh.updatedAt,
    repo: task.gh_issue_repo,
    issue_number: task.gh_issue_number,
    userId: runtime.userId,
    machineId: runtime.machineId,
  });
}

function applyClosedGhState(
  runtime: GhTaskSyncRuntime,
  task: LinkedTaskRecord,
  stateReason: string | null,
): void {
  if (stateReason === "COMPLETED") {
    if (task.status !== "done") {
      runtime.opts.taskWriter.completeWithoutLease(
        {
          task_id: task.id,
          result_summary: `github issue completed: ${task.gh_issue_repo}#${String(task.gh_issue_number)}`,
        },
        "gh-task-sync",
      );
    }
    return;
  }
  if (task.status !== "cancelled") {
    runtime.opts.taskWriter.cancel({
      task_id: task.id,
      reason: `github issue closed: ${task.gh_issue_repo}#${String(task.gh_issue_number)}`,
    });
  }
}

async function pushStatusNow(
  runtime: GhTaskSyncRuntime,
  task_id: string,
): Promise<GhTaskSyncResult | null> {
  const task = runtime.opts.taskWriter.get(task_id);
  if (!isLinked(task)) return null;
  const nowIso = runtime.opts.now().toISOString();
  try {
    const gh = await runtime.ghClient.viewIssue(task.gh_issue_repo, task.gh_issue_number);
    await pushToGh({ task, ghState: gh.state, client: runtime.ghClient });
    const refreshed = await runtime.ghClient.viewIssue(task.gh_issue_repo, task.gh_issue_number);
    return {
      task_id: task.id,
      repo: task.gh_issue_repo,
      issue_number: task.gh_issue_number,
      gh_state: refreshed.state,
      action: "pushed",
      direction: "push",
      last_sync_ts: nowIso,
    };
  } catch (error) {
    return createErrorResult(task, error instanceof Error ? error.message : String(error), nowIso);
  }
}

async function postStatusChangeComment(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  from_status: string,
  to_status: string,
  idempotency_key?: string,
): Promise<{ comment_url: string } | null> {
  if (from_status === to_status) return null;
  return await postCommentForLinkedTask(runtime, task_id, {
    task_id,
    kind: "status_change",
    ts: runtime.opts.now().toISOString(),
    status_transition: { from_status, to_status },
    idempotency_key,
  });
}

async function postVerdictComment(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  verdict: { passed: boolean; notes: string },
  idempotency_key?: string,
): Promise<{ comment_url: string } | null> {
  return await postCommentForLinkedTask(runtime, task_id, {
    task_id,
    kind: "verdict",
    ts: runtime.opts.now().toISOString(),
    verdict,
    idempotency_key,
  });
}

async function postDispatchFailureComment(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  reason: string,
  idempotency_key?: string,
): Promise<{ comment_url: string } | null> {
  const normalized = reason.trim();
  if (!normalized) return null;
  return await postCommentForLinkedTask(runtime, task_id, {
    task_id,
    kind: "dispatch_failure",
    ts: runtime.opts.now().toISOString(),
    reason: normalized,
    idempotency_key,
  });
}

async function syncAllLinkedTasks(
  runtime: GhTaskSyncRuntime,
  options?: GhTaskSyncAllOptions,
): Promise<GhTaskSyncSummary> {
  runtime.opts.taskWriter.requeueStaleGhOutboxProcessing(
    runtime.opts.now().getTime() - GH_OUTBOX_PROCESSING_STALE_MS_DEFAULT,
  );
  await processGhOutbox(runtime);
  if (options?.fullReconcile === false) {
    return { linked: 0, pushed: 0, pulled: 0, errored: 0, skipped: false, results: [] };
  }
  const linked = runtime.opts.taskWriter.listLinkedTasks();
  const plan = options?.changedOnly
    ? await planChangedOnlyReconcile({ ...runtime.opts, ghClient: runtime.ghClient }, linked)
    : null;
  const selected = plan?.tasks ?? linked;
  const results = await runInBatches(
    selected,
    GH_TASK_SYNC_BATCH_SIZE,
    async (task) => await syncLinkedTask(runtime, task.id),
  );
  plan?.commit(results);
  return summarizeGhTaskSync(runtime, selected.length, results);
}

function summarizeGhTaskSync(
  runtime: GhTaskSyncRuntime,
  linked: number,
  results: GhTaskSyncResult[],
): GhTaskSyncSummary {
  let pushed = 0;
  let pulled = 0;
  let errored = 0;
  for (const result of results) {
    if (result.action === "pushed") pushed += 1;
    else if (result.action === "pulled") pulled += 1;
    else if (result.action === "error") errored += 1;
  }
  runtime.opts.log?.info?.(
    { linked, pushed, pulled, errored },
    `gh-task-sync: linked=${String(linked)} pushed=${String(pushed)} pulled=${String(pulled)} errored=${String(errored)}`,
  );
  return { linked, pushed, pulled, errored, skipped: false, results };
}

export function createGhTaskSyncService(opts: GhTaskSyncServiceOpts): GhTaskSyncService {
  const runtime = createGhTaskSyncRuntime(opts);
  return {
    syncLinkedTask: (task_id: string): Promise<GhTaskSyncResult> =>
      syncLinkedTask(runtime, task_id),
    syncAllLinkedTasks: (options?: GhTaskSyncAllOptions): Promise<GhTaskSyncSummary> =>
      syncAllLinkedTasks(runtime, options),
    pushStatusNow: (task_id: string): Promise<GhTaskSyncResult | null> =>
      pushStatusNow(runtime, task_id),
    enqueueTaskGhCreate(task_id, input): void {
      runtime.opts.taskWriter.setGhCreateStatus(task_id, "queued", null);
      runtime.opts.taskWriter.enqueueGhOutbox(task_id, "gh_create_issue", input);
    },
    enqueueSyncLinkedTask(task_id: string): void {
      runtime.opts.taskWriter.enqueueGhOutbox(task_id, "gh_sync_linked_task", {});
    },
    queueVerdictComment(task_id: string, verdict: { passed: boolean; notes: string }): void {
      runtime.opts.taskWriter.enqueueGhOutbox(task_id, "gh_post_verdict_comment", { verdict });
    },
    queueDispatchFailureComment(task_id: string, reason: string): void {
      runtime.opts.taskWriter.enqueueGhOutbox(task_id, "gh_post_dispatch_failure_comment", {
        reason,
      });
    },
    postStatusChangeComment: (
      task_id: string,
      from_status: string,
      to_status: string,
    ): Promise<{ comment_url: string } | null> =>
      postStatusChangeComment(runtime, task_id, from_status, to_status),
    postManualComment: (task_id: string, body: string): Promise<{ comment_url: string } | null> =>
      postManualComment(runtime, task_id, body),
    postVerdictComment: (
      task_id: string,
      verdict: { passed: boolean; notes: string },
    ): Promise<{ comment_url: string } | null> => postVerdictComment(runtime, task_id, verdict),
    postDispatchFailureComment: (
      task_id: string,
      reason: string,
    ): Promise<{ comment_url: string } | null> =>
      postDispatchFailureComment(runtime, task_id, reason),
  };
}

async function postManualComment(
  runtime: GhTaskSyncRuntime,
  task_id: string,
  body: string,
): Promise<{ comment_url: string } | null> {
  const normalized = body.trim();
  if (!normalized) return null;
  return await postCommentForLinkedTask(runtime, task_id, {
    task_id,
    kind: "manual",
    ts: runtime.opts.now().toISOString(),
    body: normalized,
  });
}

export function buildGhCreateIssueMarker(outboxRowId: number): string {
  return `<!-- penumbra-outbox-id=${String(outboxRowId)} -->`;
}

export function embedGhCreateIssueMarker(body: string, marker: string): string {
  if (body.includes(marker)) return body;
  if (body.length === 0) return marker;
  return `${body}\n\n${marker}`;
}

async function defaultFindOpenIssueByMarker(
  repo: string,
  marker: string,
): Promise<{ number: number } | null> {
  // Best-effort: gh issue list --search relies on GitHub's issue index. The
  // 10-min stale-requeue window typically gives the index time to catch up.
  // Any failure (gh missing, network error, parse error) returns null so the
  // caller falls through to createIssue (prior at-least-once behavior).
  try {
    const proc = Bun.spawn({
      cmd: [
        "gh",
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--search",
        marker,
        "--json",
        "number,body",
        "--limit",
        "30",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      proc.kill();
    }, 30_000);
    const [stdout, , exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (exitCode !== 0) return null;
    const parsedItems: unknown = JSON.parse(stdout || "[]");
    const items = Array.isArray(parsedItems) ? parsedItems : [];
    for (const item of items) {
      if (
        isRecord(item) &&
        typeof item.body === "string" &&
        item.body.includes(marker) &&
        typeof item.number === "number" &&
        Number.isInteger(item.number) &&
        item.number > 0
      ) {
        return { number: item.number };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function clampGhIssueTitle(title: string): string {
  const singleLine = title.replaceAll(/\s+/g, " ").trim();
  if (singleLine.length <= 256) return singleLine;
  const truncated = singleLine.slice(0, 256);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trimEnd()}…`;
}

export function createGhTaskSyncSweeper(opts: {
  service: GhTaskSyncService;
  intervalMs?: number;
  /**
   * How often the heavy full reconcile (listLinkedTasks → per-task push/pull)
   * runs. Every tick still drains the gh_outbox so status pushes stay prompt;
   * only the GitHub→local reconcile (the drift/pull path) is throttled. Defaults
   * to 5 minutes. The first tick after construction always runs a full reconcile
   * (lastFullReconcileAt starts at 0).
   */
  fullReconcileIntervalMs?: number;
  now?: () => number;
  log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}): { start(): void; stop(): void; tick(): Promise<GhTaskSyncSummary> } {
  const intervalMs = opts.intervalMs ?? 30_000;
  const fullReconcileIntervalMs = opts.fullReconcileIntervalMs ?? 300_000;
  const now = opts.now ?? ((): number => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lastFullReconcileAt = 0;

  async function tick(): Promise<GhTaskSyncSummary> {
    if (inFlight) {
      opts.log?.warn?.(
        { event: "sweeper.skip_tick", sweeper: "gh-task-sync" },
        "sweeper.skip_tick",
      );
      return skippedGhTaskSyncSummary();
    }
    inFlight = true;
    try {
      const ts = now();
      const fullReconcile = ts - lastFullReconcileAt >= fullReconcileIntervalMs;
      if (fullReconcile) {
        lastFullReconcileAt = ts;
      } else {
        opts.log?.info?.(
          { event: "gh-task-sync.skip_full_reconcile", sweeper: "gh-task-sync" },
          "gh-task-sync.skip_full_reconcile",
        );
      }
      return await opts.service.syncAllLinkedTasks({ fullReconcile, changedOnly: true });
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err: unknown) => {
          opts.log?.warn?.({ err: String(err) }, "gh-task-sync tick failed");
        });
      }, intervalMs);
      maybeUnref(timer);
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    tick,
  };
}

export function createDefaultGhTaskSyncService(
  services: {
    db: Database;
    t0Writer: {
      write(event: {
        event_id: string;
        ts: string;
        ingest_ts: string;
        source: string;
        source_detail: string | null;
        project_id: string | null;
        user_id: string;
        machine_id: string;
        session_id: string | null;
        event_type: string;
        lane: string;
        provider: string | null;
        model: string | null;
        tokens_in: number | null;
        tokens_out: number | null;
        cost_usd: number | null;
        latency_ms: number | null;
        request_id: string | null;
        payload_json: unknown;
        payload_summary: string | null;
        origin?: string | null;
      }): void;
    };
    clock: () => Date;
    uuid: () => string;
    log?: {
      info?: (obj: unknown, msg?: string) => void;
      warn?: (obj: unknown, msg?: string) => void;
    };
    machineId: { get(): string };
  },
  taskWriter: GhTaskSyncServiceOpts["taskWriter"],
  ghClient?: GhClient,
): GhTaskSyncService {
  return createGhTaskSyncService({
    taskWriter,
    ghClient,
    reconcileCursors: createGhReconcileCursorStore(services.db),
    t0Writer: services.t0Writer,
    now: () => services.clock(),
    uuid: services.uuid,
    log: services.log,
    machineId: services.machineId.get(),
    findOpenIssueByMarker: defaultFindOpenIssueByMarker,
  });
}
