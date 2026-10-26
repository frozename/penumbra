import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  inspectWorktreeForHandoff,
  type WorktreeInspectionCommandRunner,
} from "@src/routes/worktree-inspection.js";
import { worktreesInspectRoute } from "@src/routes/worktrees.js";

import {
  controlledGitArgs,
  createInspectionWorktree,
  createWorktreeInspectionHarness,
  gitOutput,
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

function timeoutKill(command: string): Error {
  return Object.assign(new Error(`Command failed: git ${command}`), {
    killed: true,
    signal: "SIGTERM",
    code: null,
    stdout: "",
    stderr: "",
  });
}

// #263: run Git for real, except the `occurrence`-th call whose args contain
// `marker`, which is killed the way execFile reports a command timeout.
function killOnMatch(
  harness: WorktreeInspectionHarness,
  marker: string,
  occurrence = 1,
): WorktreeInspectionCommandRunner {
  const actual = actualGitRunner(harness);
  let matches = 0;
  return async (args, opts) => {
    if (args.includes(marker)) {
      matches += 1;
      if (matches === occurrence) throw timeoutKill(marker);
    }
    return await actual(args, opts);
  };
}

function failOnDiff(harness: WorktreeInspectionHarness): WorktreeInspectionCommandRunner {
  const actual = actualGitRunner(harness);
  return async (args, opts) => {
    if (args.includes("diff")) {
      throw Object.assign(new Error("fatal: bad object"), { code: 128 });
    }
    return await actual(args, opts);
  };
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

test("a deadline during the diff returns the snapshot head, branch and dirty flag as unverified partial data", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const head = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(handle.path, "uncommitted.txt"), "uncommitted\n");
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: killOnMatch(harness, "diff"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected inspection failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during diff \(git diff\) after \d+ ms \(budget 5000 ms\)$/,
    );
    expect(result.partial).toStrictEqual({
      head_sha: head,
      branch_name: handle.branchName,
      dirty: true,
      base_ref: "main",
      verified: false,
    });
  } finally {
    harness.cleanup();
  }
});

test("a deadline during base resolution returns partial data without base_ref", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const head = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: killOnMatch(harness, "--verify"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected inspection failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during base \(git rev-parse\) after \d+ ms \(budget 5000 ms\)$/,
    );
    expect(result.partial).toStrictEqual({
      head_sha: head,
      branch_name: handle.branchName,
      dirty: false,
      verified: false,
    });
  } finally {
    harness.cleanup();
  }
});

test("a deadline during the recheck still returns the first snapshot as partial data", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const head = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: killOnMatch(harness, "status", 2),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected inspection failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during recheck \(git status\) after \d+ ms \(budget 5000 ms\)$/,
    );
    expect(result.partial).toStrictEqual({
      head_sha: head,
      branch_name: handle.branchName,
      dirty: false,
      base_ref: "main",
      verified: false,
    });
  } finally {
    harness.cleanup();
  }
});

test("a deadline during the first snapshot returns no partial data", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: killOnMatch(harness, "status"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected inspection failure");
    expect(result.message).toMatch(
      /^worktree inspection deadline expired during snapshot \(git status\) after \d+ ms \(budget 5000 ms\)$/,
    );
    expect(result).not.toHaveProperty("partial");
  } finally {
    harness.cleanup();
  }
});

test("a non-deadline Git failure after the snapshot returns no partial data", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
      expectedProjectId: "project-a",
      runGit: failOnDiff(harness),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected inspection failure");
    expect(result).toStrictEqual({
      ok: false,
      code: "inspection_failed",
      message: "fatal: bad object",
    });
  } finally {
    harness.cleanup();
  }
});

test("the inspect route returns the partial data in its 500 error body", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const head = gitOutput(harness, handle.path, ["rev-parse", "HEAD"]).trim();
    const runGit = killOnMatch(harness, "diff");
    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
      async (services, handoffId) =>
        await inspectWorktreeForHandoff(services, handoffId, { runGit }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string; partial?: unknown };
    };
    expect(body.error.code).toBe("inspection_failed");
    expect(body.error.message).toMatch(
      /^worktree inspection deadline expired during diff \(git diff\)/,
    );
    expect(body.error.partial).toStrictEqual({
      head_sha: head,
      branch_name: handle.branchName,
      dirty: false,
      base_ref: "main",
      verified: false,
    });
  } finally {
    harness.cleanup();
  }
});

test("the inspect route keeps a non-deadline failure message-only", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    const res = await worktreesInspectRoute(
      new Request(`http://h/worktrees/${handle.handoffId}`),
      handle.handoffId,
      harness.services,
      async (services, handoffId) =>
        await inspectWorktreeForHandoff(services, handoffId, { runGit: failOnDiff(harness) }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; message: string; partial?: unknown };
    };
    expect(body.error).toStrictEqual({ code: "inspection_failed", message: "fatal: bad object" });
  } finally {
    harness.cleanup();
  }
});
