import type { WorkflowStatusLight } from "@penumbra/core";
import type { Database } from "bun:sqlite";

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative as pathRelative, resolve as pathResolve } from "node:path";

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

type Waiter = {
  resolve: (record: WorkflowRunRecord | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  poll: ReturnType<typeof setInterval>;
  settled: boolean;
};

type PersistenceStatus = "pending" | "persisted" | "persistence_failed";

type PatchFields = Partial<{
  status: "running" | "completed" | "failed";
  completed_at: number | null;
  expires_at: number;
  result_json: string | null;
  error_json: string | null;
  result_spill_path: string | null;
  error_spill_path: string | null;
  result_bytes: number;
  error_bytes: number;
}>;

type RegistryOpts = {
  uuid: () => string;
  clock: () => Date;
  db: Database;
  storageRoot: string;
  ttlMs?: number;
  capacity?: number;
  waiterLimit?: number;
  log?: { warn?: (obj: Record<string, unknown>, msg: string) => void };
};

type RegistryCtx = {
  opts: RegistryOpts;
  entries: Map<string, Entry>;
  ttlMs: number;
  capacity: number;
  waiterLimit: number;
  waitersByRunId: Map<string, Waiter[]>;
  persistenceByRunId: Map<string, PersistenceStatus>;
  locallyRegisteredRunIds: Set<string>;
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ message: String(value) });
  }
}

function safeParseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
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
  await mkdir(dirname(spillPath), { recursive: true });
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
      return safeParseJson(await readFile(canonicalFilePath, "utf8"));
    } catch (err) {
      log?.warn?.(
        { spill_path: spillPath, err: String(err) },
        "workflow run spill path rejected: read failed",
      );
      return null;
    }
  }
  return safeParseJson(payloadJson);
}

type DbWorkflowRunRow = {
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
};

const ROW_SELECT_SQL = `SELECT id, project_id, workflow_name, status, started_at, completed_at, result_json, error_json, result_spill_path, error_spill_path, expires_at
           FROM workflow_runs
          WHERE id = ?
          LIMIT 1`;

function clearRunState(ctx: RegistryCtx, workflowRunId: string): void {
  ctx.waitersByRunId.delete(workflowRunId);
  ctx.persistenceByRunId.delete(workflowRunId);
}

function sweepExpired(ctx: RegistryCtx, nowMs: number): void {
  for (const [workflowRunId, entry] of ctx.entries) {
    // Mirror evictIfNeeded's terminal guard: a freshly registered run has no
    // record yet, so `entry.record?.status !== "running"` was true for every
    // live run and the TTL sweep silently emptied waitersByRunId, defeating the
    // waiter cap exactly when a run was long enough for waiters to pile up.
    if (entry.record?.status === "running") continue;
    if (entry.registered_at + ctx.ttlMs >= nowMs) continue;
    // Keep evicting orphan entries so capacity still drains, but never drop an
    // entry that live waiters are parked on.
    if (!entry.record && ctx.waitersByRunId.has(workflowRunId)) continue;
    ctx.entries.delete(workflowRunId);
    clearRunState(ctx, workflowRunId);
  }
}

async function safeUnlinkSpill(
  storageRoot: string,
  spillPath: string | null | undefined,
  log?: { warn?: (obj: Record<string, unknown>, msg: string) => void },
): Promise<void> {
  if (!spillPath) return;
  if (spillPath.startsWith("/")) {
    log?.warn?.({ spill_path: spillPath }, "workflow run spill unlink rejected: absolute path");
    return;
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
        "workflow run spill unlink rejected: containment failure",
      );
      return;
    }
    await unlink(canonicalFilePath);
  } catch (err) {
    log?.warn?.({ spill_path: spillPath, err: String(err) }, "workflow run spill unlink failed");
  }
}

function purgeExpiredRows(ctx: RegistryCtx, nowMs: number): void {
  const expiredRows = ctx.opts.db
    .query<
      { id: string; result_spill_path: string | null; error_spill_path: string | null },
      [number]
    >(`SELECT id, result_spill_path, error_spill_path FROM workflow_runs WHERE status IN ('completed','failed') AND expires_at <= ?`)
    .all(nowMs);
  ctx.opts.db
    .query(`DELETE FROM workflow_runs WHERE status IN ('completed','failed') AND expires_at <= ?`)
    .run(nowMs);
  for (const row of expiredRows) {
    clearRunState(ctx, row.id);
    void safeUnlinkSpill(ctx.opts.storageRoot, row.result_spill_path, ctx.opts.log);
    void safeUnlinkSpill(ctx.opts.storageRoot, row.error_spill_path, ctx.opts.log);
  }
}

async function sweepOrphanSpills(ctx: RegistryCtx): Promise<void> {
  const spillDir = join(ctx.opts.storageRoot, ".penumbra", "workflow-runs");
  let names: string[];
  try {
    names = await readdir(spillDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const workflowRunId = name.slice(0, -".json".length);
    let row: { id: string } | null = null;
    try {
      row =
        ctx.opts.db
          .query<{ id: string }, [string]>(`SELECT id FROM workflow_runs WHERE id = ? LIMIT 1`)
          .get(workflowRunId) ?? null;
    } catch (err) {
      ctx.opts.log?.warn?.(
        { workflow_run_id: workflowRunId, err: String(err) },
        "workflow run orphan spill sweep query failed",
      );
      continue;
    }
    if (row) continue;
    await safeUnlinkSpill(
      ctx.opts.storageRoot,
      pathRelative(ctx.opts.storageRoot, join(spillDir, name)),
      ctx.opts.log,
    );
  }
}

function hydrateInfo(ctx: RegistryCtx, workflowRunId: string, bypassExpiry = false): Entry | null {
  const cached = ctx.entries.get(workflowRunId);
  if (cached) return cached;
  const row = ctx.opts.db.query<DbWorkflowRunRow, [string]>(ROW_SELECT_SQL).get(workflowRunId);
  if (!row) return null;
  if (!bypassExpiry && row.expires_at <= ctx.opts.clock().getTime() && row.status !== "running") {
    ctx.entries.delete(workflowRunId);
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
  if (
    row.status !== "running" &&
    !ctx.locallyRegisteredRunIds.has(workflowRunId) &&
    !ctx.persistenceByRunId.has(workflowRunId)
  ) {
    ctx.persistenceByRunId.set(workflowRunId, "persisted");
  }
  ctx.entries.set(workflowRunId, entry);
  return entry;
}

async function hydrateRecord(
  ctx: RegistryCtx,
  workflowRunId: string,
  bypassExpiry = false,
): Promise<Entry | null> {
  const entry = hydrateInfo(ctx, workflowRunId, bypassExpiry);
  if (!entry?.record || entry.record.status === "running") return entry;
  const row = ctx.opts.db.query<DbWorkflowRunRow, [string]>(ROW_SELECT_SQL).get(workflowRunId);
  if (!row) return null;
  if (row.status === "running") return entry;
  entry.record = {
    status: row.status,
    started_at: row.started_at,
    finished_at: row.completed_at ?? undefined,
    ...(row.status === "completed"
      ? {
          result: await readPayload(
            ctx.opts.storageRoot,
            row.result_json,
            row.result_spill_path,
            ctx.opts.log,
          ),
        }
      : {
          error: await readPayload(
            ctx.opts.storageRoot,
            row.error_json,
            row.error_spill_path,
            ctx.opts.log,
          ),
        }),
  };
  return entry;
}

function refreshPersistedState(ctx: RegistryCtx, workflowRunId: string, patch: PatchFields): void {
  const parts: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch) as [
    keyof PatchFields,
    PatchFields[keyof PatchFields],
  ][]) {
    if (value === undefined) continue;
    parts.push(`${key} = ?`);
    args.push(value);
  }
  if (parts.length === 0) return;
  args.push(workflowRunId);
  ctx.opts.db.query(`UPDATE workflow_runs SET ${parts.join(", ")} WHERE id = ?`).run(...args);
}

function releaseWaiters(ctx: RegistryCtx, workflowRunId: string, entry: Entry): void {
  const waiters = ctx.waitersByRunId.get(workflowRunId);
  if (!waiters) return;
  ctx.waitersByRunId.delete(workflowRunId);
  for (const waiter of waiters.splice(0)) {
    waiter.settled = true;
    clearTimeout(waiter.timeout);
    clearInterval(waiter.poll);
    waiter.resolve(entry.record ?? null);
  }
}

function settleWaiter(
  ctx: RegistryCtx,
  workflowRunId: string,
  waiter: Waiter,
  record: WorkflowRunRecord | null,
): void {
  if (waiter.settled) return;
  waiter.settled = true;
  clearTimeout(waiter.timeout);
  clearInterval(waiter.poll);
  const current = ctx.waitersByRunId.get(workflowRunId);
  if (current) {
    const idx = current.indexOf(waiter);
    if (idx >= 0) current.splice(idx, 1);
    if (current.length === 0) ctx.waitersByRunId.delete(workflowRunId);
  }
  waiter.resolve(record);
}

function evictIfNeeded(ctx: RegistryCtx): boolean {
  if (ctx.entries.size < ctx.capacity) return true;
  let evicted = false;
  for (const [workflowRunId, entry] of ctx.entries) {
    if (entry.record && entry.record.status !== "running") {
      ctx.entries.delete(workflowRunId);
      clearRunState(ctx, workflowRunId);
      evicted = true;
    }
  }
  return evicted;
}

async function registryRecordResult(
  ctx: RegistryCtx,
  workflowRunId: string,
  result: unknown,
): Promise<void> {
  const entry = await hydrateRecord(ctx, workflowRunId, true);
  if (!entry) return;
  const finishedAt = ctx.opts.clock().getTime();
  try {
    const spill = await writePayload(ctx.opts.storageRoot, workflowRunId, result);
    const record: WorkflowRunRecord = {
      status: "completed",
      started_at: entry.registered_at,
      finished_at: finishedAt,
      result,
    };
    entry.record = record;
    refreshPersistedState(ctx, workflowRunId, {
      status: "completed",
      completed_at: finishedAt,
      expires_at: finishedAt + ctx.ttlMs,
      result_json: spill.spillPath ? null : spill.payloadJson,
      error_json: null,
      result_spill_path: spill.spillPath,
      error_spill_path: null,
      result_bytes: Buffer.byteLength(spill.payloadJson),
      error_bytes: 0,
    });
    ctx.persistenceByRunId.set(workflowRunId, "persisted");
    releaseWaiters(ctx, workflowRunId, entry);
  } catch (error) {
    const errorJson = safeStringify(error);
    const record: WorkflowRunRecord = {
      status: "failed",
      started_at: entry.registered_at,
      finished_at: finishedAt,
      error,
    };
    entry.record = record;
    refreshPersistedState(ctx, workflowRunId, {
      status: "failed",
      completed_at: finishedAt,
      expires_at: finishedAt + ctx.ttlMs,
      result_json: null,
      error_json: errorJson,
      result_spill_path: null,
      error_spill_path: null,
      result_bytes: 0,
      error_bytes: Buffer.byteLength(errorJson),
    });
    ctx.persistenceByRunId.set(workflowRunId, "persistence_failed");
    releaseWaiters(ctx, workflowRunId, entry);
  }
}

async function registryRecordError(
  ctx: RegistryCtx,
  workflowRunId: string,
  error: unknown,
): Promise<void> {
  const entry = await hydrateRecord(ctx, workflowRunId, true);
  if (!entry) return;
  const finishedAt = ctx.opts.clock().getTime();
  try {
    const spill = await writePayload(ctx.opts.storageRoot, workflowRunId, error);
    const record: WorkflowRunRecord = {
      status: "failed",
      started_at: entry.registered_at,
      finished_at: finishedAt,
      error,
    };
    entry.record = record;
    refreshPersistedState(ctx, workflowRunId, {
      status: "failed",
      completed_at: finishedAt,
      expires_at: finishedAt + ctx.ttlMs,
      result_json: null,
      error_json: spill.spillPath ? null : spill.payloadJson,
      result_spill_path: null,
      error_spill_path: spill.spillPath,
      result_bytes: 0,
      error_bytes: Buffer.byteLength(spill.payloadJson),
    });
    ctx.persistenceByRunId.set(workflowRunId, "persisted");
    releaseWaiters(ctx, workflowRunId, entry);
  } catch (spillError) {
    const errorJson = safeStringify(spillError);
    const record: WorkflowRunRecord = {
      status: "failed",
      started_at: entry.registered_at,
      finished_at: finishedAt,
      error: spillError,
    };
    entry.record = record;
    refreshPersistedState(ctx, workflowRunId, {
      status: "failed",
      completed_at: finishedAt,
      expires_at: finishedAt + ctx.ttlMs,
      result_json: null,
      error_json: errorJson,
      result_spill_path: null,
      error_spill_path: null,
      result_bytes: 0,
      error_bytes: Buffer.byteLength(errorJson),
    });
    ctx.persistenceByRunId.set(workflowRunId, "persistence_failed");
    releaseWaiters(ctx, workflowRunId, entry);
  }
}

async function registryGetStatus(
  ctx: RegistryCtx,
  workflowRunId: string,
): Promise<WorkflowRunRecord | null> {
  sweepExpired(ctx, ctx.opts.clock().getTime());
  purgeExpiredRows(ctx, ctx.opts.clock().getTime());
  const entry = await hydrateRecord(ctx, workflowRunId, true);
  if (!entry) return null;
  const persistenceStatus = ctx.persistenceByRunId.get(workflowRunId);
  if (entry.record) {
    return {
      ...entry.record,
      ...(persistenceStatus && persistenceStatus !== "pending"
        ? { persistence_status: persistenceStatus }
        : {}),
    };
  }
  return {
    status: "running",
    started_at: entry.registered_at,
    ...(persistenceStatus && persistenceStatus !== "pending"
      ? { persistence_status: persistenceStatus }
      : {}),
  };
}

function registryWaitForResult(
  ctx: RegistryCtx,
  workflowRunId: string,
  timeoutMs: number,
): Promise<WorkflowRunRecord | null> {
  sweepExpired(ctx, ctx.opts.clock().getTime());
  purgeExpiredRows(ctx, ctx.opts.clock().getTime());
  const entry = hydrateInfo(ctx, workflowRunId, true);
  if (!entry) return Promise.resolve(null);
  if (entry.record) {
    if (
      entry.record.status !== "running" &&
      entry.record.result === undefined &&
      entry.record.error === undefined
    ) {
      return hydrateRecord(ctx, workflowRunId, true).then(
        (hydrated) => hydrated?.record ?? entry.record ?? null,
      );
    }
    return Promise.resolve(entry.record);
  }
  const waiters = ctx.waitersByRunId.get(workflowRunId) ?? [];
  if (waiters.length >= ctx.waiterLimit)
    return Promise.reject(new Error("waiter_capacity_exhausted"));
  return new Promise((resolve) => {
    const pollIntervalMs = Math.max(1, Math.min(100, timeoutMs));
    const waiter: Waiter = {
      resolve,
      timeout: setTimeout(() => {
        settleWaiter(ctx, workflowRunId, waiter, null);
      }, timeoutMs),
      poll: setInterval(() => {
        if (waiter.settled) return;
        const row = ctx.opts.db
          .query<Pick<DbWorkflowRunRow, "status">, [string]>(ROW_SELECT_SQL)
          .get(workflowRunId);
        if (!row || row.status === "running") return;
        ctx.entries.delete(workflowRunId);
        void hydrateRecord(ctx, workflowRunId, true).then((hydrated) => {
          if (hydrated?.record && hydrated.record.status !== "running") {
            settleWaiter(ctx, workflowRunId, waiter, hydrated.record);
          }
        });
      }, pollIntervalMs),
      settled: false,
    };
    ctx.waitersByRunId.set(workflowRunId, [...waiters, waiter]);
  });
}

export function createWorkflowRunsRegistry(opts: RegistryOpts): WorkflowRunsRegistry {
  const ctx: RegistryCtx = {
    opts,
    entries: new Map<string, Entry>(),
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    capacity: opts.capacity ?? DEFAULT_CAPACITY,
    waiterLimit: opts.waiterLimit ?? DEFAULT_WAITER_LIMIT,
    waitersByRunId: new Map<string, Waiter[]>(),
    persistenceByRunId: new Map<string, PersistenceStatus>(),
    locallyRegisteredRunIds: new Set<string>(),
  };

  void sweepOrphanSpills(ctx);

  return {
    register(workflowName: string, projectId: string | null): string | null {
      sweepExpired(ctx, ctx.opts.clock().getTime());
      if (!evictIfNeeded(ctx)) return null;
      const workflowRunId = opts.uuid();
      const startedAt = opts.clock().getTime();
      const entry: Entry = {
        workflow_name: workflowName,
        project_id: projectId,
        registered_at: startedAt,
      };
      ctx.entries.set(workflowRunId, entry);
      ctx.locallyRegisteredRunIds.add(workflowRunId);
      ctx.persistenceByRunId.set(workflowRunId, "pending");
      opts.db
        .query(
          `INSERT INTO workflow_runs (id, project_id, workflow_name, status, started_at, completed_at, result_json, error_json, result_spill_path, error_spill_path, expires_at)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(workflowRunId, projectId, workflowName, startedAt, startedAt + ctx.ttlMs);
      return workflowRunId;
    },

    verify(workflowRunId: string): WorkflowRunInfo | null {
      sweepExpired(ctx, ctx.opts.clock().getTime());
      const entry = hydrateInfo(ctx, workflowRunId);
      return entry
        ? {
            workflow_name: entry.workflow_name,
            project_id: entry.project_id,
            registered_at: entry.registered_at,
          }
        : null;
    },

    unregister(workflowRunId: string): void {
      const entry = ctx.entries.get(workflowRunId) ?? hydrateInfo(ctx, workflowRunId);
      if (entry) releaseWaiters(ctx, workflowRunId, entry);
      clearRunState(ctx, workflowRunId);
      ctx.entries.delete(workflowRunId);
      opts.db.query(`DELETE FROM workflow_runs WHERE id = ?`).run(workflowRunId);
      const spillPath = makeSpillPath(opts.storageRoot, workflowRunId);
      if (existsSync(spillPath)) {
        void unlink(spillPath).catch((err: unknown) => {
          opts.log?.warn?.(
            { workflow_run_id: workflowRunId, spill_path: spillPath, err: String(err) },
            "workflow run spill cleanup failed",
          );
        });
      }
    },

    recordResult: (workflowRunId, result) => registryRecordResult(ctx, workflowRunId, result),
    recordError: (workflowRunId, error) => registryRecordError(ctx, workflowRunId, error),
    getStatus: (workflowRunId) => registryGetStatus(ctx, workflowRunId),

    getStatusLight(workflowRunId: string): Promise<WorkflowStatusLight | null> {
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
      if (!row) return Promise.resolve(null);
      if (row.status === "running") {
        return Promise.resolve({
          status: "running",
          started_at: row.started_at,
          result_available: false,
          result_bytes: row.result_bytes,
          error_bytes: row.error_bytes,
        });
      }
      return Promise.resolve({
        status: row.status,
        started_at: row.started_at,
        finished_at: row.completed_at ?? undefined,
        result_available: row.status === "completed",
        result_bytes: row.result_bytes,
        error_bytes: row.error_bytes,
      });
    },

    waitForResult: (workflowRunId, timeoutMs) =>
      registryWaitForResult(ctx, workflowRunId, timeoutMs),

    setPersistenceStatus(workflowRunId: string, status: PersistenceStatus): void {
      ctx.persistenceByRunId.set(workflowRunId, status);
    },

    setExecutionRecord(workflowRunId: string, record: WorkflowRunRecord): void {
      const entry = hydrateInfo(ctx, workflowRunId, true);
      if (!entry) return;
      entry.record = record;
    },
  };
}
