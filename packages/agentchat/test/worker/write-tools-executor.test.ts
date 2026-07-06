import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "../../src/worker/sandbox-config.js";
import {
  EditAmbiguousError,
  EditMissError,
  IoError,
  NotAFileError,
  OperationRejectedError,
  OutsideWorktreeError,
  TerminalCapExceededError,
  TerminalNotFoundError,
} from "../../src/worker/write-tools-errors.js";
import { WriteToolsExecutor } from "../../src/worker/write-tools-executor.js";
import { withSandboxedExecutor } from "../helpers/sandbox-fixtures.js";

interface CapturedEvent {
  type: string;
  payload: unknown;
}

interface FsWriteAppliedPayload {
  path: string;
  bytes: number;
  sha256: string;
  prev_sha256: string | null;
  handoff_id: string;
}

interface FsEditAppliedPayload {
  path: string;
  bytes_added: number;
  bytes_removed: number;
  sha256: string;
  prev_sha256: string;
  handoff_id: string;
}

interface TerminalKilledPayload {
  terminal_id: string;
  reason: string;
  handoff_id: string;
}

function asWritePayload(p: unknown): FsWriteAppliedPayload {
  return p as FsWriteAppliedPayload;
}

function asEditPayload(p: unknown): FsEditAppliedPayload {
  return p as FsEditAppliedPayload;
}

function asKilledPayload(p: unknown): TerminalKilledPayload {
  return p as TerminalKilledPayload;
}

const noop = (): void => {
  // intentionally empty: silent logger for executor tests
};

async function expectRejection(
  promise: Promise<unknown>,
  Cls: new (...args: never[]) => Error,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Cls);
}

async function expectAnyRejection(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  return caught;
}

async function withCustomSandboxedExecutor(
  fn: (ctx: { executor: WriteToolsExecutor; events: CapturedEvent[] }) => Promise<void>,
  sandboxConfigOverrides: Partial<SandboxConfig>,
): Promise<void> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "phase1d-terminal-"));
  const events: CapturedEvent[] = [];
  const executor = new WriteToolsExecutor({
    worktreeRoot,
    permissionCallback: (): Promise<"approve"> => Promise.resolve("approve"),
    auditEmitter: {
      emit: (type, payload): Promise<void> => {
        events.push({ type, payload });
        return Promise.resolve();
      },
    },
    sandboxConfig: { ...DEFAULT_SANDBOX_CONFIG, ...sandboxConfigOverrides },
    logger: { warn: noop, info: noop, debug: noop, error: noop },
    handoffId: "h-test",
    dispatchId: "d-test",
  });

  try {
    await fn({ executor, events });
  } finally {
    await executor.dispose();
    await rm(worktreeRoot, { recursive: true, force: true });
  }
}

describe("WriteToolsExecutor — scaffolding", () => {
  test("constructs and disposes idempotently", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.dispose();
      await executor.dispose(); // second call is a no-op
    });
  });

  test("gate path: reject decision throws OperationRejectedError without reaching impl", () => {
    expect(new OperationRejectedError("x").code).toBe("operation_rejected");
  });
});

describe("WriteToolsExecutor.writeTextFile", () => {
  test("happy path: writes content, returns sha256, emits fs.write_applied", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events }) => {
      const r = await executor.writeTextFile(
        { path: "foo.txt", content: "hello" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesWritten).toBe(5);
      expect(r.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
      expect(await readFile(join(worktreeRoot, "foo.txt"), "utf8")).toBe("hello");
      expect(events.some((e) => e.type === "fs.write_applied")).toBe(true);
    });
  });

  test("permission denial throws OperationRejectedError without writing or emitting", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events, pushDecision }) => {
      pushDecision("reject");
      await expectRejection(
        executor.writeTextFile(
          { path: "denied.txt", content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        OperationRejectedError,
      );
      // file must not exist
      await expectAnyRejection(readFile(join(worktreeRoot, "denied.txt"), "utf8"));
      expect(events.some((e) => e.type === "fs.write_applied")).toBe(false);
    });
  });

  test("outside-worktree absolute path throws OutsideWorktreeError", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await expectRejection(
        executor.writeTextFile(
          { path: "/etc/passwd", content: "pwned" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        OutsideWorktreeError,
      );
      expect(events.some((e) => e.type === "fs.write_applied")).toBe(false);
    });
  });

  test("symlink-to-outside throws OutsideWorktreeError", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      await symlink("/etc", join(worktreeRoot, "escape"));
      await expectRejection(
        executor.writeTextFile(
          { path: "escape/passwd", content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        OutsideWorktreeError,
      );
    });
  });

  test("prev_sha256 captured on overwrite", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "a.txt", content: "a" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.writeTextFile(
        { path: "a.txt", content: "b" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const writeEvents = events.filter((e) => e.type === "fs.write_applied");
      expect(writeEvents.length).toBe(2);
      expect(asWritePayload(writeEvents.at(1)?.payload).prev_sha256).toBe(
        createHash("sha256").update("a").digest("hex"),
      );
    });
  });

  test("prev_sha256 null on new file", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "new.txt", content: "x" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(asWritePayload(events.at(0)?.payload).prev_sha256).toBeNull();
    });
  });

  test("path-is-directory throws NotAFileError", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      await mkdir(join(worktreeRoot, "mydir"), { recursive: true });
      await expectRejection(
        executor.writeTextFile(
          { path: "mydir", content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        NotAFileError,
      );
    });
  });

  test("parent auto-create within depth (3 levels)", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      const r = await executor.writeTextFile(
        { path: "a/b/c.txt", content: "x" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesWritten).toBe(1);
      expect(await readFile(join(worktreeRoot, "a/b/c.txt"), "utf8")).toBe("x");
    });
  });

  test("parent auto-create beyond depth throws IoError", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expectRejection(
        executor.writeTextFile(
          { path: "a/b/c/d/e.txt", content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        IoError,
      );
    });
  });

  test("absolute path can write a new file inside an existing deep directory", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      const existingDir = join(worktreeRoot, "packages/core/src");
      await mkdir(existingDir, { recursive: true });

      const absolutePath = join(existingDir, "new-file.ts");
      const r = await executor.writeTextFile(
        { path: absolutePath, content: "export const value = 1;\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );

      expect(r.bytesWritten).toBe(24);
      expect(await readFile(absolutePath, "utf8")).toBe("export const value = 1;\n");
    });
  });

  test("absolute path auto-create beyond relative worktree depth throws IoError", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      await expectRejection(
        executor.writeTextFile(
          { path: join(worktreeRoot, "a/b/c/d/e.txt"), content: "x" },
          {
            toolName: "fs.write_text_file",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        IoError,
      );
    });
  });

  test("audit raw_input (in event payload) is path+content_bytes only, never full content", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const big = "x".repeat(100_000);
      await executor.writeTextFile(
        { path: "big.txt", content: big },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const event = events.find((e) => e.type === "fs.write_applied");
      expect(event).toBeDefined();
      // bytes is the captured size, but the full content never appears in payload_json
      expect(asWritePayload(event?.payload).bytes).toBe(100_000);
      const payloadStr = JSON.stringify(event?.payload);
      expect(payloadStr.includes(big)).toBe(false);
    });
  });

  test("bytesWritten counts utf-8 bytes for multi-byte chars", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      // 日 = 3 bytes utf8; 本 = 3 bytes utf8 → total 6 bytes
      const r = await executor.writeTextFile(
        { path: "jp.txt", content: "日本" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesWritten).toBe(6);
    });
  });

  test("event count is exactly one per successful write", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "one.txt", content: "x" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(events.filter((e) => e.type === "fs.write_applied").length).toBe(1);
    });
  });

  test("concurrent same-path writeTextFile calls serialize (no lost-update via racing prev_sha256)", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "race.txt", content: "orig" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const origSha = createHash("sha256").update("orig").digest("hex");
      events.length = 0;

      const N = 10;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          executor.writeTextFile(
            { path: "race.txt", content: `payload-${String(i)}` },
            {
              toolName: "fs.write_text_file",
              rawInput: {},
              dispatchId: "d-test",
            },
          ),
        ),
      );

      const writeEvents = events.filter((e) => e.type === "fs.write_applied");
      expect(writeEvents.length).toBe(N);
      // Under the fix, exactly one racing writer observes the pre-race original.
      // Without the fix, every concurrent stat/read sees "orig" → this count > 1.
      const sawOriginal = writeEvents.filter(
        (e) => asWritePayload(e.payload).prev_sha256 === origSha,
      );
      expect(sawOriginal.length).toBe(1);
    });
  });
});

describe("WriteToolsExecutor.terminal* (one-shot)", () => {
  test("happy path: create + wait_for_exit returns exit_status 0 for echo", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["echo", "hi"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
      const out = await executor.terminalOutput({ terminal_id });
      expect(exit_status.exitCode).toBe(0);
      expect(out.output.trim()).toBe("hi");
      await executor.terminalRelease({ terminal_id });
      expect(events.some((e) => e.type === "terminal.spawned")).toBe(true);
      expect(events.some((e) => e.type === "terminal.exited")).toBe(true);
    });
  });

  test("argv preferred over cmd when both set", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate(
        {
          argv: ["echo", "A"],
          command: "echo B",
        },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const { output } = await executor.terminalOutput({ terminal_id });
      expect(output.trim()).toBe("A");
    });
  });

  test("cmd form runs via bash -c", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate(
        { command: "echo hi-cmd" },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const { output } = await executor.terminalOutput({ terminal_id });
      expect(output.trim()).toBe("hi-cmd");
    });
  });

  test("output truncation flag with output_byte_limit", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate(
        { command: "yes", output_byte_limit: 4096 },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalWaitForExit({ terminal_id });
      const { truncated } = await executor.terminalOutput({ terminal_id });
      expect(truncated).toBe(true);
    });
  });

  test("terminalOutput on unknown id throws TerminalNotFoundError", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expectRejection(
        executor.terminalOutput({ terminal_id: "nonexistent" }),
        TerminalNotFoundError,
      );
    });
  });

  test("terminalWaitForExit on unknown id throws TerminalNotFoundError", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expectRejection(
        executor.terminalWaitForExit({ terminal_id: "nonexistent" }),
        TerminalNotFoundError,
      );
    });
  });

  test("terminalRelease on unknown id is silent no-op", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      let caught: unknown;
      try {
        await executor.terminalRelease({ terminal_id: "nonexistent" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeUndefined();
    });
  });

  test("terminalKill emits terminal.killed reason=operator", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["sleep", "5"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalKill({ terminal_id });
      expect(
        events.some(
          (e) => e.type === "terminal.killed" && asKilledPayload(e.payload).reason === "operator",
        ),
      ).toBe(true);
    });
  });

  test("permission denial throws and emits no terminal.spawned", async () => {
    await withSandboxedExecutor(async ({ executor, events, pushDecision }) => {
      pushDecision("reject");
      await expectAnyRejection(
        executor.terminalCreate(
          { argv: ["echo", "no"] },
          {
            toolName: "terminal.create",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
      );
      expect(events.some((e) => e.type === "terminal.spawned")).toBe(false);
    });
  });

  test("cwd outside worktree throws OutsideWorktreeError before spawn", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await expectRejection(
        executor.terminalCreate(
          { argv: ["echo", "x"], cwd: "/etc" },
          {
            toolName: "terminal.create",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        OutsideWorktreeError,
      );
      expect(events.some((e) => e.type === "terminal.spawned")).toBe(false);
    });
  });

  test("release before wait_for_exit cleans up running process", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const { terminal_id } = await executor.terminalCreate(
        { argv: ["sleep", "5"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.terminalRelease({ terminal_id });
      await expectRejection(executor.terminalOutput({ terminal_id }), TerminalNotFoundError);
    });
  });

  test("dispose during running terminal aborts and emits dispatch_end killed event", async () => {
    let capturedEvents: CapturedEvent[] = [];
    await withSandboxedExecutor(async ({ executor, events }) => {
      capturedEvents = events;
      await executor.terminalCreate(
        { argv: ["sleep", "10"] },
        {
          toolName: "terminal.create",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
    });
    expect(
      capturedEvents.some(
        (e) => e.type === "terminal.killed" && asKilledPayload(e.payload).reason === "dispatch_end",
      ),
    ).toBe(true);
  });

  test("concurrent terminal cap exceeded throws TerminalCapExceededError", async () => {
    await withCustomSandboxedExecutor(
      async ({ executor }) => {
        await executor.terminalCreate(
          { argv: ["sleep", "5"] },
          {
            toolName: "terminal.create",
            rawInput: {},
            dispatchId: "d-test",
          },
        );
        await expectRejection(
          executor.terminalCreate(
            { argv: ["echo", "blocked"] },
            {
              toolName: "terminal.create",
              rawInput: {},
              dispatchId: "d-test",
            },
          ),
          TerminalCapExceededError,
        );
      },
      { maxConcurrent: 1 },
    );
  });

  test("timeout emits terminal.killed reason=timeout", async () => {
    await withCustomSandboxedExecutor(
      async ({ executor }) => {
        const { terminal_id } = await executor.terminalCreate(
          { argv: ["sleep", "5"] },
          {
            toolName: "terminal.create",
            rawInput: {},
            dispatchId: "d-test",
          },
        );
        const { exit_status } = await executor.terminalWaitForExit({ terminal_id });
        expect(exit_status.exitCode).not.toBe(0);
      },
      { timeoutMs: 100 },
    );
  });
});

describe("WriteToolsExecutor.editTextFile", () => {
  test("happy path: replaces unique match, emits fs.edit_applied", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot, events }) => {
      await executor.writeTextFile(
        { path: "a.ts", content: "export const x = 1;\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const r = await executor.editTextFile(
        { path: "a.ts", old_string: "x = 1", new_string: "x = 2" },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesAdded).toBe(5);
      expect(r.bytesRemoved).toBe(5);
      expect(await readFile(join(worktreeRoot, "a.ts"), "utf8")).toBe("export const x = 2;\n");
      expect(events.filter((e) => e.type === "fs.edit_applied").length).toBe(1);
    });
  });

  test("multi-match without replace_all throws EditAmbiguousError with occurrences", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.writeTextFile(
        { path: "m.txt", content: "aa\naa\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const caught = await captureRejection(
        executor.editTextFile(
          { path: "m.txt", old_string: "aa", new_string: "bb" },
          {
            toolName: "fs.edit",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
      );
      expect(caught).toBeInstanceOf(EditAmbiguousError);
      const e = caught as EditAmbiguousError;
      expect(e.code).toBe("edit_ambiguous");
      expect(e.occurrences).toBe(2);
    });
  });

  test("multi-match with replace_all=true replaces all", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      await executor.writeTextFile(
        { path: "m.txt", content: "aa\naa\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const r = await executor.editTextFile(
        { path: "m.txt", old_string: "aa", new_string: "bb", replace_all: true },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesAdded).toBe(4);
      expect(r.bytesRemoved).toBe(4);
      expect(await readFile(join(worktreeRoot, "m.txt"), "utf8")).toBe("bb\nbb\n");
    });
  });

  test("missing match throws EditMissError with bytes hint", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.writeTextFile(
        { path: "h.txt", content: "hello\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const caught = await captureRejection(
        executor.editTextFile(
          { path: "h.txt", old_string: "world", new_string: "x" },
          {
            toolName: "fs.edit",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
      );
      expect(caught).toBeInstanceOf(EditMissError);
      const e = caught as EditMissError;
      expect(e.code).toBe("edit_miss");
      expect(e.bytes).toBe(6); // 'hello\n' is 6 bytes
    });
  });

  test("old_string === new_string is no-op (no event)", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "n.txt", content: "noop\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const editEventsBefore = events.filter((e) => e.type === "fs.edit_applied").length;
      const r = await executor.editTextFile(
        { path: "n.txt", old_string: "noop", new_string: "noop" },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesAdded).toBe(0);
      expect(r.bytesRemoved).toBe(0);
      expect(events.filter((e) => e.type === "fs.edit_applied").length).toBe(editEventsBefore); // no new event
    });
  });

  test("empty old_string throws EditAmbiguousError", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.writeTextFile(
        { path: "e.txt", content: "x\n" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await expectRejection(
        executor.editTextFile(
          { path: "e.txt", old_string: "", new_string: "y" },
          {
            toolName: "fs.edit",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        EditAmbiguousError,
      );
    });
  });

  test("file missing throws EditMissError", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      const caught = await captureRejection(
        executor.editTextFile(
          { path: "missing.txt", old_string: "x", new_string: "y" },
          {
            toolName: "fs.edit",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
      );
      expect(caught).toBeInstanceOf(EditMissError);
      expect((caught as EditMissError).code).toBe("edit_miss");
    });
  });

  test("permission denial throws OperationRejectedError", async () => {
    await withSandboxedExecutor(async ({ executor, pushDecision }) => {
      pushDecision("reject");
      await expectRejection(
        executor.editTextFile(
          { path: "p.txt", old_string: "a", new_string: "b" },
          {
            toolName: "fs.edit",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        OperationRejectedError,
      );
    });
  });

  test("outside-worktree path throws OutsideWorktreeError", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await expectRejection(
        executor.editTextFile(
          { path: "/etc/passwd", old_string: "x", new_string: "y" },
          {
            toolName: "fs.edit",
            rawInput: {},
            dispatchId: "d-test",
          },
        ),
        OutsideWorktreeError,
      );
    });
  });

  test("prev_sha256 in event payload matches existing content sha256", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "s.txt", content: "before" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.editTextFile(
        { path: "s.txt", old_string: "before", new_string: "after" },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      const editEvent = events.find((e) => e.type === "fs.edit_applied");
      expect(editEvent).toBeDefined();
      expect(asEditPayload(editEvent?.payload).prev_sha256).toBe(
        createHash("sha256").update("before").digest("hex"),
      );
    });
  });

  test("bytesAdded/bytesRemoved correct for multi-byte chars", async () => {
    await withSandboxedExecutor(async ({ executor }) => {
      await executor.writeTextFile(
        { path: "jp.txt", content: "日" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      // 日 = 3 bytes utf8; 本本 = 6 bytes utf8 → bytesRemoved=3, bytesAdded=6
      const r = await executor.editTextFile(
        { path: "jp.txt", old_string: "日", new_string: "本本" },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(r.bytesRemoved).toBe(3);
      expect(r.bytesAdded).toBe(6);
    });
  });

  test("concurrent same-path editTextFile calls serialize (no lost-update on interleaved edits)", async () => {
    await withSandboxedExecutor(async ({ executor, worktreeRoot }) => {
      const N = 8;
      const initial = Array.from({ length: N }, (_, i) => `X${String(i)}`).join("|");
      await executor.writeTextFile(
        { path: "edit-race.txt", content: initial },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );

      // Each edit targets a unique marker; if the read→rename critical section
      // is unserialized every edit races on the original bytes and rename order
      // decides the final state, dropping N-1 edits. With the lock all N apply.
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          executor.editTextFile(
            {
              path: "edit-race.txt",
              old_string: `X${String(i)}`,
              new_string: `Y${String(i)}`,
            },
            {
              toolName: "fs.edit",
              rawInput: {},
              dispatchId: "d-test",
            },
          ),
        ),
      );

      const final = await readFile(join(worktreeRoot, "edit-race.txt"), "utf8");
      const expected = Array.from({ length: N }, (_, i) => `Y${String(i)}`).join("|");
      expect(final).toBe(expected);
    });
  });

  test("event count is exactly one per successful edit", async () => {
    await withSandboxedExecutor(async ({ executor, events }) => {
      await executor.writeTextFile(
        { path: "c.txt", content: "aa" },
        {
          toolName: "fs.write_text_file",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      await executor.editTextFile(
        { path: "c.txt", old_string: "aa", new_string: "bb" },
        {
          toolName: "fs.edit",
          rawInput: {},
          dispatchId: "d-test",
        },
      );
      expect(events.filter((e) => e.type === "fs.edit_applied").length).toBe(1);
    });
  });
});
