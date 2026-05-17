export interface WorkflowRunInfo {
  workflow_name: string;
  project_id: string;
  registered_at: number;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed';

export interface WorkflowRunRecord {
  status: WorkflowRunStatus;
  started_at: number;
  finished_at?: number;
  result?: unknown;
  error?: unknown;
}

export interface WorkflowRunsRegistry {
  register(workflowName: string, projectId: string): string;
  verify(workflowRunId: string): WorkflowRunInfo | null;
  unregister(workflowRunId: string): void;
  recordResult(workflowRunId: string, result: unknown): void;
  recordError(workflowRunId: string, error: unknown): void;
  getStatus(workflowRunId: string): WorkflowRunRecord | null;
  waitForResult(workflowRunId: string, timeoutMs: number): Promise<WorkflowRunRecord | null>;
}

type Entry = WorkflowRunInfo & {
  record?: WorkflowRunRecord;
  waiters: Array<{
    resolve: (record: WorkflowRunRecord | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
};

export function createWorkflowRunsRegistry(opts: {
  uuid: () => string;
  clock: () => Date;
  ttlMs?: number;
}): WorkflowRunsRegistry {
  const ttlMs = opts.ttlMs ?? 600_000;
  const entries = new Map<string, Entry>();

  function sweepExpired(nowMs: number): void {
    for (const [workflowRunId, entry] of entries) {
      if (entry.registered_at + ttlMs < nowMs) {
        entries.delete(workflowRunId);
      }
    }
  }

  function capSize(): void {
    while (entries.size > 1024) {
      const oldest = entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    register(workflowName, projectId) {
      const workflowRunId = opts.uuid();
      entries.set(workflowRunId, {
        workflow_name: workflowName,
        project_id: projectId,
        registered_at: opts.clock().getTime(),
        waiters: [],
      });
      capSize();
      return workflowRunId;
    },
    verify(workflowRunId) {
      const nowMs = opts.clock().getTime();
      sweepExpired(nowMs);
      return entries.get(workflowRunId) ?? null;
    },
    unregister(workflowRunId) {
      const entry = entries.get(workflowRunId);
      if (entry) {
        entry.waiters.splice(0).forEach(({ resolve, timeout }) => {
          clearTimeout(timeout);
          resolve(entry.record ?? null);
        });
      }
      entries.delete(workflowRunId);
    },
    recordResult(workflowRunId, result) {
      const entry = entries.get(workflowRunId);
      if (!entry) return;
      entry.record = {
        status: 'completed',
        started_at: entry.registered_at,
        finished_at: opts.clock().getTime(),
        result,
      };
      entry.waiters.splice(0).forEach(({ resolve, timeout }) => {
        clearTimeout(timeout);
        resolve(entry.record ?? null);
      });
    },
    recordError(workflowRunId, error) {
      const entry = entries.get(workflowRunId);
      if (!entry) return;
      entry.record = {
        status: 'failed',
        started_at: entry.registered_at,
        finished_at: opts.clock().getTime(),
        error,
      };
      entry.waiters.splice(0).forEach(({ resolve, timeout }) => {
        clearTimeout(timeout);
        resolve(entry.record ?? null);
      });
    },
    getStatus(workflowRunId) {
      const entry = entries.get(workflowRunId);
      if (!entry) return null;
      return entry.record ?? {
        status: 'running',
        started_at: entry.registered_at,
      };
    },
    waitForResult(workflowRunId, timeoutMs) {
      const entry = entries.get(workflowRunId);
      if (!entry) return Promise.resolve(null);
      const current = entry.record;
      if (current) return Promise.resolve(current);
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
}
