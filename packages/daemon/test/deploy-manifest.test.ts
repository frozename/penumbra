import { SCHEMA_VERSION } from "@penumbra/core/db/schema";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as health from "@src/routes/health.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const MANIFEST_CLI = join(import.meta.dir, "../src/deploy-manifest.ts");

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q"]);
}

function commitFile(dir: string, name: string, contents: string): string {
  writeFileSync(join(dir, name), contents);
  git(dir, ["add", name]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", name]);
  return git(dir, ["rev-parse", "HEAD"]);
}

async function runDeployManifest(
  src: string,
  out: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, MANIFEST_CLI, "--source", src, "--out", out], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

function manifestPath(out: string): string {
  return join(out, "DEPLOY_MANIFEST.json");
}

test("deploy-manifest writes DEPLOY_MANIFEST.json for a committed source tree", async () => {
  const src = tempDir("penumbra-dm-src-");
  const out = tempDir("penumbra-dm-out-");
  initRepo(src);
  const expectedCommit = commitFile(src, "bun.lock", "lock-content\n");

  const { exitCode, stderr } = await runDeployManifest(src, out);
  expect(exitCode, `deploy-manifest stderr: ${stderr}`).toBe(0);

  const path = manifestPath(out);
  expect(existsSync(path)).toBe(true);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    commit: string;
    schemaVersion: number;
    bunVersion: string;
    lockfileSha: string;
    builtAt: string;
  };
  expect(manifest.commit).toBe(expectedCommit);
  expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
  expect(manifest.bunVersion).toBe(Bun.version);
  const expectedLockfileSha = createHash("sha256")
    .update(readFileSync(join(src, "bun.lock")))
    .digest("hex");
  expect(manifest.lockfileSha).toBe(expectedLockfileSha);
  expect(Number.isNaN(Date.parse(manifest.builtAt))).toBe(false);

  expect(typeof health.resolveBuildInfo).toBe("function");
  const resolved = await health.resolveBuildInfo({ root: out });
  expect(resolved).toMatchObject({ source: "manifest", commit: expectedCommit });
}, 30_000);

test("deploy-manifest refuses a source tree that is not a git repo", async () => {
  const src = tempDir("penumbra-dm-nogit-");
  const out = tempDir("penumbra-dm-out-");
  writeFileSync(join(src, "bun.lock"), "lock-content\n");

  const { exitCode, stderr } = await runDeployManifest(src, out);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/cannot resolve commit/);
  expect(existsSync(manifestPath(out))).toBe(false);
}, 30_000);

test("deploy-manifest refuses a nested directory inside a git repo", async () => {
  const repo = tempDir("penumbra-dm-repo-");
  const out = tempDir("penumbra-dm-out-");
  initRepo(repo);
  commitFile(repo, "file.txt", "content\n");
  const nested = join(repo, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "bun.lock"), "nested-lock\n");

  const { exitCode, stderr } = await runDeployManifest(nested, out);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/cannot resolve commit/);
  expect(existsSync(manifestPath(out))).toBe(false);
}, 30_000);

test("deploy-manifest refuses a git repo without bun.lock", async () => {
  const src = tempDir("penumbra-dm-nolock-");
  const out = tempDir("penumbra-dm-out-");
  initRepo(src);
  commitFile(src, "file.txt", "content\n");

  const { exitCode, stderr } = await runDeployManifest(src, out);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/bun\.lock/);
  expect(existsSync(manifestPath(out))).toBe(false);
}, 30_000);
