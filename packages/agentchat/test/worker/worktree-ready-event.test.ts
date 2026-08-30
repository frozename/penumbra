import { buildWorktreeReadyEvent } from "@src/worker/worktree-ready-event.js";
import { expect, test } from "bun:test";

test("buildWorktreeReadyEvent emits path-free completion metadata", () => {
  const event = buildWorktreeReadyEvent({
    handoffId: "h-ready",
    workerId: "worker-1",
    worktreeMode: "isolated_install",
    durationMs: 42,
    ts: "2026-06-12T00:00:00.000Z",
  });

  expect(event).toEqual({
    handoff_id: "h-ready",
    worker_id: "worker-1",
    source: "worker",
    kind: "dispatch.worktree_ready",
    ts: "2026-06-12T00:00:00.000Z",
    meta: {
      worktree_mode: "isolated_install",
      duration_ms: 42,
    },
  });
  expect(event.meta).not.toHaveProperty("worktree_path");
});
