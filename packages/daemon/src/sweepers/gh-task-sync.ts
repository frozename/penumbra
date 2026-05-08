import type { GhClient, GhIssueState } from '../services/gh-client.js';
import { createGhCliClient } from '../services/gh-client.js';

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
}

interface GhTaskSyncServiceOpts {
  taskWriter: {
    get(task_id: string): TaskRecordLike;
    cancel(input: { task_id: string; reason?: string }): { status: string };
    reopenFromGh(task_id: string): { status: 'pending' };
    listLinkedTasks(): TaskRecordLike[];
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
}

interface SyncDecision {
  desiredGhState: GhIssueState;
  closeReason: PushCloseReason | null;
}

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

export function createGhTaskSyncService(opts: GhTaskSyncServiceOpts): GhTaskSyncService {
  const ghClient = opts.ghClient ?? createGhCliClient();
  const userId = opts.userId ?? 'penumbra';
  const machineId = opts.machineId ?? process.env.HOSTNAME ?? 'unknown';

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
      if (decision.desiredGhState === gh.state) {
        return {
          task_id: task.id,
          repo: task.gh_issue_repo,
          issue_number: task.gh_issue_number,
          gh_state: gh.state,
          action: 'noop',
          last_sync_ts: nowIso,
        };
      }

      const taskUpdatedMs = task.updated_at;
      const ghUpdatedMs = isoToMs(gh.updatedAt);

      if (taskUpdatedMs > ghUpdatedMs) {
        await pushToGh({ task, ghState: gh.state, client: ghClient });
        return {
          task_id: task.id,
          repo: task.gh_issue_repo,
          issue_number: task.gh_issue_number,
          gh_state: gh.state,
          action: 'pushed',
          direction: 'push',
          last_sync_ts: nowIso,
        };
      }

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
      return {
        task_id: task.id,
        repo: task.gh_issue_repo,
        issue_number: task.gh_issue_number,
        gh_state: gh.state,
        action: 'pulled',
        direction: 'pull',
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
      const results: GhTaskSyncResult[] = [];
      let pushed = 0;
      let pulled = 0;
      let errored = 0;
      for (const task of linked) {
        const result = await syncLinkedTask(task.id);
        results.push(result);
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
        return {
          task_id: task.id,
          repo: task.gh_issue_repo,
          issue_number: task.gh_issue_number,
          gh_state: gh.state,
          action: 'pushed',
          direction: 'push',
          last_sync_ts: nowIso,
        };
      } catch (error) {
        return createErrorResult(task, error instanceof Error ? error.message : String(error), nowIso);
      }
    },
  };
}

export function createGhTaskSyncSweeper(opts: {
  service: GhTaskSyncService;
  intervalMs?: number;
  log?: { warn?: (obj: unknown, msg?: string) => void };
}): { start(): void; stop(): void; tick(): Promise<GhTaskSyncSummary> } {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let consecutiveErroredTicks = 0;

  async function tick(): Promise<GhTaskSyncSummary> {
    if (consecutiveErroredTicks >= 3) {
      consecutiveErroredTicks = 0;
      return {
        linked: 0,
        pushed: 0,
        pulled: 0,
        errored: 0,
        skipped: true,
        results: [],
      };
    }

    const summary = await opts.service.syncAllLinkedTasks();
    if (summary.linked > 0 && summary.errored === summary.linked) {
      consecutiveErroredTicks += 1;
    } else {
      consecutiveErroredTicks = 0;
    }
    return summary;
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => {
          consecutiveErroredTicks += 1;
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
