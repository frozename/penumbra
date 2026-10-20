import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { classifyGitHooks, resolveGitHooksDir } from "@src/worktree/git-hooks.js";

describe("worktree git hooks classification", () => {
  let dir: string;

  beforeEach((): void => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "penumbra-git-hooks-"));
  });

  afterEach((): void => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("resolves a relative core.hooksPath against the worktree root", (): void => {
    expect(resolveGitHooksDir("/wt/root", ".husky/_")).toBe(path.join("/wt/root", ".husky", "_"));
    expect(resolveGitHooksDir("/wt/root", "/abs/hooks")).toBe("/abs/hooks");
  });

  test("reports not_configured when core.hooksPath is unset", (): void => {
    expect(classifyGitHooks(dir, null)).toEqual({ status: "not_configured", configured: null });
    expect(classifyGitHooks(dir, "")).toEqual({ status: "not_configured", configured: null });
  });

  test("reports missing when the hooks directory does not exist in the worktree", (): void => {
    expect(classifyGitHooks(dir, ".husky/_")).toEqual({
      status: "missing",
      configured: ".husky/_",
    });
  });

  test("reports empty when the hooks directory has no executable client hook", (): void => {
    const hooksDir = path.join(dir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });

    const gitignore = path.join(hooksDir, ".gitignore");
    fs.writeFileSync(gitignore, "*");
    fs.chmodSync(gitignore, 0o644);

    const nonExec = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(nonExec, "#!/bin/sh\n");
    fs.chmodSync(nonExec, 0o644);

    const exec = path.join(hooksDir, "h");
    fs.writeFileSync(exec, "#!/bin/sh\n");
    fs.chmodSync(exec, 0o755);

    const result = classifyGitHooks(dir, ".husky/_");
    expect(result.status).toBe("empty");
  });

  test("reports installed when an executable client hook exists", (): void => {
    const hooksDir = path.join(dir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });

    const hook = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\n");
    fs.chmodSync(hook, 0o755);

    expect(classifyGitHooks(dir, ".husky/_")).toEqual({
      status: "installed",
      configured: ".husky/_",
    });
  });
});
