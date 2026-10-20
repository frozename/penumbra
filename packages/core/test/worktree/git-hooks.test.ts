import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
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
  });

  it("reports missing for an empty core.hooksPath, because git then runs no hooks", (): void => {
    expect(classifyGitHooks(dir, "")).toEqual({ status: "missing", configured: "" });
  });

  it("resolves a whitespace-only core.hooksPath as a relative directory", (): void => {
    const hooksDir = path.join(dir, " ");
    fs.mkdirSync(hooksDir);
    const hook = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\n");
    fs.chmodSync(hook, 0o755);

    expect(classifyGitHooks(dir, " ")).toEqual({ status: "installed", configured: " " });
  });

  it("expands ~ against the home directory", (): void => {
    expect(resolveGitHooksDir("/wt/root", "~/hk")).toBe(path.join(os.homedir(), "hk"));
    expect(resolveGitHooksDir("/wt/root", "~")).toBe(os.homedir());
  });

  it("ignores a directory named like a hook", (): void => {
    const hooksDir = path.join(dir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });
    const dirHook = path.join(hooksDir, "pre-commit");
    fs.mkdirSync(dirHook);
    fs.chmodSync(dirHook, 0o755);

    expect(classifyGitHooks(dir, ".husky/_").status).toBe("empty");
  });

  it("reports installed for a husky 9 hooks directory", (): void => {
    const hooksDir = path.join(dir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });

    const gitignore = path.join(hooksDir, ".gitignore");
    fs.writeFileSync(gitignore, "*");
    fs.chmodSync(gitignore, 0o644);

    const h = path.join(hooksDir, "h");
    fs.writeFileSync(h, "#!/bin/sh\n");
    fs.chmodSync(h, 0o644);

    const huskySh = path.join(hooksDir, "husky.sh");
    fs.writeFileSync(huskySh, "#!/bin/sh\n");
    fs.chmodSync(huskySh, 0o644);

    const postCheckout = path.join(hooksDir, "post-checkout");
    fs.writeFileSync(postCheckout, "#!/bin/sh\n");
    fs.chmodSync(postCheckout, 0o644);

    const preCommit = path.join(hooksDir, "pre-commit");
    fs.writeFileSync(preCommit, "#!/bin/sh\n");
    fs.chmodSync(preCommit, 0o755);

    const commitMsg = path.join(hooksDir, "commit-msg");
    fs.writeFileSync(commitMsg, "#!/bin/sh\n");
    fs.chmodSync(commitMsg, 0o755);

    expect(classifyGitHooks(dir, ".husky/_")).toEqual({
      status: "installed",
      configured: ".husky/_",
    });
  });

  it("counts post-applypatch as a client hook", (): void => {
    const hooksDir = path.join(dir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, "post-applypatch");
    fs.writeFileSync(hook, "#!/bin/sh\n");
    fs.chmodSync(hook, 0o755);

    expect(classifyGitHooks(dir, ".husky/_").status).toBe("installed");
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
