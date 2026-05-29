import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve as pathResolve, relative as pathRelative } from "node:path";
import type { Database } from "bun:sqlite";
import type { WorkflowStatusLight } from "@penumbra/core";

declare module "@penumbra/core" {
  interface WorkflowStatusLight {
    status: "running" | "completed" | "failed";
    started_at: number;
    finished_at?: number;
    result_available: boolean;
    result_bytes: number;
    error_bytes: number;
  }

  interface WorkflowRunsRegistry {
    getStatusLight(workflowRunId: string): Promise<WorkflowStatusLight | null>;
  }
}

type WorkflowRunInfo = {
  workflow_name: string;
  project_id: string | null;
  registered_at: number;
};

type WorkflowRunStatus = "running" | "completed" | "failed";

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
  getStatusLight(workflowRunId: string): Promise<WorkflowStatusLight | null>;
  waitForResult(workflowRunId: string, timeoutMs: number): Promise<WorkflowRunRecord | null>;
  setPersistenceStatus(
    workflowRunId: string,
    status: "pending" | "persisted" | "persistence_failed",
  ): void;
  setExecutionRecord(workflowRunId: string, record: WorkflowRunRecord): void;
};

export type WorkflowRunsRegistryInternal = WorkflowRunsRegistry;
export type { WorkflowStatusLight } from "@penumbra/core";

const DEFAULT_CAPACITY = 1024;
const DEFAULT_TTL_MS = 600_000;
const INLINE_JSON_LIMIT = 64 * 1024;
const DEFAULT_WAITER_LIMIT = 16;

type Entry = WorkflowRunInfo & {
  record?: WorkflowRunRecord;
};

const persistenceByRunId = new Map<string, "pending" | "persisted" | "persistence_failed">();
const waitersByRunId = new Map<
  string,
  Array<{
    resolve: (record: WorkflowRunRecord | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>
>();

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
  return join(storageRoot, ".penumbra", "workflow-runs", `${workflowRunId}.json`);
}

async function writePayload(
  storageRoot: string,
  workflowRunId: string,
  payload: unknown,
): Promise<{ payloadJson: string; spillPath: string | null }> {
  const payloadJson = safeStringify(payload);
  if (payloadJson.length <= INLINE_JSON_LIMIT) return { payloadJson, spillPath: null };
  const spillPath = makeSpillPath(storageRoot, workflowRunId);
  ensureParentDir(spillPath);
  await writeFile(spillPath, payloadJson, "utf8");
  return { payloadJson, spillPath: pathRelative(storageRoot, spillPath) };
}

async function readPayload(
  storageRoot: string,
  payloadJson: string | null | undefined,
  spillPath: string | null | undefined,
  log?: { warn?: (obj: Record<string, unknown>, msg: string) => void },
): Promise<unknown> {
  if (spillPath) {
    if (spillPath.startsWith("/")) {
      log?.warn?.({ spill_path: spillPath }, "workflow run spill path rejected: absolute path");
      return null;
    }
    const filePath = pathResolve(storageRoot, spillPath);
    try {
      const [canonicalStorageRoot, canonicalFilePath] = await Promise.all([
        realpath(storageRoot),
        realpath(filePath),
      ]);
      if (!canonicalFilePath.startsWith(`${canonicalStorageRoot}/`)) {
        log?.warn?.(
          {
            spill_path: spillPath,
            resolved_path: canonicalFilePath,
            storage_root: canonicalStorageRoot,
          },
          "workflow run spill path rejected: containment failure",
        );
        return null;
      }
      if (!existsSync(canonicalFilePath)) {
        log?.warn?.(
          { spill_path: spillPath, resolved_path: canonicalFilePath },
          "workflow run spill path rejected: missing file",
        );
        return null;
      }
      return safeParseJson<unknown>(await readFile(canonicalFilePath, "utf8"));
    } catch (err) {
      log?.warn?.(
        { spill_path: spillPath, err: String(err) },
        "workflow run spill path rejected: read failed",
      );
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

  function clearRunState(workflowRunId: string): void {
    waitersByRunId.delete(workflowRunId);
    persistenceByRunId.delete(workflowRunId);
  }

  function sweepExpired(nowMs: number): void {
    for (const [workflowRunId, entry] of entries) {
      if (entry.record?.status !== "running" && entry.registered_at + ttlMs < nowMs) {
        entries.delete(workflowRunId);
        clearRunState(workflowRunId);
      }
    }
  }

  function purgeExpiredRows(nowMs: number): void {
    const expiredRows = opts.db
      .query<
        { id: string },
        [number]
      >(`SELECT id FROM workflow_runs WHERE status IN ('completed','failed') AND expires_at <= ?`)
      .all(nowMs);
    opts.db
      .query(`DELETE FROM workflow_runs WHERE status IN ('completed','failed') AND expires_at <= ?`)
      .run(nowMs);
    // Terminal-run persistence state is only kept while the row is retained.
    for (const row of expiredRows) clearRunState(row.id);
  }

  function hydrateInfo(workflowRunId: string, bypassExpiry = false): Entry | null {
    const cached = entries.get(workflowRunId);
    if (cached) return cached;
    const row = opts.db
      .query<
        {
          id: string;
          project_id: string | null;
          workflow_name: string;
          status: "running" | "completed" | "failed";
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
    if (!bypassExpiry && row.expires_at <= opts.clock().getTime() && row.status !== "running") {
      entries.delete(workflowRunId);
      return null;
    }
    const entry: Entry = {
      workflow_name: row.workflow_name,
      project_id: row.project_id,
      registered_at: row.started_at,
      record:
        row.status === "running"
          ? undefined
          : {
              status: row.status,
              started_at: row.started_at,
              finished_at: row.completed_at ?? undefined,
            },
    };
    entries.set(workflowRunId, entry);
    return entry;
  }

  async function hydrateRecord(workflowRunId: string, bypassExpiry = false): Promise<Entry | null> {
    const entry = hydrateInfo(workflowRunId, bypassExpiry);
    if (!entry || !entry.record || entry.record.status === "running") return entry;
    const row = opts.db
      .query<
        {
          id: string;
          project_id: string | null;
          workflow_name: string;
          status: "running" | "completed" | "failed";
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
    if (row.status === "running") return entry;
    entry.record = {
      status: row.status,
      started_at: row.started_at,
      finished_at: row.completed_at ?? undefined,
      ...(row.status === "completed"
        ? {
            result: await readPayload(
              opts.storageRoot,
              row.result_json,
              row.result_spill_path,
              opts.log,
            ),
          }
        : {
            error: await readPayload(
              opts.storageRoot,
              row.error_json,
              row.error_spill_path,
              opts.log,
            ),
          }),
    };
    return entry;
  }

  function refreshPersistedState(
    workflowRunId: string,
    patch: Partial<{
      status: "running" | "completed" | "failed";
      completed_at: number | null;
      result_json: string | null;
      error_json: string | null;
      result_spill_path: string | null;
      error_spill_path: string | null;
      result_bytes: number;
      error_bytes: number;
    }>,
  ): void {
    const parts: string[] = [];
    const args: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof typeof patch, (typeof patch)[keyof typeof patch]]
    >) {
      if (value === undefined) continue;
      parts.push(`${key} = ?`);
      args.push(value);
    }
    if (parts.length === 0) return;
    args.push(workflowRunId);
    opts.db.query(`UPDATE workflow_runs SET ${parts.join(", ")} WHERE id = ?`).run(...args);
  }

  function releaseWaiters(workflowRunId: string, entry: Entry): void {
    const waiters = waitersByRunId.get(workflowRunId);
    if (!waiters) return;
    waitersByRunId.delete(workflowRunId);
    waiters.splice(0).forEach((waiter) => {
      const { resolve, timeout } = waiter;
      clearTimeout(timeout);
      resolve(entry.record ?? null);
    });
  }

  function setPersistenceStatus(
    workflowRunId: string,
    status: "pending" | "persisted" | "persistence_failed",
  ): void {
    persistenceByRunId.set(workflowRunId, status);
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

  const api: WorkflowRunsRegistryInternal = {
    register(workflowName: string, projectId: string | null) {
      if (!evictIfNeeded()) return null;
      const workflowRunId = opts.uuid();
      const startedAt = opts.clock().getTime();
      const entry: Entry = {
        workflow_name: workflowName,
        project_id: projectId,
        registered_at: startedAt,
      };
      entries.set(workflowRunId, entry);
      setPersistenceStatus(workflowRunId, "pending");
      opts.db
        .query(
          `INSERT INTO workflow_runs (id, project_id, workflow_name, status, started_at, completed_at, result_json, error_json, result_spill_path, error_spill_path, expires_at)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(workflowRunId, projectId, workflowName, startedAt, startedAt + ttlMs);
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
      if (entry) releaseWaiters(workflowRunId, entry);
      clearRunState(workflowRunId);
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
      const entry = await hydrateRecord(workflowRunId, true);
      if (!entry) return;
      const finishedAt = opts.clock().getTime();
      try {
        const spill = await writePayload(opts.storageRoot, workflowRunId, result);
        const record: WorkflowRunRecord = {
          status: "completed",
          started_at: entry.registered_at,
          finished_at: finishedAt,
          result,
        };
        const resultBytes = Buffer.byteLength(spill.payloadJson);
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: "completed",
          completed_at: record.finished_at,
          result_json: spill.spillPath ? null : spill.payloadJson,
          error_json: null,
          result_spill_path: spill.spillPath,
          error_spill_path: null,
          result_bytes: resultBytes,
          error_bytes: 0,
        });
        setPersistenceStatus(workflowRunId, "persisted");
        releaseWaiters(workflowRunId, entry);
      } catch (error) {
        const errorJson = safeStringify(error);
        const record: WorkflowRunRecord = {
          status: "failed",
          started_at: entry.registered_at,
          finished_at: finishedAt,
          error,
        };
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: "failed",
          completed_at: record.finished_at,
          result_json: null,
          error_json: errorJson,
          result_spill_path: null,
          error_spill_path: null,
          result_bytes: 0,
          error_bytes: Buffer.byteLength(errorJson),
        });
        setPersistenceStatus(workflowRunId, "persistence_failed");
        releaseWaiters(workflowRunId, entry);
      }
    },
    async recordError(workflowRunId: string, error: unknown) {
      const entry = await hydrateRecord(workflowRunId, true);
      if (!entry) return;
      const finishedAt = opts.clock().getTime();
      try {
        const spill = await writePayload(opts.storageRoot, workflowRunId, error);
        const record: WorkflowRunRecord = {
          status: "failed",
          started_at: entry.registered_at,
          finished_at: finishedAt,
          error,
        };
        const errorBytes = Buffer.byteLength(spill.payloadJson);
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: "failed",
          completed_at: record.finished_at,
          result_json: null,
          error_json: spill.spillPath ? null : spill.payloadJson,
          result_spill_path: null,
          error_spill_path: spill.spillPath,
          result_bytes: 0,
          error_bytes: errorBytes,
        });
        setPersistenceStatus(workflowRunId, "persisted");
        releaseWaiters(workflowRunId, entry);
      } catch (spillError) {
        const errorJson = safeStringify(spillError);
        const record: WorkflowRunRecord = {
          status: "failed",
          started_at: entry.registered_at,
          finished_at: finishedAt,
          error: spillError,
        };
        entry.record = record;
        refreshPersistedState(workflowRunId, {
          status: "failed",
          completed_at: record.finished_at,
          result_json: null,
          error_json: errorJson,
          result_spill_path: null,
          error_spill_path: null,
          result_bytes: 0,
          error_bytes: Buffer.byteLength(errorJson),
        });
        setPersistenceStatus(workflowRunId, "persistence_failed");
        releaseWaiters(workflowRunId, entry);
      }
    },
    async getStatus(workflowRunId: string) {
      sweepExpired(opts.clock().getTime());
      purgeExpiredRows(opts.clock().getTime());
      const entry = await hydrateRecord(workflowRunId, true);
      if (!entry) return null;
      if (entry.record) {
        const persistenceStatus = persistenceByRunId.get(workflowRunId);
        return {
          ...entry.record,
          ...(persistenceStatus && persistenceStatus !== "pending"
            ? { persistence_status: persistenceStatus }
            : {}),
        };
      }
      const persistenceStatus = persistenceByRunId.get(workflowRunId);
      return {
        status: "running",
        started_at: entry.registered_at,
        ...(persistenceStatus && persistenceStatus !== "pending"
          ? { persistence_status: persistenceStatus }
          : {}),
      };
    },
    // Cheap status read: single-row metadata SELECT only - never hydrates the payload,
    // never reads the spill file, never sweeps/purges.
    async getStatusLight(workflowRunId: string) {
      const row = opts.db
        .query<
          {
            status: WorkflowRunStatus;
            started_at: number;
            completed_at: number | null;
            result_bytes: number;
            error_bytes: number;
          },
          [string]
        >(
          `SELECT status, started_at, completed_at, result_bytes, error_bytes
             FROM workflow_runs
            WHERE id = ?
            LIMIT 1`,
        )
        .get(workflowRunId);
      if (!row) return null;
      if (row.status === "running") {
        return {
          status: "running",
          started_at: row.started_at,
          result_available: false,
          result_bytes: row.result_bytes,
          error_bytes: row.error_bytes,
        };
      }
      return {
        status: row.status,
        started_at: row.started_at,
        finished_at: row.completed_at ?? undefined,
        result_available: row.status === "completed",
        result_bytes: row.result_bytes,
        error_bytes: row.error_bytes,
      };
    },
    waitForResult(workflowRunId: string, timeoutMs: number) {
      sweepExpired(opts.clock().getTime());
      purgeExpiredRows(opts.clock().getTime());
      const entry = hydrateInfo(workflowRunId, true);
      if (!entry) return Promise.resolve(null);
      if (entry.record) {
        if (
          entry.record.status !== "running" &&
          entry.record.result === undefined &&
          entry.record.error === undefined
        ) {
          return hydrateRecord(workflowRunId, true).then(
            (hydrated) => hydrated?.record ?? entry.record ?? null,
          );
        }
        return Promise.resolve(entry.record);
      }
      const waiters = waitersByRunId.get(workflowRunId) ?? [];
      if (waiters.length >= waiterLimit)
        return Promise.reject(new Error("waiter_capacity_exhausted"));
      return new Promise((resolve) => {
        const waiter = {
          resolve,
          timeout: setTimeout(() => {
            const current = waitersByRunId.get(workflowRunId);
            if (current) {
              const idx = current.indexOf(waiter);
              if (idx >= 0) current.splice(idx, 1);
              if (current.length === 0) waitersByRunId.delete(workflowRunId);
            }
            resolve(null);
          }, timeoutMs),
        };
        waitersByRunId.set(workflowRunId, [...waiters, waiter]);
      });
    },
    setPersistenceStatus,
    setExecutionRecord(workflowRunId: string, record: WorkflowRunRecord) {
      const entry = hydrateInfo(workflowRunId, true);
      if (!entry) return;
      entry.record = record;
    },
  };
  return api;
}
