import type { HeavyJobGate } from "@penumbra/core";

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolCallContext } from "@src/sdk/adapter.js";
import { DEFAULT_SANDBOX_CONFIG } from "@src/worker/sandbox-config.js";
import {
  WriteToolsExecutor,
  type WriteToolsExecutorOpts,
} from "@src/worker/write-tools-executor.js";

import type { CapturedEvent } from "../helpers/sandbox-fixtures.js";

const CTX: ToolCallContext = {
  toolName: "terminal.create",
  rawInput: {},
  dispatchId: "h1",
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

interface TerminalKilledPayload {
  terminal_id: string;
  reason: string;
  handoff_id: string;
}

async function withExecutor(
  heavyJobGate: HeavyJobGate | undefined,
  fn: (ctx: {
    executor: WriteToolsExecutor;
    events: CapturedEvent[];
    worktreeRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "wte-heavy-admission-"));
  const events: CapturedEvent[] = [];
  const opts = {
    worktreeRoot,
    permissionCallback: (): Promise<"approve"> => Promise.resolve("approve"),
    auditEmitter: {
      emit: (type: string, payload: unknown): Promise<void> => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG },
    logger: SILENT_LOGGER,
    handoffId: "h1",
    dispatchId: "h1",
  };
  const executor = new WriteToolsExecutor(
    heavyJobGate === undefined ? opts : { ...opts, heavyJobGate },
  );
  try {
    await fn({ executor, events, worktreeRoot });
  } finally {
    await executor.dispose();
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

describe("WriteToolsExecutor heavy-job admission", () => {
  test("an admitted gate wraps the terminal run and is released exactly once", async () => {
    const enterLabels: string[] = [];
    const order: string[] = [];
    let releases = 0;
    const gate: HeavyJobGate = {
      enter: (label: string): ReturnType<HeavyJobGate["enter"]> => {
        enterLabels.push(label);
        order.push(`enter:${label}`);
        return Promise.resolve({
          ok: true,
          admission: { admitted: true, availableGiB: 30, waitedMs: 0 },
          release: (): Promise<void> => {
            releases++;
            order.push("release");
            return Promise.resolve();
          },
        });
      },
    };
    await withExecutor(gate, async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate(
        { command: "tsc --noEmit >/dev/null 2>&1; exit 0" },
        CTX,
      );
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });

      expect(enterLabels).toEqual(["terminal-typecheck"]);
      expect(releases).toBe(1);
      expect(order).toEqual(["enter:terminal-typecheck", "release"]);
      expect(exit_status.exitCode).toBe(0);
    });
  });

  test("a denied gate runs nothing, exits 1, and emits terminal.killed resource", async () => {
    const enterLabels: string[] = [];
    const gate: HeavyJobGate = {
      enter: (label: string): ReturnType<HeavyJobGate["enter"]> => {
        enterLabels.push(label);
        return Promise.resolve({
          ok: false,
          reason: "host memory admission timeout: MemAvailable 4.0 GiB < 20 GiB after 900s",
        });
      },
    };
    await withExecutor(gate, async ({ executor, events, worktreeRoot }) => {
      const { terminal_id } = await executor.terminalCreate(
        { command: "touch ran; eslint ." },
        CTX,
      );
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
      // terminal.killed is emitted from the spawn-tracking .then chain after
      // done resolves; one macrotask lets those microtasks drain.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(enterLabels).toEqual(["terminal-lint"]);
      expect(exit_status.exitCode).toBe(1);
      expect(existsSync(join(worktreeRoot, "ran"))).toBe(false);
      const killed = events.find((e) => e.type === "terminal.killed");
      expect(killed).toBeDefined();
      const payload = killed?.payload as TerminalKilledPayload | undefined;
      expect(payload?.reason).toBe("resource");
      expect(payload?.handoff_id).toBe("h1");
    });
  });

  test("without a gate the same command runs to completion", async () => {
    await withExecutor(undefined, async ({ executor, worktreeRoot }) => {
      const { terminal_id } = await executor.terminalCreate(
        { command: "touch ran; eslint ." },
        CTX,
      );
      await executor.terminalWaitForExit({ terminal_id });

      expect(existsSync(join(worktreeRoot, "ran"))).toBe(true);
    });
  });
});
