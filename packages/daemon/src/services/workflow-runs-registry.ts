import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
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
  recordResult(workflowRunId: string, result: unknown): Promise<void>;
  recordError(workflowRunId: string, error: unknown): Promise<void>;
  getStatus(workflowRunId: string): Promise<WorkflowRunRecord | null>;
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

async function writePayload(storageRoot: string, workflowRunId: string, payload: unknown): Promise<{ payloadJson: string; spillPath: string | null }> {
  const payloadJson = safeStringify(payload);
  if (payloadJson.length <= INLINE_JSON_LIMIT) return { payloadJson, spillPath: null };
  const spillPath = makeSpillPath(storageRoot, workflowRunId);
  ensureParentDir(spillPath);
  await writeFile(spillPath, payloadJson, 'utf8');
  return { payloadJson, spillPath: pathRelative(storageRoot, spillPath) };
}

async function readPayload(
  storageRoot: string,
  payloadJson: string | null | undefined,
  spillPath: string | null | undefined,
  log?: { warn?: (obj: Record<string, unknown>, msg: string) => void },
): Promise<unknown> {
  if (spillPath) {
    if (spillPath.startsWith('/')) {
      log?.warn?.({ spill_path: spillPath }, 'workflow run spill path rejected: absolute path');
      return null;
    }
    const filePath = pathResolve(storageRoot, spillPath);
    try {
      const [canonicalStorageRoot, canonicalFilePath] = await Promise.all([
        realpath(storageRoot),
        realpath(filePath),
      ]);
      if (!canonicalFilePath.startsWith(`${canonicalStorageRoot}/`)) {
        log?.warn?.({ spill_path: spillPath, resolved_path: canonicalFilePath, storage_root: canonicalStorageRoot }, 'workflow run spill path rejected: containment failure');
        return null;
      }
      if (!existsSync(canonicalFilePath)) {
        log?.warn?.({ spill_path: spillPath, resolved_path: canonicalFilePath }, 'workflow run spill path rejected: missing file');
        return null;
      }
      return safeParseJson<unknown>(await readFile(canonicalFilePath, 'utf8'));
    } catch (err) {
      log?.warn?.({ spill_path: spillPath, err: String(err) }, 'workflow run spill path rejected: read failed');
      return null;
    }
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
  log?: { warn?: (obj: Record<string, unknown>, msg: string) => void };
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
    opts.db.query(`DELETE FROM workflow_runs WHERE status IN ('completed','failed') AND expires_at <= ?`).run(nowMs);
  }

  function hydrateInfo(workflowRunId: string): Entry | null {
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
          },
      waiters: [],
    };
    entries.set(workflowRunId, entry);
    return entry;
  }

  async function hydrateRecord(workflowRunId: string): Promise<Entry | null> {
    const entry = hydrateInfo(workflowRunId);
    if (!entry || !entry.record || entry.record.status === 'running') return entry;
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
    if (row.status === 'running') return entry;
    entry.record = {
      status: row.status,
      started_at: row.started_at,
      finished_at: row.completed_at ?? undefined,
      ...(row.status === 'completed'
      ? { result: await readPayload(opts.storageRoot, row.result_json, row.result_spill_path, opts.log) }
        : { error: await readPayload(opts.storageRoot, row.error_json, row.error_spill_path, opts.log) }),
    };
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
      const entry = hydrateInfo(workflowRunId);
      return entry
        ? {
            workflow_name: entry.workflow_name,
            project_id: entry.project_id,
            registered_at: entry.registered_at,
          }
        : null;
    },
    unregister(workflowRunId: string) {
      const entry = entries.get(workflowRunId) ?? hydrateInfo(workflowRunId);
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
    async recordResult(workflowRunId: string, result: unknown) {
      const entry = await hydrateRecord(workflowRunId);
      if (!entry) return;
      const finishedAt = opts.clock().getTime();
      try {
        const spill = await writePayload(opts.storageRoot, workflowRunId, result);
        const record: WorkflowRunRecord = {
          status: 'completed',
          started_at: entry.registered_at,
          finished_at: finishedAt,
          result,
        };
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: 'completed',
          completed_at: record.finished_at,
          result_json: spill.spillPath ? null : spill.payloadJson,
          error_json: null,
          result_spill_path: spill.spillPath,
          error_spill_path: null,
        });
        releaseWaiters(entry);
      } catch (error) {
        const record: WorkflowRunRecord = {
          status: 'failed',
          started_at: entry.registered_at,
          finished_at: finishedAt,
          error,
        };
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: 'failed',
          completed_at: record.finished_at,
          result_json: null,
          error_json: safeStringify(error),
          result_spill_path: null,
          error_spill_path: null,
        });
        releaseWaiters(entry);
      }
    },
    async recordError(workflowRunId: string, error: unknown) {
      const entry = await hydrateRecord(workflowRunId);
      if (!entry) return;
      const finishedAt = opts.clock().getTime();
      try {
        const spill = await writePayload(opts.storageRoot, workflowRunId, error);
        const record: WorkflowRunRecord = {
          status: 'failed',
          started_at: entry.registered_at,
          finished_at: finishedAt,
          error,
        };
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: 'failed',
          completed_at: record.finished_at,
          result_json: null,
          error_json: spill.spillPath ? null : spill.payloadJson,
          result_spill_path: null,
          error_spill_path: spill.spillPath,
        });
        releaseWaiters(entry);
      } catch (spillError) {
        const record: WorkflowRunRecord = {
          status: 'failed',
          started_at: entry.registered_at,
          finished_at: finishedAt,
          error: spillError,
        };
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: 'failed',
          completed_at: record.finished_at,
          result_json: null,
          error_json: safeStringify(spillError),
          result_spill_path: null,
          error_spill_path: null,
        });
        releaseWaiters(entry);
      }
    },
    async getStatus(workflowRunId: string) {
      sweepExpired(opts.clock().getTime());
      purgeExpiredRows(opts.clock().getTime());
      const entry = await hydrateRecord(workflowRunId);
      if (!entry) return null;
      return entry.record ?? {
        status: 'running',
        started_at: entry.registered_at,
      };
    },
    waitForResult(workflowRunId: string, timeoutMs: number) {
      sweepExpired(opts.clock().getTime());
      purgeExpiredRows(opts.clock().getTime());
      const entry = hydrateInfo(workflowRunId);
      if (!entry) return Promise.resolve(null);
      if (entry.record) {
        if (entry.record.status !== 'running' && entry.record.result === undefined && entry.record.error === undefined) {
          return hydrateRecord(workflowRunId).then((hydrated) => hydrated?.record ?? entry.record ?? null);
        }
        return Promise.resolve(entry.record);
      }
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
