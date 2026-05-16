export interface WorkflowRunInfo {
  workflow_name: string;
  project_id: string | null;
  registered_at: number;
}

export interface WorkflowRunsRegistry {
  register(workflowName: string, projectId: string | null): string;
  verify(workflowRunId: string): WorkflowRunInfo | null;
  unregister(workflowRunId: string): void;
}

type Entry = WorkflowRunInfo;

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
      entries.delete(workflowRunId);
    },
  };
}
