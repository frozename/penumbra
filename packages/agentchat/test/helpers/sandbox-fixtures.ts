import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PermissionDecision } from "@src/sdk/adapter.js";
import { DEFAULT_SANDBOX_CONFIG } from "@src/worker/sandbox-config.js";
import { WriteToolsExecutor } from "@src/worker/write-tools-executor.js";

export interface CapturedEvent {
  type: string;
  payload: unknown;
}

export async function withSandboxedExecutor(
  fn: (ctx: {
    executor: WriteToolsExecutor;
    worktreeRoot: string;
    events: CapturedEvent[];
    decisions: PermissionDecision[];
    pushDecision: (d: PermissionDecision) => void;
  }) => Promise<void>,
  opts?: { permissionDefault?: PermissionDecision },
): Promise<void> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "phase1d-x-"));
  const events: CapturedEvent[] = [];
  const decisions: PermissionDecision[] = [];
  let pendingDecision: PermissionDecision | null = null;
  const pushDecision = (d: PermissionDecision): void => {
    pendingDecision = d;
  };

  const noop = (): void => {
    // intentionally empty: silent logger for sandbox tests
  };
  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: (): Promise<PermissionDecision> => {
      const d = pendingDecision ?? opts?.permissionDefault ?? "approve";
      decisions.push(d);
      pendingDecision = null;
      return Promise.resolve(d);
    },
    auditEmitter: {
      emit: (type, payload): Promise<void> => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG },
    logger: { warn: noop, info: noop, debug: noop, error: noop },
    handoffId: "h-test",
    dispatchId: "d-test",
  });

  try {
    await fn({ executor, worktreeRoot, events, decisions, pushDecision });
  } finally {
    await executor.dispose();
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}
