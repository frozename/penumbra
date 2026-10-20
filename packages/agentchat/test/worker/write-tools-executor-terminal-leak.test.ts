import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContext } from "@src/sdk/adapter.js";
import { DEFAULT_SANDBOX_CONFIG } from "@src/worker/sandbox-config.js";
import { TerminalCapExceededError } from "@src/worker/write-tools-errors.js";
import {
  WriteToolsExecutor,
  type WriteToolsExecutorOpts,
} from "@src/worker/write-tools-executor.js";

// The exact error the worker's audit emitter throws when the daemon's
// /observations call outlives AbortSignal.timeout(10_000): a DOMException
// TimeoutError with numeric code 23 and a 24-character message.
function observeTimeout(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

// Age after which an exited terminal whose output was never read may be reaped.
const STALE_EXITED_MS = 5 * 60_000;

const CTX: ToolCallContext = {
  toolName: "terminal.create",
  rawInput: {},
  dispatchId: "d-test",
};

const noop = (): void => {
  // silent logger
};

const SILENT_LOGGER: WriteToolsExecutorOpts["logger"] = {
  warn: noop,
  info: noop,
  debug: noop,
  error: noop,
};

interface ExecutorSetup {
  maxConcurrent: number;
  failSpawnedAudit?: () => boolean;
  logger?: WriteToolsExecutorOpts["logger"];
  onEmit?: (type: string, payload: unknown) => void;
}

async function withExecutor(
  setup: ExecutorSetup,
  fn: (executor: WriteToolsExecutor) => Promise<void>,
): Promise<void> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "terminal-leak-"));
  const failSpawnedAudit = setup.failSpawnedAudit ?? ((): boolean => false);
  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: (): Promise<"approve"> => Promise.resolve("approve"),
    auditEmitter: {
      emit: (type, payload): Promise<void> => {
        setup.onEmit?.(type, payload);
        return type === "terminal.spawned" && failSpawnedAudit()
          ? Promise.reject(observeTimeout())
          : Promise.resolve();
      },
    },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG, maxConcurrent: setup.maxConcurrent },
    logger: setup.logger ?? SILENT_LOGGER,
    handoffId: "h-test",
    dispatchId: "d-test",
  });
  try {
    await fn(executor);
  } finally {
    await executor.dispose();
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

async function settleChildren(executor: WriteToolsExecutor): Promise<void> {
  await Promise.all([...executor.__oneShotTerminals.values()].map((h) => h.done.catch(() => null)));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return undefined;
}

function backdateExit(executor: WriteToolsExecutor, terminal_id: string, ageMs: number): void {
  const handle = executor.__oneShotTerminals.get(terminal_id);
  expect(typeof handle?.exitedAt).toBe("number");
  if (handle) handle.exitedAt = Date.now() - ageMs;
}

describe("WriteToolsExecutor terminal slots survive a slow audit sink", () => {
  test("terminalCreate never holds a cap slot the caller cannot release", async () => {
    let auditDown = true;
    await withExecutor(
      { maxConcurrent: 3, failSpawnedAudit: () => auditDown },
      async (executor) => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          try {
            ids.push((await executor.terminalCreate({ argv: ["true"] }, CTX)).terminal_id);
          } catch {
            // a rejected create hands the caller no terminal_id to release
          }
        }
        await settleChildren(executor);
        for (const terminal_id of ids) await executor.terminalRelease({ terminal_id });

        expect(executor.__oneShotTerminals.size).toBe(0);

        auditDown = false;
        const next = await executor.terminalCreate({ argv: ["true"] }, CTX);
        expect(typeof next.terminal_id).toBe("string");
      },
    );
  });

  test("a post-spawn audit failure does not report the running command as failed", async () => {
    await withExecutor({ maxConcurrent: 1, failSpawnedAudit: () => true }, async (executor) => {
      const { terminal_id } = await executor.terminalCreate({ argv: ["true"] }, CTX);
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
      expect(exit_status.exitCode).toBe(0);
      await executor.terminalRelease({ terminal_id });
    });
  });

  test("a throw after registration frees the slot and stops the child", async () => {
    const spawned: string[] = [];
    let resolveKilled!: (reason: string) => void;
    const killed = new Promise<string>((r) => {
      resolveKilled = r;
    });
    await withExecutor(
      {
        maxConcurrent: 1,
        failSpawnedAudit: () => true,
        logger: {
          ...SILENT_LOGGER,
          warn: (): void => {
            throw new Error("log sink closed");
          },
        },
        onEmit: (type, payload) => {
          const p = payload as { terminal_id: string; reason?: string };
          if (type === "terminal.spawned") spawned.push(p.terminal_id);
          if (type === "terminal.killed" && p.terminal_id === spawned[0])
            resolveKilled(p.reason ?? "");
        },
      },
      async (executor) => {
        const err = await rejectionOf(executor.terminalCreate({ argv: ["sleep", "30"] }, CTX));
        expect(err).toBeInstanceOf(Error);
        expect(spawned).toHaveLength(1);
        expect(executor.__oneShotTerminals.size).toBe(0);

        const reason = await Promise.race([
          killed,
          new Promise<string>((r) => {
            setTimeout(() => {
              r("still running");
            }, 3_000);
          }),
        ]);
        expect(reason).toBe("cancelled");
      },
    );
  });
});

describe("WriteToolsExecutor reaps exited terminals at the cap only when safe", () => {
  test("an exited terminal whose output was read after exit is reaped", async () => {
    await withExecutor({ maxConcurrent: 1 }, async (executor) => {
      const first = await executor.terminalCreate({ argv: ["echo", "first"] }, CTX);
      await executor.terminalWaitForExit(first);
      const { output } = await executor.terminalOutput(first);
      expect(output).toContain("first");
      // no terminal/release: the agent read the output, then lost the id
      const second = await executor.terminalCreate({ argv: ["true"] }, CTX);
      expect(second.terminal_id).not.toBe(first.terminal_id);
      expect(executor.__oneShotTerminals.has(first.terminal_id)).toBe(false);
    });
  });

  test("an exited terminal whose output was never read is kept while fresh", async () => {
    await withExecutor({ maxConcurrent: 1 }, async (executor) => {
      const first = await executor.terminalCreate({ argv: ["echo", "unread"] }, CTX);
      await executor.terminalWaitForExit(first);

      const err = await rejectionOf(executor.terminalCreate({ argv: ["true"] }, CTX));
      expect(err).toBeInstanceOf(TerminalCapExceededError);

      const { output, exit_status } = await executor.terminalOutput(first);
      expect(output).toContain("unread");
      expect(exit_status?.exitCode).toBe(0);
    });
  });

  test("reading output before exit does not make the terminal reapable", async () => {
    await withExecutor({ maxConcurrent: 1 }, async (executor) => {
      const first = await executor.terminalCreate({ argv: ["sleep", "0.2"] }, CTX);
      const early = await executor.terminalOutput(first);
      expect(early.exit_status).toBeUndefined();
      await executor.terminalWaitForExit(first);

      const err = await rejectionOf(executor.terminalCreate({ argv: ["true"] }, CTX));
      expect(err).toBeInstanceOf(TerminalCapExceededError);
      expect(executor.__oneShotTerminals.has(first.terminal_id)).toBe(true);
    });
  });

  test("an exited, never-read terminal is reaped once it has been exited for five minutes", async () => {
    await withExecutor({ maxConcurrent: 1 }, async (executor) => {
      const first = await executor.terminalCreate({ argv: ["true"] }, CTX);
      await executor.terminalWaitForExit(first);

      backdateExit(executor, first.terminal_id, STALE_EXITED_MS - 60_000);
      const early = await rejectionOf(executor.terminalCreate({ argv: ["true"] }, CTX));
      expect(early).toBeInstanceOf(TerminalCapExceededError);

      backdateExit(executor, first.terminal_id, STALE_EXITED_MS);
      const second = await executor.terminalCreate({ argv: ["true"] }, CTX);
      expect(second.terminal_id).not.toBe(first.terminal_id);
      expect(executor.__oneShotTerminals.has(first.terminal_id)).toBe(false);
    });
  });
});
