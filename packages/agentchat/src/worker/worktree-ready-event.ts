import type { DispatchEventInput, WorktreeHandle, WorktreeMode } from "@penumbra/core";

export function buildWorktreeReadyEvent(input: {
  handoffId: string;
  workerId: string;
  worktreeMode: WorktreeMode;
  durationMs: number;
  ts?: string;
  gitHooks?: WorktreeHandle["gitHooks"];
}): DispatchEventInput {
  return {
    handoff_id: input.handoffId,
    worker_id: input.workerId,
    source: "worker",
    kind: "dispatch.worktree_ready",
    ts: input.ts ?? new Date().toISOString(),
    meta: {
      worktree_mode: input.worktreeMode,
      duration_ms: input.durationMs,
      ...(input.gitHooks ? { git_hooks: input.gitHooks.status } : {}),
    },
  };
}
