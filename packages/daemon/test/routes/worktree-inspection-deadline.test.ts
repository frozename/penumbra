import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import {
  inspectWorktreeForHandoff,
  type WorktreeInspectionCommandRunner,
} from "@src/routes/worktree-inspection.js";

import {
  controlledGitArgs,
  createInspectionWorktree,
  createWorktreeInspectionHarness,
  type WorktreeInspectionHarness,
} from "../helpers/worktree-inspection.js";

const execFile = promisify(execFileCb);

function actualGitRunner(harness: WorktreeInspectionHarness): WorktreeInspectionCommandRunner {
  return async (args, opts) =>
    await execFile("git", controlledGitArgs(args), {
      ...opts,
      encoding: "utf8",
      env: harness.gitEnv,
    });
}

test("an already-expired caller deadline reports that inspection never started", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    let gitCalls = 0;
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      deadline: () => ({ remaining_ms: 0, expired: true }),
      runGit: () => {
        gitCalls += 1;
        return Promise.reject(new Error("must not run"));
      },
    });
    expect(result).toEqual({
      ok: false,
      code: "inspection_failed",
      message: "worktree inspection deadline expired before inspection started",
    });
    expect(gitCalls).toBe(0);
  } finally {
    harness.cleanup();
  }
});

test("a deadline that expires after base resolution names the diff step and the budget", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const actual = actualGitRunner(harness);
    let expired = false;
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      deadline: () => ({ remaining_ms: expired ? 0 : 4_321, expired }),
      runGit: async (args, opts) => {
        const gitResult = await actual(args, opts);
        if (args.includes("--verify")) expired = true;
        return gitResult;
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected deadline failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during diff \(git diff\) after \d+ ms \(budget 4321 ms\)$/,
    );
  } finally {
    harness.cleanup();
  }
});

test("a snapshot git step killed by the timeout is reported as a deadline", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const actual = actualGitRunner(harness);
    const killError = (): Error =>
      Object.assign(new Error("Command failed: git status"), {
        killed: true,
        signal: "SIGTERM",
        code: null,
        stdout: "",
        stderr: "",
      });
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: async (args, opts) => {
        if (args.includes("status")) throw killError();
        return await actual(args, opts);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected deadline failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during snapshot \(git status\) after \d+ ms \(budget 5000 ms\)$/,
    );
  } finally {
    harness.cleanup();
  }
});

test("a kill during the post-diff recheck is reported as recheck", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const actual = actualGitRunner(harness);
    let statusCalls = 0;
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: async (args, opts) => {
        if (args.includes("status")) {
          statusCalls += 1;
          if (statusCalls === 2) {
            throw Object.assign(new Error("Command failed: git status"), {
              killed: true,
              signal: "SIGTERM",
              code: null,
              stdout: "",
              stderr: "",
            });
          }
        }
        return await actual(args, opts);
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected deadline failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during recheck \(git status\) after \d+ ms \(budget 5000 ms\)$/,
    );
  } finally {
    harness.cleanup();
  }
});
