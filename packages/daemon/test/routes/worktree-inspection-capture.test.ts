import { expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  inspectWorktreeForHandoff,
  type WorktreeInspectionCommandRunner,
} from "@src/routes/worktree-inspection.js";

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

test("log beyond the hard capture cap preserves bounded partial output", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    for (let index = 0; index < 7; index += 1) {
      gitOutput(harness, handle.path, [
        "commit",
        "--allow-empty",
        "-m",
        `log-${String(index)}-${"y".repeat(10_000)}`,
      ]);
    }
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.inspection.branch_log).toContain("log-6-");
    expect(Buffer.byteLength(result.inspection.branch_log)).toBeLessThanOrEqual(8 * 1024);
    expect(result.inspection.truncation).toEqual({
      diff_against_main: false,
      branch_log: true,
      total: true,
    });
  } finally {
    harness.cleanup();
  }
});

test("status beyond the hard capture cap still fails closed", async () => {
  const harness = createWorktreeInspectionHarness();
  try {
    const handle = await createInspectionWorktree(harness);
    for (let index = 0; index < 320; index += 1) {
      writeFileSync(join(handle.path, `${String(index)}-${"z".repeat(220)}`), "untracked\n");
    }
    const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId);
    expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
    if (result.ok) throw new Error("expected status overflow failure");
    expect(result.message).toContain("maxBuffer");
  } finally {
    harness.cleanup();
  }
});

for (const committed of [false, true]) {
  test(`merge-base diff excludes main-only changes with branch commits=${String(committed)}`, async () => {
    const harness = createWorktreeInspectionHarness();
    try {
      const handle = await createInspectionWorktree(harness, { commit: committed });
      writeFileSync(join(harness.repoRoot, "main-only.txt"), `${"m".repeat(90_000)}\n`);
      gitOutput(harness, harness.repoRoot, ["add", "main-only.txt"]);
      gitOutput(harness, harness.repoRoot, ["commit", "-m", "main-only change"]);
      const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.inspection.diff_against_main).not.toContain("main-only.txt");
      expect(result.inspection.truncation.total).toBe(false);
      if (committed) {
        expect(result.inspection.diff_against_main).toContain("candidate.txt");
        expect(result.inspection.branch_log).toContain("candidate");
      } else {
        expect(result.inspection.diff_against_main).toBe("");
        expect(result.inspection.branch_log).toBe("");
      }
    } finally {
      harness.cleanup();
    }
  });
}

for (const command of ["diff", "log"] as const) {
  for (const partial of ["short partial", "é".repeat(40_000)]) {
    test(`${command} overflow retains string stdout and marks truncation (${String(partial.length)} chars)`, async () => {
      const harness = createWorktreeInspectionHarness();
      try {
        const handle = await createInspectionWorktree(harness);
        const actual = actualGitRunner(harness);
        const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
          runGit: async (args, opts) => {
            if (args.includes(command)) {
              throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
                code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                stdout: partial,
              });
            }
            return await actual(args, opts);
          },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        const field = command === "diff" ? "diff_against_main" : "branch_log";
        expect(result.inspection[field]).toStartWith(partial.slice(0, 10));
        expect(result.inspection[field]).not.toContain("\uFFFD");
        expect(Buffer.byteLength(result.inspection[field])).toBeLessThanOrEqual(
          (command === "diff" ? 10 : 8) * 1024,
        );
        expect(result.inspection.truncation[field]).toBe(true);
        expect(result.inspection.truncation.total).toBe(true);
      } finally {
        harness.cleanup();
      }
    });
  }

  for (const [label, code, stdout] of [
    ["missing stdout", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", undefined],
    ["non-string stdout", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", Buffer.from("partial")],
    ["timeout", "ETIMEDOUT", "partial"],
    ["git error", 128, "partial"],
  ] as const) {
    test(`${command} ${label} fails closed`, async () => {
      const harness = createWorktreeInspectionHarness();
      try {
        const handle = await createInspectionWorktree(harness);
        const actual = actualGitRunner(harness);
        const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
          runGit: async (args, opts) => {
            if (args.includes(command)) throw Object.assign(new Error(label), { code, stdout });
            return await actual(args, opts);
          },
        });
        expect(result).toMatchObject({ ok: false, code: "inspection_failed", message: label });
      } finally {
        harness.cleanup();
      }
    });
  }
}

for (const command of ["rev-parse", "symbolic-ref", "reflog", "status"]) {
  test(`${command} overflow fails closed even with string stdout`, async () => {
    const harness = createWorktreeInspectionHarness();
    try {
      const handle = await createInspectionWorktree(harness);
      const actual = actualGitRunner(harness);
      const result = await inspectWorktreeForHandoff(harness.services, handle.handoffId, {
        runGit: async (args, opts) => {
          const output = await actual(args, opts);
          if (args.includes(command)) {
            throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              stdout: output.stdout,
            });
          }
          return output;
        },
      });
      expect(result).toMatchObject({ ok: false, code: "inspection_failed" });
    } finally {
      harness.cleanup();
    }
  });
}
