import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { graderBuildId, type GraderBuildIdOptions } from "./build-id.js";

const GIT_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

const COMMIT_ARGS = [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@invalid",
  "-c",
  "commit.gpgsign=false",
];

const tempDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function gitSync(cwd: string, args: string[]): void {
  const res = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: GIT_ENV,
  });
  expect(res.status).toBe(0);
}

interface LinkedPkgFixture {
  root: string;
  wsSrc: string;
  opts: GraderBuildIdOptions;
}

// P/node_modules/@ws/ext symlinks to wsSrc, which is its own git repo with a
// .gitignore covering dist/ and *.tsbuildinfo — the shape of a workspace-linked
// package whose build output must not move the grader build id.
function mkLinkedPkgFixture(): LinkedPkgFixture {
  const root = mkTmp("penumbra-buildid-linked-git-");
  const entry = join(root, "entry.ts");
  writeFileSync(entry, 'export { x } from "@ws/ext";\n', "utf8");
  const wsSrc = join(root, "packages", "ext");
  mkdirSync(join(wsSrc, "src"), { recursive: true });
  writeFileSync(join(wsSrc, ".gitignore"), "dist/\n*.tsbuildinfo\n", "utf8");
  writeFileSync(join(wsSrc, "package.json"), '{"name":"@ws/ext","version":"0.1.0"}\n', "utf8");
  writeFileSync(join(wsSrc, "src", "index.ts"), "export const x = 1;\n", "utf8");
  gitSync(wsSrc, ["init", "-q"]);
  gitSync(wsSrc, ["add", "-A"]);
  gitSync(wsSrc, [...COMMIT_ARGS, "commit", "-q", "-m", "init"]);
  mkdirSync(join(root, "node_modules", "@ws"), { recursive: true });
  symlinkSync(wsSrc, join(root, "node_modules", "@ws", "ext"), "dir");
  return {
    root,
    wsSrc,
    opts: { entrypoints: [entry], root, bunVersion: "b1", gitVersion: "g1" },
  };
}

test("graderBuildId hashes only the git-visible files of a linked package", async () => {
  const fixture = mkLinkedPkgFixture();
  const idA = await graderBuildId(fixture.opts);
  expect(idA).toMatch(/^[0-9a-f]{64}$/);

  mkdirSync(join(fixture.wsSrc, "dist"), { recursive: true });
  writeFileSync(join(fixture.wsSrc, "dist", "index.js"), "export const x = 1;\n", "utf8");
  expect(await graderBuildId(fixture.opts)).toBe(idA);

  writeFileSync(join(fixture.wsSrc, "tsconfig.tsbuildinfo"), "{}\n", "utf8");
  expect(await graderBuildId(fixture.opts)).toBe(idA);

  writeFileSync(join(fixture.wsSrc, "src", "index.ts"), "export const x = 2;\n", "utf8");
  const idEdited = await graderBuildId(fixture.opts);
  expect(idEdited).not.toBe(idA);
  writeFileSync(join(fixture.wsSrc, "src", "index.ts"), "export const x = 1;\n", "utf8");
  expect(await graderBuildId(fixture.opts)).toBe(idA);

  writeFileSync(join(fixture.wsSrc, "src", "extra.ts"), "export const y = 1;\n", "utf8");
  const idExtra = await graderBuildId(fixture.opts);
  expect(idExtra).not.toBe(idA);
  rmSync(join(fixture.wsSrc, "src", "extra.ts"));
  expect(await graderBuildId(fixture.opts)).toBe(idA);
}, 30_000);

test("graderBuildId ignores inherited GIT_DIR and GIT_WORK_TREE for linked packages", async () => {
  const fixture = mkLinkedPkgFixture();
  const idA = await graderBuildId(fixture.opts);

  const foreign = mkTmp("penumbra-buildid-foreign-repo-");
  gitSync(foreign, ["init", "-q"]);
  writeFileSync(join(foreign, "foreign.txt"), "foreign\n", "utf8");
  gitSync(foreign, ["add", "foreign.txt"]);
  gitSync(foreign, [...COMMIT_ARGS, "commit", "-q", "-m", "foreign"]);

  const savedDir = process.env.GIT_DIR;
  const savedTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = join(foreign, ".git");
    process.env.GIT_WORK_TREE = foreign;
    expect(await graderBuildId(fixture.opts)).toBe(idA);
  } finally {
    if (savedDir === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = savedDir;
    }
    if (savedTree === undefined) {
      delete process.env.GIT_WORK_TREE;
    } else {
      process.env.GIT_WORK_TREE = savedTree;
    }
  }
}, 30_000);

test("graderBuildId full-walks a linked package that is not inside a git work tree", async () => {
  const root = mkTmp("penumbra-buildid-linked-nogit-");
  const entry = join(root, "entry.ts");
  writeFileSync(entry, 'export { x } from "@ws/ext";\n', "utf8");
  const wsSrc = join(root, "packages", "ext");
  mkdirSync(join(wsSrc, "src"), { recursive: true });
  mkdirSync(join(wsSrc, "dist"), { recursive: true });
  writeFileSync(join(wsSrc, "package.json"), '{"name":"@ws/ext","version":"0.1.0"}\n', "utf8");
  writeFileSync(join(wsSrc, "src", "index.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(join(wsSrc, "dist", "index.js"), "export const x = 1;\n", "utf8");
  mkdirSync(join(root, "node_modules", "@ws"), { recursive: true });
  symlinkSync(wsSrc, join(root, "node_modules", "@ws", "ext"), "dir");
  const opts: GraderBuildIdOptions = {
    entrypoints: [entry],
    root,
    bunVersion: "b1",
    gitVersion: "g1",
  };

  const idA = await graderBuildId(opts);
  expect(idA).toMatch(/^[0-9a-f]{64}$/);

  writeFileSync(join(wsSrc, "src", "index.ts"), "export const x = 2;\n", "utf8");
  const idB = await graderBuildId(opts);
  expect(idB).not.toBe(idA);

  writeFileSync(join(wsSrc, "dist", "index.js"), "export const x = 2;\n", "utf8");
  const idC = await graderBuildId(opts);
  expect(idC).not.toBe(idB);
}, 30_000);
