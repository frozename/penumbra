import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MODULE = resolve(import.meta.dir, "../src/build-identity.ts");
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(import.meta.dir, "../package.json"), "utf8")) as {
    version: string;
  }
).version;

let tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeFakeGit(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const gitPath = join(dir, "git");
  writeFileSync(gitPath, `#!/bin/sh\n${body}\n`);
  chmodSync(gitPath, 0o755);
}

interface RunIdentityOptions {
  module: string;
  pathDir: string;
  buildId?: string;
  cwd?: string;
}

interface IdentityOutput {
  server: string;
  pkg: string;
}

function runIdentity(options: RunIdentityOptions): SpawnSyncReturns<string> {
  const tmp = makeTempDir("build-id-run-");
  const env: Record<string, string> = { PATH: options.pathDir, HOME: tmp };
  if (options.buildId !== undefined) {
    env.PENUMBRA_MCP_BUILD_ID = options.buildId;
  }
  const script = `const m = await import(${JSON.stringify(options.module)}); process.stdout.write(JSON.stringify({ server: m.MCP_SERVER_VERSION, pkg: m.MCP_PACKAGE_VERSION }))`;
  return spawnSync(process.execPath, ["-e", script], {
    cwd: options.cwd ?? tmp,
    encoding: "utf8",
    env,
  });
}

function parseIdentity(r: ReturnType<typeof runIdentity>): IdentityOutput {
  return JSON.parse(r.stdout) as IdentityOutput;
}

describe("MCP_SERVER_VERSION build metadata", () => {
  test("prefers PENUMBRA_MCP_BUILD_ID over the git sha", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: "cfg1" });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+cfg1`);
  });

  test("replaces characters outside [0-9A-Za-z.-] with dots", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: "feat/x_y" });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+feat.x.y`);
  });

  test("keeps hyphens", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: "a-b" });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+a-b`);
  });

  test("collapses runs of dots", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: "a...b" });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+a.b`);
  });

  test("strips leading and trailing dots", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: ".ab." });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+ab`);
  });

  test("truncates to 80 characters", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: "a".repeat(100) });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+${"a".repeat(80)}`);
  });

  test("falls through to git when the id normalizes to empty", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir, buildId: "///" });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+git.abc123`);
  });

  test("uses git.<sha> when no build id is set", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    const r = runIdentity({ module: MODULE, pathDir });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+git.abc123`);
  });

  test("normalizes git output", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, 'echo "  ab/c  "');
    const r = runIdentity({ module: MODULE, pathDir });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+git.ab.c`);
  });

  test("invokes git rev-parse --short=12 HEAD", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, '[ "$1 $2 $3" = "rev-parse --short=12 HEAD" ] && echo ok || exit 1');
    const r = runIdentity({ module: MODULE, pathDir });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+git.ok`);
  });

  test("runs git in the package root, not the process cwd", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "[ -f package.json ] && echo inroot || exit 1");
    const emptyCwd = makeTempDir("build-id-cwd-");
    const r = runIdentity({ module: MODULE, pathDir, cwd: emptyCwd });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+git.inroot`);
  });

  test("returns unknown when git exits non-zero", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "exit 1");
    const r = runIdentity({ module: MODULE, pathDir });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+unknown`);
  });

  test("returns unknown when git prints only whitespace", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, 'echo "   "');
    const r = runIdentity({ module: MODULE, pathDir });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+unknown`);
  });

  test("returns unknown when git is not on PATH", () => {
    const tmp = makeTempDir("build-id-");
    const pathDir = join(tmp, "empty-bin");
    mkdirSync(pathDir);
    const r = runIdentity({ module: MODULE, pathDir });
    expect(r.status).toBe(0);
    expect(parseIdentity(r).server).toBe(`${PKG_VERSION}+unknown`);
  });
});

describe("MCP_PACKAGE_VERSION package.json guard", () => {
  function makeFixturePackage(version: unknown): { module: string; pathDir: string } {
    const tmp = makeTempDir("build-id-pkg-");
    const pkgRoot = join(tmp, "pkg");
    mkdirSync(join(pkgRoot, "src"), { recursive: true });
    copyFileSync(MODULE, join(pkgRoot, "src", "build-identity.ts"));
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "@penumbra/mcp-fixture", version }),
    );
    const pathDir = join(tmp, "bin");
    makeFakeGit(pathDir, "echo abc123");
    return { module: join(pkgRoot, "src", "build-identity.ts"), pathDir };
  }

  test("exports MCP_PACKAGE_VERSION from package.json", () => {
    const fixture = makeFixturePackage("9.8.7");
    const r = runIdentity(fixture);
    expect(r.status).toBe(0);
    const parsed = parseIdentity(r);
    expect(parsed.pkg).toBe("9.8.7");
    expect(parsed.server).toBe("9.8.7+git.abc123");
  });

  test("throws when version is not a string", () => {
    const fixture = makeFixturePackage(1);
    const r = runIdentity(fixture);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("@penumbra/mcp package.json is missing a string version");
  });

  test("throws when version is blank", () => {
    const fixture = makeFixturePackage("   ");
    const r = runIdentity(fixture);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("@penumbra/mcp package.json is missing a string version");
  });
});
