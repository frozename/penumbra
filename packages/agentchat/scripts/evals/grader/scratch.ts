import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  defaultRunCommand,
  isSafeRelativePath,
  type RunCommand,
  type RunCommandResult,
} from "./materialize.js";

export interface GraderScratch {
  dir: string;
  repoDir: string;
  gitEnv: NodeJS.ProcessEnv;
  git(args: string[], input?: Uint8Array): Promise<RunCommandResult>;
  buildBase(files: Record<string, string>): Promise<string>;
  applyPatch(baseSha: string, patchText: string): Promise<string>;
  newTree(id: string): string;
  newLegTmp(id: string): string;
  close(): void;
}

interface OpenOptions {
  sourceRepo: string | null;
  tmpRoot?: string;
  runCommand?: RunCommand;
}

interface ScratchCore {
  dir: string;
  repoDir: string;
  gitEnv: NodeJS.ProcessEnv;
  run: RunCommand;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// process.env minus every GIT_* key (GIT_DIR from a hook, identity overrides),
// then the eval-deterministic identity/date pins and a private HOME + index.
// PATH stays because materialize reuses this env for its own git calls.
function scrubbedGitEnv(dir: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) {
      base[key] = value;
    }
  }
  return {
    ...base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    HOME: join(dir, "home"),
    GIT_INDEX_FILE: join(dir, "index"),
    GIT_AUTHOR_NAME: "eval",
    GIT_COMMITTER_NAME: "eval",
    GIT_AUTHOR_EMAIL: "eval@invalid",
    GIT_COMMITTER_EMAIL: "eval@invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
}

function gitAt(
  core: ScratchCore,
  target: string,
  args: string[],
  input?: Uint8Array,
): Promise<RunCommandResult> {
  return core.run(
    "git",
    ["-C", target, "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args],
    { env: core.gitEnv, input },
  );
}

function requireOk(res: RunCommandResult, step: string): RunCommandResult {
  if (res.code !== 0) {
    throw new Error(
      `grader scratch ${step} failed with code ${String(res.code)}: ${res.stderr.toString("utf8")}`,
    );
  }
  return res;
}

// Borrow the source repo's objects read-only via alternates, so candidate
// commits are readable from the scratch while every write stays local.
async function installAlternates(core: ScratchCore, sourceRepo: string): Promise<void> {
  const res = await core.run("git", ["-C", sourceRepo, "rev-parse", "--git-common-dir"], {
    env: core.gitEnv,
  });
  requireOk(res, "rev-parse --git-common-dir");
  const commonDir = realpathSync(resolve(sourceRepo, res.stdout.toString("utf8").trim()));
  const infoDir = join(core.repoDir, ".git", "objects", "info");
  mkdirSync(infoDir, { recursive: true });
  writeFileSync(join(infoDir, "alternates"), `${join(commonDir, "objects")}\n`, "utf8");
}

function requireSafeId(id: string): void {
  if (!SAFE_ID.test(id) || id === "." || id === "..") {
    throw new Error(`unsafe scratch id: ${id}`);
  }
}

function mkBucketSub(dir: string, bucket: string, id: string): string {
  requireSafeId(id);
  const target = join(dir, bucket, id);
  mkdirSync(target, { recursive: true });
  return target;
}

async function buildBaseImpl(core: ScratchCore, files: Record<string, string>): Promise<string> {
  for (const path of Object.keys(files)) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`unsafe scratch base path: ${path}`);
    }
  }
  requireOk(await gitAt(core, core.repoDir, ["read-tree", "--empty"]), "read-tree --empty");
  for (const path of Object.keys(files).sort()) {
    const content = Buffer.from(files[path] ?? "", "utf8");
    const hashed = requireOk(
      await gitAt(core, core.repoDir, ["hash-object", "-w", "--stdin"], content),
      "hash-object",
    );
    const oid = hashed.stdout.toString("utf8").trim();
    requireOk(
      await gitAt(core, core.repoDir, [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${oid},${path}`,
      ]),
      "update-index",
    );
  }
  const tree = requireOk(await gitAt(core, core.repoDir, ["write-tree"]), "write-tree");
  const commit = requireOk(
    await gitAt(core, core.repoDir, [
      "commit-tree",
      tree.stdout.toString("utf8").trim(),
      "-m",
      "eval base",
    ]),
    "commit-tree",
  );
  return commit.stdout.toString("utf8").trim();
}

async function applyPatchImpl(
  core: ScratchCore,
  baseSha: string,
  patchText: string,
): Promise<string> {
  requireOk(await gitAt(core, core.repoDir, ["read-tree", baseSha]), "read-tree");
  requireOk(
    await gitAt(
      core,
      core.repoDir,
      ["apply", "--cached", "--whitespace=nowarn"],
      Buffer.from(patchText, "utf8"),
    ),
    "git apply",
  );
  const tree = requireOk(await gitAt(core, core.repoDir, ["write-tree"]), "write-tree");
  const commit = requireOk(
    await gitAt(core, core.repoDir, [
      "commit-tree",
      tree.stdout.toString("utf8").trim(),
      "-p",
      baseSha,
      "-m",
      "eval patch",
    ]),
    "commit-tree",
  );
  return commit.stdout.toString("utf8").trim();
}

export async function openGraderScratch(opts: OpenOptions): Promise<GraderScratch> {
  const run = opts.runCommand ?? defaultRunCommand;
  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "penumbra-grader-"));
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "trees"));
  mkdirSync(join(dir, "legs"));
  const core: ScratchCore = { dir, repoDir: join(dir, "repo"), gitEnv: scrubbedGitEnv(dir), run };
  requireOk(await gitAt(core, dir, ["init", "-q", "repo"]), "init");
  if (opts.sourceRepo !== null) {
    await installAlternates(core, opts.sourceRepo);
  }

  const cleanup = (): void => {
    rmSync(dir, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  let closed = false;

  return {
    dir,
    repoDir: core.repoDir,
    gitEnv: core.gitEnv,
    git: (args, input) => gitAt(core, core.repoDir, args, input),
    buildBase: (files) => buildBaseImpl(core, files),
    applyPatch: (baseSha, patchText) => applyPatchImpl(core, baseSha, patchText),
    newTree: (id) => mkBucketSub(dir, "trees", id),
    newLegTmp: (id) => mkBucketSub(dir, "legs", id),
    close: (): void => {
      if (closed) {
        return;
      }
      closed = true;
      process.removeListener("exit", cleanup);
      cleanup();
    },
  };
}
