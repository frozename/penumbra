import { expect, test } from "bun:test";

import { buildWorktreeReadyEvent } from "@src/worker/worktree-ready-event.js";

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

test("buildWorktreeReadyEvent carries the git-hook status without the hooks path", () => {
  const event = buildWorktreeReadyEvent({
    handoffId: "h-hooks",
    workerId: "worker-1",
    worktreeMode: "isolated_install",
    durationMs: 42,
    ts: "2026-06-12T00:00:00.000Z",
    gitHooks: { status: "missing", configured: ".husky/_" },
  });

  expect(event.meta).toEqual({
    worktree_mode: "isolated_install",
    duration_ms: 42,
    git_hooks: "missing",
  });
  expect(JSON.stringify(event.meta)).not.toContain(".husky");
});
