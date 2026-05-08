import type { GhClient, GhIssueState, GhIssueComment } from '../services/gh-client.js';
import { createGhCliClient } from '../services/gh-client.js';
import { formatPenumbraComment, isPenumbraAuthoredComment } from '../services/gh-comment-format.js';

type PushCloseReason = 'completed' | 'not planned';

export interface GhTaskSyncResult {
  task_id: string;
  repo: string;
  issue_number: number;
  gh_state: GhIssueState;
  action: 'noop' | 'pushed' | 'pulled' | 'error';
  direction?: 'push' | 'pull';
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

export interface GhTaskSyncService {
  syncLinkedTask(task_id: string): Promise<GhTaskSyncResult>;
  syncAllLinkedTasks(): Promise<GhTaskSyncSummary>;
  pushStatusNow(task_id: string): Promise<GhTaskSyncResult | null>;
  postStatusChangeComment(task_id: string, from_status: string, to_status: string): Promise<{ comment_url: string } | null>;
  postManualComment(task_id: string, body: string): Promise<{ comment_url: string } | null>;
  postVerdictComment(task_id: string, verdict: { passed: boolean; notes: string }): Promise<{ comment_url: string } | null>;
  postDispatchFailureComment(task_id: string, reason: string): Promise<{ comment_url: string } | null>;
}

interface GhTaskSyncServiceOpts {
  taskWriter: {
    get(task_id: string): TaskRecordLike;
    cancel(input: { task_id: string; reason?: string }): { status: string };
    reopenFromGh(task_id: string): { status: 'pending' };
    listLinkedTasks(): TaskRecordLike[];
    setGhLastCommentId(task_id: string, comment_id: string): { task_id: string; gh_last_comment_id: string };
  };
  ghClient?: GhClient;
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
  log?: { info?: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
  userId?: string;
  machineId?: string;
}

type TaskStatusLike = 'pending' | 'leased' | 'done_pending_review' | 'done' | 'failed' | 'cancelled';

interface TaskRecordLike {
  id: string;
  project_id: string | null;
  updated_at: number;
  status: TaskStatusLike;
  gh_issue_repo?: string | null;
  gh_issue_number?: number | null;
  gh_last_comment_id?: string | null;
}

interface SyncDecision {
  desiredGhState: GhIssueState;
  closeReason: PushCloseReason | null;
}

const GH_TASK_SYNC_BATCH_SIZE = 6;

function toDecision(status: TaskStatusLike): SyncDecision {
  switch (status) {
    case 'pending':
    case 'leased':
    case 'done_pending_review':
      return { desiredGhState: 'OPEN', closeReason: null };
    case 'done':
      return { desiredGhState: 'CLOSED', closeReason: 'completed' };
    case 'failed':
    case 'cancelled':
      return { desiredGhState: 'CLOSED', closeReason: 'not planned' };
  }
}

function isoToMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildIssueUrl(repo: string, issue_number: number): string {
  return `https://github.com/${repo}/issues/${issue_number}`;
}

function isLinked(task: TaskRecordLike): task is TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number } {
  return typeof task.gh_issue_repo === 'string'
    && task.gh_issue_repo.length > 0
    && typeof task.gh_issue_number === 'number'
    && Number.isInteger(task.gh_issue_number)
    && task.gh_issue_number > 0;
}

function writePulledEvent(opts: {
  t0Writer: GhTaskSyncServiceOpts['t0Writer'];
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
    source: 'daemon',
    source_detail: 'gh-task-sync',
    project_id: opts.task.project_id,
    user_id: opts.userId,
    machine_id: opts.machineId,
    session_id: null,
    event_type: 'task.gh_state_pulled',
    lane: 'system',
    provider: 'github',
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
    payload_summary: `Pulled GH issue ${opts.repo}#${opts.issue_number} state=${opts.gh_state} into task ${opts.task.id}`,
    origin: 'dispatch',
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
  t0Writer: GhTaskSyncServiceOpts['t0Writer'];
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
    source: 'daemon',
    source_detail: 'gh-task-sync',
    project_id: opts.task.project_id,
    user_id: opts.userId,
    machine_id: opts.machineId,
    session_id: null,
    event_type: 'gh_issue_comment',
    lane: 'system',
    provider: 'github',
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
    },
    payload_summary: `GitHub comment ${opts.comment.id} mirrored to task ${opts.task.id} (${opts.task.gh_issue_repo}#${opts.task.gh_issue_number})`,
    origin: 'dispatch',
  });
}

async function pushToGh(args: {
  task: TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number };
  ghState: GhIssueState;
  client: GhClient;
}): Promise<void> {
  const decision = toDecision(args.task.status);
  if (decision.desiredGhState === args.ghState) return;
  if (decision.desiredGhState === 'OPEN') {
    await args.client.reopenIssue(args.task.gh_issue_repo, args.task.gh_issue_number);
    return;
  }
  await args.client.closeIssue(args.task.gh_issue_repo, args.task.gh_issue_number, decision.closeReason!);
}

function createErrorResult(task: TaskRecordLike, message: string, nowIso: string): GhTaskSyncResult {
  return {
    task_id: task.id,
    repo: task.gh_issue_repo ?? '',
    issue_number: task.gh_issue_number ?? 0,
    gh_state: 'OPEN',
    action: 'error',
    error: message,
    last_sync_ts: nowIso,
  };
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

export function createGhTaskSyncService(opts: GhTaskSyncServiceOpts): GhTaskSyncService {
  const ghClient = opts.ghClient ?? createGhCliClient();
  const userId = opts.userId ?? 'penumbra';
  const machineId = opts.machineId ?? process.env.HOSTNAME ?? 'unknown';

  const mirrorInboundComments = async (
    task: TaskRecordLike & { gh_issue_repo: string; gh_issue_number: number },
    nowIso: string,
  ): Promise<void> => {
    const since = toIsoFromMs(task.updated_at);
    const comments = await ghClient.listComments(task.gh_issue_repo, task.gh_issue_number, { since });
    const filtered = comments
      .filter((comment) => !isPenumbraAuthoredComment(comment.body))
      .filter((comment) => isCommentAfterLastSeen(comment, task.gh_last_comment_id ?? null));

    for (const comment of filtered) {
      writeInboundCommentEvent({
        t0Writer: opts.t0Writer,
        uuid: opts.uuid,
        nowIso,
        task,
        comment,
        userId,
        machineId,
      });
    }
    const maxCommentId = pickMaxCommentId(filtered);
    if (maxCommentId) {
      opts.taskWriter.setGhLastCommentId(task.id, maxCommentId);
    }
  };

  const postCommentForLinkedTask = async (
    task_id: string,
    input: Parameters<typeof formatPenumbraComment>[0],
  ): Promise<{ comment_url: string } | null> => {
    const task = opts.taskWriter.get(task_id);
    if (!isLinked(task)) return null;
    return ghClient.commentIssue(
      task.gh_issue_repo,
      task.gh_issue_number,
      formatPenumbraComment(input),
    );
  };

  const syncLinkedTask = async (task_id: string): Promise<GhTaskSyncResult> => {
    const nowIso = opts.now().toISOString();
    const task = opts.taskWriter.get(task_id);
    if (!isLinked(task)) {
      return {
        task_id: task.id,
        repo: task.gh_issue_repo ?? '',
        issue_number: task.gh_issue_number ?? 0,
        gh_state: 'OPEN',
        action: 'noop',
        last_sync_ts: nowIso,
      };
    }

    try {
      const gh = await ghClient.viewIssue(task.gh_issue_repo, task.gh_issue_number);
      const decision = toDecision(task.status);
      let action: GhTaskSyncResult['action'] = 'noop';
      let direction: GhTaskSyncResult['direction'] | undefined;

      if (decision.desiredGhState !== gh.state) {
        const taskUpdatedMs = task.updated_at;
        const ghUpdatedMs = isoToMs(gh.updatedAt);

        if (taskUpdatedMs > ghUpdatedMs) {
          await pushToGh({ task, ghState: gh.state, client: ghClient });
          action = 'pushed';
          direction = 'push';
        } else {
          if (gh.state === 'CLOSED') {
            if (task.status !== 'cancelled') {
              opts.taskWriter.cancel({
                task_id: task.id,
                reason: `github issue closed: ${task.gh_issue_repo}#${task.gh_issue_number}`,
              });
            }
          } else {
            opts.taskWriter.reopenFromGh(task.id);
          }
          writePulledEvent({
            t0Writer: opts.t0Writer,
            nowIso,
            uuid: opts.uuid,
            task,
            gh_state: gh.state,
            gh_updated_at: gh.updatedAt,
            repo: task.gh_issue_repo,
            issue_number: task.gh_issue_number,
            userId,
            machineId,
          });
          action = 'pulled';
          direction = 'pull';
        }
      }

      const refreshed = opts.taskWriter.get(task.id);
      if (isLinked(refreshed)) {
        await mirrorInboundComments(refreshed, nowIso);
      }

      return {
        task_id: task.id,
        repo: task.gh_issue_repo,
        issue_number: task.gh_issue_number,
        gh_state: gh.state,
        action,
        direction,
        last_sync_ts: nowIso,
      };
    } catch (error) {
      return createErrorResult(task, error instanceof Error ? error.message : String(error), nowIso);
    }
  };

  return {
    syncLinkedTask,

    async syncAllLinkedTasks(): Promise<GhTaskSyncSummary> {
      const linked = opts.taskWriter.listLinkedTasks();
      const results = await runInBatches(linked, GH_TASK_SYNC_BATCH_SIZE, async (task) => syncLinkedTask(task.id));
      let pushed = 0;
      let pulled = 0;
      let errored = 0;
      for (const result of results) {
        if (result.action === 'pushed') pushed += 1;
        else if (result.action === 'pulled') pulled += 1;
        else if (result.action === 'error') errored += 1;
      }
      opts.log?.info?.(
        { linked: linked.length, pushed, pulled, errored },
        `gh-task-sync: linked=${linked.length} pushed=${pushed} pulled=${pulled} errored=${errored}`,
      );
      return {
        linked: linked.length,
        pushed,
        pulled,
        errored,
        skipped: false,
        results,
      };
    },

    async pushStatusNow(task_id: string): Promise<GhTaskSyncResult | null> {
      const task = opts.taskWriter.get(task_id);
      if (!isLinked(task)) return null;
      const nowIso = opts.now().toISOString();
      try {
        const gh = await ghClient.viewIssue(task.gh_issue_repo, task.gh_issue_number);
        await pushToGh({ task, ghState: gh.state, client: ghClient });
        const refreshed = await ghClient.viewIssue(task.gh_issue_repo, task.gh_issue_number);
        return {
          task_id: task.id,
          repo: task.gh_issue_repo,
          issue_number: task.gh_issue_number,
          gh_state: refreshed.state,
          action: 'pushed',
          direction: 'push',
          last_sync_ts: nowIso,
        };
      } catch (error) {
        return createErrorResult(task, error instanceof Error ? error.message : String(error), nowIso);
      }
    },

    async postStatusChangeComment(task_id: string, from_status: string, to_status: string): Promise<{ comment_url: string } | null> {
      if (from_status === to_status) return null;
      const nowIso = opts.now().toISOString();
      return postCommentForLinkedTask(task_id, {
        task_id,
        kind: 'status_change',
        ts: nowIso,
        status_transition: { from_status, to_status },
      });
    },

    async postManualComment(task_id: string, body: string): Promise<{ comment_url: string } | null> {
      const normalized = body.trim();
      if (!normalized) return null;
      return postCommentForLinkedTask(task_id, {
        task_id,
        kind: 'manual',
        ts: opts.now().toISOString(),
        body: normalized,
      });
    },

    async postVerdictComment(
      task_id: string,
      verdict: { passed: boolean; notes: string },
    ): Promise<{ comment_url: string } | null> {
      return postCommentForLinkedTask(task_id, {
        task_id,
        kind: 'verdict',
        ts: opts.now().toISOString(),
        verdict,
      });
    },

    async postDispatchFailureComment(task_id: string, reason: string): Promise<{ comment_url: string } | null> {
      const normalized = reason.trim();
      if (!normalized) return null;
      return postCommentForLinkedTask(task_id, {
        task_id,
        kind: 'dispatch_failure',
        ts: opts.now().toISOString(),
        reason: normalized,
      });
    },
  };
}

export function createGhTaskSyncSweeper(opts: {
  service: GhTaskSyncService;
  intervalMs?: number;
  log?: { info?: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
}): { start(): void; stop(): void; tick(): Promise<GhTaskSyncSummary> } {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function tick(): Promise<GhTaskSyncSummary> {
    if (inFlight) {
      opts.log?.warn?.({ event: 'sweeper.skip_tick', sweeper: 'gh-task-sync' }, 'sweeper.skip_tick');
      return {
        linked: 0,
        pushed: 0,
        pulled: 0,
        errored: 0,
        skipped: true,
        results: [],
      };
    }
    inFlight = true;
    try {
      return await opts.service.syncAllLinkedTasks();
    } finally {
      inFlight = false;
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => {
          opts.log?.warn?.({ err: String(err) }, 'gh-task-sync tick failed');
        });
      }, intervalMs);
      if (typeof (timer as any).unref === 'function') {
        (timer as any).unref();
      }
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
    log?: { info?: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
    machineId: { get(): string };
  },
  taskWriter: GhTaskSyncServiceOpts['taskWriter'],
): GhTaskSyncService {
  return createGhTaskSyncService({
    taskWriter,
    t0Writer: services.t0Writer,
    now: () => services.clock(),
    uuid: services.uuid,
    log: services.log as any,
    machineId: services.machineId.get(),
  });
}
