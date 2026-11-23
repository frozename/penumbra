import {
  type HandoffRow,
  type Logger,
  type VerifyArgv,
  type WorktreeHandle,
  WorktreeManager,
} from "@penumbra/core";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createMergeReconciler, type ReconcilerVerdict } from "@src/worker/merge-reconciler.js";

const execFileAsync = promisify(execFile);

const HURAYRA_VERIFY: VerifyArgv = {
  typecheck: [["npm", "run", "typecheck"]],
  tests: [
    ["npm", "run", "lint"],
    ["npm", "run", "test:tz"],
  ],
};

type CommandStub = (command: string, cwd: string) => Promise<{ stdout: string; stderr: string }>;

function commandFailure(output: string, code: number, signal?: string): Error {
  return Object.assign(new Error(`command exited with ${String(code)}`), {
    code,
    signal,
    stdout: output,
    stderr: "",
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function makeHandoffRow(projectId: string): HandoffRow {
  const row = {
    handoff_id: "h-verify",
    ts: "2026-11-22T00:00:00.000Z",
    project_id: projectId,
    conversation_id: "c-verify",
    from_agent: "user",
    to_agent: "codex",
    message: "dispatch prompt",
    status: "completed",
    branch_base: null,
    open_pr_on_review: false,
  };
  return row as unknown as HandoffRow;
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

describe("merge reconciler with a project's declared verify commands", () => {
  let tmp: string;
  let workerRepo: string;
  let projectRepo: string;
  let worktree: WorktreeHandle;
  let verdicts: ReconcilerVerdict[];
  let commands: { command: string; cwd: string }[];
  const handoffId = "h-verify";

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "penumbra-reconcile-verify-")));
    workerRepo = join(tmp, "worker");
    projectRepo = join(tmp, "app");
    for (const repo of [workerRepo, projectRepo]) {
      mkdirSync(repo, { recursive: true });
      git(repo, ["init", "-b", "main"]);
      git(repo, ["config", "user.email", "test@test.com"]);
      git(repo, ["config", "user.name", "test"]);
    }
    git(workerRepo, ["commit", "--allow-empty", "-m", "init"]);
    writeFileSync(join(projectRepo, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(join(projectRepo, "package-lock.json"), "{}\n");
    git(projectRepo, ["add", "."]);
    git(projectRepo, ["commit", "-m", "init"]);
    verdicts = [];
    commands = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setup(opts: {
    verify?: VerifyArgv;
    runCommand?: CommandStub;
    change?: "docs" | "source";
    nodeModules?: "missing" | "owned" | "symlink";
  }): Promise<ReturnType<typeof createMergeReconciler>> {
    const manager = new WorktreeManager({
      rootDir: join(tmp, "default-worktrees"),
      mainRepoDir: workerRepo,
      resolveProjectRoot: (id: string): string | undefined =>
        id === "app" ? projectRepo : undefined,
    });
    worktree = await manager.createWorktree(handoffId, { project_id: "app" });
    const file = opts.change === "docs" ? "docs/note.md" : "src/app.ts";
    mkdirSync(join(worktree.path, file, ".."), { recursive: true });
    writeFileSync(join(worktree.path, file), "export const a = 1;\n");
    git(worktree.path, ["add", file]);
    git(worktree.path, ["commit", "-m", "change"]);
    if (opts.nodeModules === "symlink") {
      mkdirSync(join(tmp, "shared-node-modules"));
      symlinkSync(join(tmp, "shared-node-modules"), join(worktree.path, "node_modules"));
    } else if (opts.nodeModules !== "missing") {
      mkdirSync(join(worktree.path, "node_modules"));
    }

    return createMergeReconciler({
      worktreeManager: manager,
      mainRepoDir: workerRepo,
      reconcilerAutoRebase: false,
      rebaseScratchRoot: join(tmp, "scratch"),
      log: silentLogger,
      postProgress: mock(() => Promise.resolve()),
      emitVerdict: (verdict: ReconcilerVerdict) => {
        verdicts.push(verdict);
      },
      getHandoff: mock(() => Promise.resolve(makeHandoffRow("app"))),
      verifyCommandsFor: (projectId) => (projectId === "app" ? opts.verify : undefined),
      exec: async (argv: string[], execOpts: { cwd: string }) => {
        if (argv[0] === "git") {
          const { stdout, stderr } = await execFileAsync("git", argv.slice(1), {
            cwd: execOpts.cwd,
            encoding: "utf8",
          });
          return { stdout, stderr };
        }
        const command = argv.join(" ");
        commands.push({ command, cwd: execOpts.cwd });
        if (opts.runCommand) return await opts.runCommand(command, execOpts.cwd);
        return { stdout: "", stderr: "" };
      },
    });
  }

  test("runs the declared commands in the worktree instead of bun tsc and bun test", async () => {
    const reconciler = await setup({ verify: HURAYRA_VERIFY });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("verified");
    expect(commands).toEqual([
      { command: "npm run typecheck", cwd: worktree.path },
      { command: "npm run lint", cwd: worktree.path },
      { command: "npm run test:tz", cwd: worktree.path },
    ]);
    expect(verdicts[0]?.typecheck).toBe("pass");
    expect(verdicts[0]?.tests).toBe("pass");
  });

  test("an undeclared project still runs the built-in bun typecheck and bun test", async () => {
    const reconciler = await setup({
      runCommand: (command) =>
        Promise.resolve({
          stdout: command === "bun test" ? " 3 pass\n 0 fail\nRan 3 tests across 1 files.\n" : "",
          stderr: "",
        }),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("verified");
    expect(commands).toEqual([
      { command: "bun tsc -b", cwd: worktree.path },
      { command: "bun test", cwd: worktree.path },
    ]);
    expect(verdicts[0]?.typecheck).toBe("pass");
    expect(verdicts[0]?.tests).toBe("pass");
  });

  test("an undeclared npm project installs its test baseline with npm ci", async () => {
    const binDir = join(tmp, "bin");
    mkdirSync(binDir);
    for (const binary of ["npm", "node"]) {
      writeFileSync(join(binDir, binary), "#!/bin/sh\n", { mode: 0o755 });
    }
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const failing =
      "(fail) app > breaks [1.00ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 files.\n";
    const reconciler = await setup({
      runCommand: (command, cwd) => {
        if (command === "npm ci --ignore-scripts") mkdirSync(join(cwd, "node_modules"));
        return command === "bun test"
          ? Promise.reject(commandFailure(failing, 1))
          : Promise.resolve({ stdout: "", stderr: "" });
      },
    });

    try {
      const result = await reconciler(handoffId);

      // The same failure exists at the merge base, so it is not the branch's.
      expect(result.status).toBe("verified");
      const scratch = join(tmp, "scratch", "test-baseline", handoffId);
      expect(commands).toEqual([
        { command: "bun tsc -b", cwd: worktree.path },
        { command: "bun test", cwd: worktree.path },
        { command: "npm ci --ignore-scripts", cwd: scratch },
        { command: "bun test", cwd: scratch },
      ]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("a failing declared typecheck command is a typecheck fail and stops before tests", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: (command) =>
        command === "npm run typecheck"
          ? Promise.reject(commandFailure("src/app.ts(1,1): error TS2322: nope\n", 2))
          : Promise.resolve({ stdout: "", stderr: "" }),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("typecheck_failed");
    expect(result.regression_summary).toContain("npm run typecheck");
    expect(result.regression_summary).toContain("error TS2322");
    expect(result.verification_environment_error).toBeUndefined();
    expect(commands.map((c) => c.command)).toEqual(["npm run typecheck"]);
    expect(verdicts[0]?.typecheck).toBe("fail");
    expect(verdicts[0]?.tests).toBe("skipped");
  });

  test("a failing declared tests command is a tests fail naming the command", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: (command) =>
        command === "npm run lint"
          ? Promise.reject(commandFailure("eslint: 2 problems\n", 1))
          : Promise.resolve({ stdout: "", stderr: "" }),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("test_failed");
    expect(result.regression_summary).toContain("npm run lint");
    expect(result.regression_summary).toContain("eslint: 2 problems");
    expect(commands.map((c) => c.command)).toEqual(["npm run typecheck", "npm run lint"]);
    expect(verdicts[0]?.typecheck).toBe("pass");
    expect(verdicts[0]?.tests).toBe("fail");
  });

  test("a declared command that exits non-zero and prints nothing is a fail, not an error", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: (command) =>
        command === "npm run lint"
          ? Promise.reject(commandFailure("", 1))
          : Promise.resolve({ stdout: "", stderr: "" }),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("test_failed");
    expect(result.verification_environment_error).toBeUndefined();
    expect(result.regression_summary).toContain("npm run lint failed with exit code 1");
    expect(result.regression_summary).toContain("printed nothing");
    expect(verdicts[0]?.typecheck).toBe("pass");
    expect(verdicts[0]?.tests).toBe("fail");
  });

  test("a silent failing declared typecheck command is a typecheck fail", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: () => Promise.reject(commandFailure("", 2)),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("typecheck_failed");
    expect(result.verification_environment_error).toBeUndefined();
    expect(verdicts[0]?.typecheck).toBe("fail");
  });

  test("a declared command killed by a signal other than SIGKILL is a fail", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: () =>
        Promise.reject(
          Object.assign(new Error("command died"), {
            code: null,
            signal: "SIGSEGV",
            stdout: "",
            stderr: "",
          }),
        ),
    });

    const result = await reconciler(handoffId);

    expect(result.verification_environment_error).toBeUndefined();
    expect(verdicts[0]?.typecheck).toBe("fail");
  });

  test("a declared command that cannot start (ENOENT) is an environment error, not a fail", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: () =>
        Promise.reject(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" })),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("typecheck_failed");
    expect(result.verification_environment_error).toBe(true);
    expect(result.regression_summary).toContain("spawn npm ENOENT");
    expect(commands.map((c) => c.command)).toEqual(["npm run typecheck"]);
    expect(verdicts[0]?.typecheck).toBe("error");
  });

  test("a start failure is an environment error even when the error carries output", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: (command) =>
        command === "npm run lint"
          ? Promise.reject(
              Object.assign(new Error("spawn npm EACCES"), {
                code: "EACCES",
                stdout: "",
                stderr: "permission denied\n",
              }),
            )
          : Promise.resolve({ stdout: "", stderr: "" }),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("test_failed");
    expect(result.verification_environment_error).toBe(true);
    expect(result.regression_summary).toContain("spawn npm EACCES");
    expect(verdicts[0]?.tests).toBe("error");
  });

  test("a job scope that fails to launch is an environment error", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: () =>
        Promise.reject(
          Object.assign(new Error("command exited with 1"), {
            code: 1,
            stdout: "",
            stderr: "Failed to start transient scope unit: Connection refused\n",
          }),
        ),
    });

    const result = await reconciler(handoffId);

    expect(result.verification_environment_error).toBe(true);
    expect(verdicts[0]?.typecheck).toBe("error");
  });

  test("a declared command SIGKILLed outside penumbra is a resource error", async () => {
    const reconciler = await setup({
      verify: HURAYRA_VERIFY,
      runCommand: (command) =>
        command === "npm run test:tz"
          ? Promise.reject(commandFailure("", 137, "SIGKILL"))
          : Promise.resolve({ stdout: "", stderr: "" }),
    });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("test_failed");
    expect(result.resource_killed).toBe(true);
    expect(verdicts[0]?.tests).toBe("error");
  });

  test("declared commands run for a docs-only diff, which the built-in stages skip", async () => {
    const reconciler = await setup({ verify: HURAYRA_VERIFY, change: "docs" });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("verified");
    expect(commands.map((c) => c.command)).toEqual([
      "npm run typecheck",
      "npm run lint",
      "npm run test:tz",
    ]);
    expect(verdicts[0]?.tests).toBe("pass");
  });

  test("declared tests refuse a symlinked node_modules as an environment error", async () => {
    const reconciler = await setup({ verify: HURAYRA_VERIFY, nodeModules: "symlink" });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("test_failed");
    expect(result.verification_environment_error).toBe(true);
    expect(result.regression_summary).toContain("node_modules is a symlink");
    expect(result.regression_summary).toContain("isolated_install: false");
    expect(result.regression_summary).toContain("Dispatch again with isolated_install: true");
    expect(commands.map((c) => c.command)).toEqual(["npm run typecheck"]);
    expect(verdicts[0]?.typecheck).toBe("pass");
    expect(verdicts[0]?.tests).toBe("error");
  });
  test("declared tests in a worktree with no node_modules say verify needs an isolated install", async () => {
    const reconciler = await setup({ verify: HURAYRA_VERIFY, nodeModules: "missing" });

    const result = await reconciler(handoffId);

    expect(result.status).toBe("test_failed");
    expect(result.verification_environment_error).toBe(true);
    expect(result.regression_summary).toContain(
      `verify commands need the worktree's own node_modules, and ${join(worktree.path, "node_modules")} does not exist`,
    );
    expect(result.regression_summary).toContain("isolated_install: true");
    expect(result.regression_summary).toContain("remove verify from its projects.yaml entry");
    expect(commands.map((c) => c.command)).toEqual(["npm run typecheck"]);
    expect(verdicts[0]?.tests).toBe("error");
  });
});
