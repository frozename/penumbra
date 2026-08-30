import type { DaemonClient } from "@src/daemon-client.js";

import { fsEditHandler } from "@src/tools/fs-edit.js";
import { fsExecHandler } from "@src/tools/fs-exec.js";
import { fsGlobHandler } from "@src/tools/fs-glob.js";
import { fsGrepHandler } from "@src/tools/fs-grep.js";
import { fsReadHandler } from "@src/tools/fs-read.js";
import { fsWriteHandler } from "@src/tools/fs-write.js";
import { resolveHandoffId } from "@src/tools/handoff-guard.js";
import { shellCloseHandler } from "@src/tools/shell-close.js";
import { shellListHandler } from "@src/tools/shell-list.js";
import { shellRunHandler } from "@src/tools/shell-run.js";
import { worktreeCleanupHandler } from "@src/tools/worktree-cleanup.js";
import { worktreeInspectHandler } from "@src/tools/worktree-inspect.js";
import { afterEach, describe, expect, it } from "bun:test";

interface TextOutput {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function parseText(out: unknown): unknown {
  const typed = out as TextOutput;
  const first = typed.content[0];
  if (!first) throw new Error("missing content[0]");
  return JSON.parse(first.text);
}

function isError(out: unknown): boolean {
  return (out as TextOutput).isError === true;
}

function expectCrossHandoffDenied(out: unknown): void {
  expect(isError(out)).toBe(true);
  const parsed = parseText(out) as { error: { code: string; message: string } };
  expect(parsed.error.code).toBe("cross_handoff_denied");
}

/**
 * A daemon whose every worktree/shell method is a landmine: calling any of
 * them fails the test immediately. Cross-handoff rejection must happen at
 * the tool boundary, BEFORE any daemon RPC — verified by using this as the
 * fake daemon and asserting the error came back structured (not thrown).
 */
function forbiddenDaemon(): DaemonClient {
  const trap =
    (name: string) =>
    (...args: unknown[]): never => {
      throw new Error(
        `daemon.${name} must not be called when cross_handoff_denied is triggered; args=${JSON.stringify(args)}`,
      );
    };
  const daemon: Record<string, unknown> = {
    readInWorktree: trap("readInWorktree"),
    writeInWorktree: trap("writeInWorktree"),
    editInWorktree: trap("editInWorktree"),
    execInWorktree: trap("execInWorktree"),
    globInWorktree: trap("globInWorktree"),
    grepInWorktree: trap("grepInWorktree"),
    shellRun: trap("shellRun"),
    shellClose: trap("shellClose"),
    shellList: trap("shellList"),
    cleanupWorktree: trap("cleanupWorktree"),
    inspectWorktree: trap("inspectWorktree"),
  };
  return daemon as unknown as DaemonClient;
}

describe("resolveHandoffId", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("env unset + explicit id -> returns explicit id", () => {
    const res = resolveHandoffId("H_EXPLICIT");
    expect(res).toEqual({ ok: true, handoff_id: "H_EXPLICIT" });
  });

  it("env set + no explicit id -> returns env id", () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    const res = resolveHandoffId();
    expect(res).toEqual({ ok: true, handoff_id: "H_ENV" });
  });

  it("env set + matching explicit id -> returns id", () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    const res = resolveHandoffId("H_ENV");
    expect(res).toEqual({ ok: true, handoff_id: "H_ENV" });
  });

  it("env set + differing explicit id -> cross_handoff_denied", () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const res = resolveHandoffId("H_B");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.code).toBe("cross_handoff_denied");
  });

  it("env unset + no explicit id -> no_handoff_context", () => {
    const res = resolveHandoffId();
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error.code).toBe("no_handoff_context");
  });

  it("env set + null/empty explicit id -> uses env (does not deny)", () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    expect(resolveHandoffId(undefined)).toEqual({ ok: true, handoff_id: "H_ENV" });
    expect(resolveHandoffId(null)).toEqual({ ok: true, handoff_id: "H_ENV" });
  });
});

describe("cross_handoff_denied policy per tool", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("fs.read rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = fsReadHandler(forbiddenDaemon());
    const out = await handler({ path: "f.txt", handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("fs.write rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = fsWriteHandler(forbiddenDaemon());
    const out = await handler({ path: "f.txt", content: "x", handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("fs.edit rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = fsEditHandler(forbiddenDaemon());
    const out = await handler({
      path: "f.txt",
      old_string: "a",
      new_string: "b",
      handoff_id: "H_B",
    });
    expectCrossHandoffDenied(out);
  });

  it("fs.exec rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = fsExecHandler(forbiddenDaemon());
    const out = await handler({ command: "echo hi", handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("fs.glob rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = fsGlobHandler(forbiddenDaemon());
    const out = await handler({ pattern: "**/*.ts", handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("fs.grep rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = fsGrepHandler(forbiddenDaemon());
    const out = await handler({ pattern: "foo", handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("shell.run rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = shellRunHandler(forbiddenDaemon());
    const out = await handler({ handoff_id: "H_B", agent_name: "a", command: "echo" });
    expectCrossHandoffDenied(out);
  });

  it("shell.close rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = shellCloseHandler(forbiddenDaemon());
    const out = await handler({ handoff_id: "H_B", session_id: "s1" });
    expectCrossHandoffDenied(out);
  });

  it("shell.list rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = shellListHandler(forbiddenDaemon());
    const out = await handler({ handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("worktree.cleanup rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = worktreeCleanupHandler(forbiddenDaemon());
    const out = await handler({ handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });

  it("worktree.inspect rejects when explicit id differs from env and does NOT call daemon", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    const handler = worktreeInspectHandler(forbiddenDaemon());
    const out = await handler({ handoff_id: "H_B" });
    expectCrossHandoffDenied(out);
  });
});

describe("allowed-shape cases still pass through", () => {
  afterEach(() => {
    delete process.env.PENUMBRA_HANDOFF_ID;
  });

  it("fs.read: env set + matching explicit id -> daemon called with id", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_A";
    let received = "";
    const daemon = {
      readInWorktree: (
        id: string,
      ): Promise<{ content: string; path: string; bytes: number; truncated: boolean }> => {
        received = id;
        return Promise.resolve({ content: "x", path: "f", bytes: 1, truncated: false });
      },
    };
    const handler = fsReadHandler(daemon);
    await handler({ path: "f", handoff_id: "H_A" });
    expect(received).toBe("H_A");
  });

  it("fs.read: env unset + explicit id=B -> daemon called with B (operator context)", async () => {
    let received = "";
    const daemon = {
      readInWorktree: (
        id: string,
      ): Promise<{ content: string; path: string; bytes: number; truncated: boolean }> => {
        received = id;
        return Promise.resolve({ content: "x", path: "f", bytes: 1, truncated: false });
      },
    };
    const handler = fsReadHandler(daemon);
    await handler({ path: "f", handoff_id: "H_B" });
    expect(received).toBe("H_B");
  });

  it("worktree.cleanup: env set + matching explicit id -> daemon called with id", async () => {
    process.env.PENUMBRA_HANDOFF_ID = "H_ENV";
    let receivedId = "";
    let receivedForce: boolean | undefined;
    const daemon = {
      cleanupWorktree: (id: string, force?: boolean): Promise<{ status: string }> => {
        receivedId = id;
        receivedForce = force;
        return Promise.resolve({ status: "torn_down" });
      },
    };
    const handler = worktreeCleanupHandler(daemon as unknown as DaemonClient);
    await handler({ handoff_id: "H_ENV", force: true });
    expect(receivedId).toBe("H_ENV");
    expect(receivedForce).toBe(true);
  });
});
