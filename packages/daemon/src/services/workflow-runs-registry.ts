import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as pathResolve, relative as pathRelative } from 'node:path';
import type { Database } from 'bun:sqlite';

type WorkflowRunInfo = {
  workflow_name: string;
  project_id: string | null;
  registered_at: number;
};

type WorkflowRunStatus = 'running' | 'completed' | 'failed';

type WorkflowRunRecord = {
  status: WorkflowRunStatus;
  started_at: number;
  finished_at?: number;
  result?: unknown;
  error?: unknown;
};

type WorkflowRunsRegistry = {
  register(workflowName: string, projectId: string | null): string | null;
  verify(workflowRunId: string): WorkflowRunInfo | null;
  unregister(workflowRunId: string): void;
  recordResult(workflowRunId: string, result: unknown): void;
  recordError(workflowRunId: string, error: unknown): void;
  getStatus(workflowRunId: string): WorkflowRunRecord | null;
  waitForResult(workflowRunId: string, timeoutMs: number): Promise<WorkflowRunRecord | null>;
};

const DEFAULT_CAPACITY = 1024;
const DEFAULT_TTL_MS = 600_000;
const INLINE_JSON_LIMIT = 64 * 1024;
const DEFAULT_WAITER_LIMIT = 16;

type Entry = WorkflowRunInfo & {
  record?: WorkflowRunRecord;
  waiters: Array<{
    resolve: (record: WorkflowRunRecord | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: String(value) });
  }
}

function safeParseJson<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function makeSpillPath(storageRoot: string, workflowRunId: string): string {
  return join(storageRoot, '.penumbra', 'workflow-runs', `${workflowRunId}.json`);
}

function writePayload(storageRoot: string, workflowRunId: string, payload: unknown): { payloadJson: string; spillPath: string | null } {
  const payloadJson = safeStringify(payload);
  if (payloadJson.length <= INLINE_JSON_LIMIT) return { payloadJson, spillPath: null };
  const spillPath = makeSpillPath(storageRoot, workflowRunId);
  ensureParentDir(spillPath);
  writeFileSync(spillPath, payloadJson, 'utf8');
  return { payloadJson, spillPath: pathRelative(storageRoot, spillPath) };
}

function readPayload(storageRoot: string, payloadJson: string | null | undefined, spillPath: string | null | undefined): unknown {
  if (spillPath) {
    const filePath = pathResolve(storageRoot, spillPath);
    if (!existsSync(filePath)) return null;
    return safeParseJson<unknown>(readFileSync(filePath, 'utf8'));
  }
  return safeParseJson<unknown>(payloadJson);
}

export function createWorkflowRunsRegistry(opts: {
  uuid: () => string;
  clock: () => Date;
  db: Database;
  storageRoot: string;
  ttlMs?: number;
  capacity?: number;
  waiterLimit?: number;
}): WorkflowRunsRegistry {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const waiterLimit = opts.waiterLimit ?? DEFAULT_WAITER_LIMIT;
  const entries = new Map<string, Entry>();

  function sweepExpired(nowMs: number): void {
    for (const [workflowRunId, entry] of entries) {
      if (entry.registered_at + ttlMs < nowMs) {
        entries.delete(workflowRunId);
      }
    }
  }

  function purgeExpiredRows(nowMs: number): void {
    opts.db.query(`DELETE FROM workflow_runs WHERE expires_at <= ?`).run(nowMs);
  }

  function hydrate(workflowRunId: string): Entry | null {
    const cached = entries.get(workflowRunId);
    if (cached) return cached;
    const row = opts.db
      .query<
        {
          id: string;
          project_id: string | null;
          workflow_name: string;
          status: 'running' | 'completed' | 'failed';
          started_at: number;
          completed_at: number | null;
          result_json: string | null;
          error_json: string | null;
          result_spill_path: string | null;
          error_spill_path: string | null;
          expires_at: number;
        },
        [string]
      >(
        `SELECT id, project_id, workflow_name, status, started_at, completed_at, result_json, error_json, result_spill_path, error_spill_path, expires_at
           FROM workflow_runs
          WHERE id = ?
          LIMIT 1`,
      )
      .get(workflowRunId);
    if (!row) return null;
    if (row.expires_at <= opts.clock().getTime()) {
      entries.delete(workflowRunId);
      return null;
    }
    const entry: Entry = {
      workflow_name: row.workflow_name,
      project_id: row.project_id,
      registered_at: row.started_at,
      record: row.status === 'running'
        ? undefined
        : {
            status: row.status,
            started_at: row.started_at,
            finished_at: row.completed_at ?? undefined,
            ...(row.status === 'completed'
              ? { result: readPayload(opts.storageRoot, row.result_json, row.result_spill_path) }
              : { error: readPayload(opts.storageRoot, row.error_json, row.error_spill_path) }),
          },
      waiters: [],
    };
    entries.set(workflowRunId, entry);
    return entry;
  }

  function refreshPersistedState(
    workflowRunId: string,
    patch: Partial<{ status: 'running' | 'completed' | 'failed'; completed_at: number | null; result_json: string | null; error_json: string | null; result_spill_path: string | null; error_spill_path: string | null }>,
  ): void {
    const parts: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch) as Array<[
      keyof typeof patch,
      (typeof patch)[keyof typeof patch],
    ]>) {
      if (value === undefined) continue;
      parts.push(`${key} = ?`);
      args.push(value);
    }
    if (parts.length === 0) return;
    args.push(workflowRunId);
    opts.db.query(`UPDATE workflow_runs SET ${parts.join(', ')} WHERE id = ?`).run(...args);
  }

  function releaseWaiters(entry: Entry): void {
    entry.waiters.splice(0).forEach((waiter: Entry['waiters'][number]) => {
      const { resolve, timeout } = waiter;
      clearTimeout(timeout);
      resolve(entry.record ?? null);
    });
  }

  function evictIfNeeded(): boolean {
    if (entries.size < capacity) return true;
    for (const [workflowRunId, entry] of entries) {
      if (entry.record) {
        entries.delete(workflowRunId);
        return true;
      }
    }
    return false;
  }

  const api: WorkflowRunsRegistry = {
    register(workflowName: string, projectId: string | null) {
      if (!evictIfNeeded()) return null;
      const workflowRunId = opts.uuid();
      const startedAt = opts.clock().getTime();
      const entry: Entry = {
        workflow_name: workflowName,
        project_id: projectId,
        registered_at: startedAt,
        waiters: [],
      };
      entries.set(workflowRunId, entry);
      opts.db.query(
        `INSERT INTO workflow_runs (id, project_id, workflow_name, status, started_at, completed_at, result_json, error_json, result_spill_path, error_spill_path, expires_at)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
      ).run(workflowRunId, projectId, workflowName, startedAt, startedAt + ttlMs);
      return workflowRunId;
    },
    verify(workflowRunId: string) {
      sweepExpired(opts.clock().getTime());
      const entry = hydrate(workflowRunId);
      return entry
        ? {
            workflow_name: entry.workflow_name,
            project_id: entry.project_id,
            registered_at: entry.registered_at,
          }
        : null;
    },
    unregister(workflowRunId: string) {
    const entry = entries.get(workflowRunId) ?? hydrate(workflowRunId);
    if (entry) releaseWaiters(entry);
    entries.delete(workflowRunId);
    opts.db.query(`DELETE FROM workflow_runs WHERE id = ?`).run(workflowRunId);
    const spillPath = makeSpillPath(opts.storageRoot, workflowRunId);
    if (existsSync(spillPath)) {
      try {
        unlinkSync(spillPath);
      } catch {}
    }
  },
    recordResult(workflowRunId: string, result: unknown) {
      const entry = hydrate(workflowRunId);
      if (!entry) return;
      const record: WorkflowRunRecord = {
        status: 'completed',
        started_at: entry.registered_at,
        finished_at: opts.clock().getTime(),
        result,
      };
      entry.record = record;
      const spill = writePayload(opts.storageRoot, workflowRunId, result);
      refreshPersistedState(workflowRunId, {
        status: 'completed',
        completed_at: record.finished_at,
        result_json: spill.payloadJson,
        error_json: null,
        result_spill_path: spill.spillPath,
        error_spill_path: null,
      });
      releaseWaiters(entry);
    },
    recordError(workflowRunId: string, error: unknown) {
      const entry = hydrate(workflowRunId);
      if (!entry) return;
      const record: WorkflowRunRecord = {
        status: 'failed',
        started_at: entry.registered_at,
        finished_at: opts.clock().getTime(),
        error,
      };
      entry.record = record;
      const spill = writePayload(opts.storageRoot, workflowRunId, error);
      refreshPersistedState(workflowRunId, {
        status: 'failed',
        completed_at: record.finished_at,
        result_json: null,
        error_json: spill.payloadJson,
        result_spill_path: null,
        error_spill_path: spill.spillPath,
      });
      releaseWaiters(entry);
    },
    getStatus(workflowRunId: string) {
      sweepExpired(opts.clock().getTime());
      purgeExpiredRows(opts.clock().getTime());
      const entry = hydrate(workflowRunId);
      if (!entry) return null;
      return entry.record ?? {
        status: 'running',
        started_at: entry.registered_at,
      };
    },
    waitForResult(workflowRunId: string, timeoutMs: number) {
      sweepExpired(opts.clock().getTime());
      purgeExpiredRows(opts.clock().getTime());
      const entry = hydrate(workflowRunId);
      if (!entry) return Promise.resolve(null);
      if (entry.record) return Promise.resolve(entry.record);
      if (entry.waiters.length >= waiterLimit) return Promise.reject(new Error('waiter_capacity_exhausted'));
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          timeout: setTimeout(() => {
            const idx = entry.waiters.indexOf(waiter);
            if (idx >= 0) entry.waiters.splice(idx, 1);
            resolve(null);
          }, timeoutMs),
        };
        entry.waiters.push(waiter);
      });
    },
  };
  return api;
}
