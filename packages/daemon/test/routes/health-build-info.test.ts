import { applySchema, buildServices, loadSqliteVec, type Services } from "@penumbra/core";
import { SCHEMA_VERSION } from "@penumbra/core/db/schema";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as health from "@src/routes/health.js";
import { createDaemonFetchHandler } from "@src/serve.js";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const REPO_ROOT = join(import.meta.dir, "../../../..");

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

const VALID_MANIFEST_FIELDS = {
  builtAt: "2026-11-17T00:00:00.000Z",
  bunVersion: "1.3.13",
  lockfileSha: "c".repeat(64),
};

const MALFORMED_MANIFESTS: readonly (readonly [string, string])[] = [
  ["invalid JSON", "{ this is not json"],
  [
    "a non-SHA commit",
    JSON.stringify({ commit: "HEAD", schemaVersion: SCHEMA_VERSION, ...VALID_MANIFEST_FIELDS }),
  ],
  [
    "an unparseable builtAt",
    JSON.stringify({
      commit: "a".repeat(40),
      schemaVersion: SCHEMA_VERSION,
      ...VALID_MANIFEST_FIELDS,
      builtAt: "not-a-date",
    }),
  ],
  [
    "a string schemaVersion",
    JSON.stringify({
      commit: "a".repeat(40),
      schemaVersion: String(SCHEMA_VERSION),
      ...VALID_MANIFEST_FIELDS,
    }),
  ],
];

test("resolveBuildInfo prefers DEPLOY_MANIFEST.json and never probes git", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const root = tempDir("penumbra-build-manifest-");
  const manifest = {
    commit: "a".repeat(40),
    schemaVersion: 49,
    ...VALID_MANIFEST_FIELDS,
  };
  writeFileSync(join(root, "DEPLOY_MANIFEST.json"), JSON.stringify(manifest));

  let gitHeadCalls = 0;
  const gitHead = (): Promise<string | null> => {
    gitHeadCalls += 1;
    return Promise.resolve("b".repeat(40));
  };

  const result = await health.resolveBuildInfo({ root, gitHead });
  expect(result).toEqual({
    source: "manifest",
    commit: "a".repeat(40),
    schemaVersion: 49,
    ...VALID_MANIFEST_FIELDS,
  });
  expect(gitHeadCalls).toBe(0);
});

test("resolveBuildInfo falls back to git HEAD when no manifest exists", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const root = tempDir("penumbra-build-git-");
  const result = await health.resolveBuildInfo({
    root,
    gitHead: () => Promise.resolve("b".repeat(40)),
  });
  expect(result).toEqual({
    source: "git",
    commit: "b".repeat(40),
    schemaVersion: SCHEMA_VERSION,
  });
});

test("resolveBuildInfo reports unknown when neither manifest nor git resolves", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const root = tempDir("penumbra-build-none-");
  const result = await health.resolveBuildInfo({ root, gitHead: () => Promise.resolve(null) });
  expect(result).toEqual({ source: "unknown", commit: null, schemaVersion: null });
});

for (const [label, contents] of MALFORMED_MANIFESTS) {
  test(`resolveBuildInfo falls back to git when DEPLOY_MANIFEST.json has ${label}`, async () => {
    expect(typeof health.resolveBuildInfo).toBe("function");
    const root = tempDir("penumbra-build-badmanifest-");
    writeFileSync(join(root, "DEPLOY_MANIFEST.json"), contents);
    const result = await health.resolveBuildInfo({
      root,
      gitHead: () => Promise.resolve("b".repeat(40)),
    });
    expect(result).toEqual({
      source: "git",
      commit: "b".repeat(40),
      schemaVersion: SCHEMA_VERSION,
    });
  });

  test(`resolveBuildInfo reports unknown when DEPLOY_MANIFEST.json has ${label} and git fails`, async () => {
    expect(typeof health.resolveBuildInfo).toBe("function");
    const root = tempDir("penumbra-build-badmanifest-");
    writeFileSync(join(root, "DEPLOY_MANIFEST.json"), contents);
    const result = await health.resolveBuildInfo({ root, gitHead: () => Promise.resolve(null) });
    expect(result).toEqual({ source: "unknown", commit: null, schemaVersion: null });
  });
}

test("resolveBuildInfo probes git rev-parse HEAD at the root", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const dir = realpathSync(tempDir("penumbra-build-repo-"));
  initRepo(dir);
  const sha = commitFile(dir, "file.txt", "content\n");
  const result = await health.resolveBuildInfo({ root: dir });
  expect(result).toEqual({ source: "git", commit: sha, schemaVersion: SCHEMA_VERSION });
}, 30_000);

test("resolveBuildInfo reports unknown for a plain non-git directory", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const dir = realpathSync(tempDir("penumbra-build-plain-"));
  const result = await health.resolveBuildInfo({ root: dir });
  expect(result).toEqual({ source: "unknown", commit: null, schemaVersion: null });
}, 30_000);

test("resolveBuildInfo does not report an enclosing repo's HEAD for a nested non-git dir", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const repo = realpathSync(tempDir("penumbra-build-enclosing-"));
  initRepo(repo);
  commitFile(repo, "file.txt", "content\n");
  const nested = join(repo, "nested");
  mkdirSync(nested);
  const result = await health.resolveBuildInfo({ root: nested });
  expect(result).toEqual({ source: "unknown", commit: null, schemaVersion: null });
}, 30_000);

test("resolveBuildInfo resolves git when root is a non-realpath'd temp path", async () => {
  expect(typeof health.resolveBuildInfo).toBe("function");
  const dir = tempDir("penumbra-build-rawpath-");
  initRepo(dir);
  const sha = commitFile(dir, "file.txt", "content\n");
  const result = await health.resolveBuildInfo({ root: dir });
  expect(result).toEqual({ source: "git", commit: sha, schemaVersion: SCHEMA_VERSION });
}, 30_000);

test("healthRoute surfaces build info when provided", async () => {
  const build: health.BuildInfo = {
    source: "manifest",
    commit: "a".repeat(40),
    schemaVersion: 49,
    ...VALID_MANIFEST_FIELDS,
  };
  const response = health.healthRoute({ build });
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.build).toEqual(build);
});

test("healthRoute omits build info when not provided", async () => {
  const response = health.healthRoute({});
  const body = (await response.json()) as Record<string, unknown>;
  expect("build" in body).toBe(false);
});

function makeServices(): { services: Services; db: Database } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  applySchema(db);
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/daemon-health-build-info-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  return { services, db };
}

const injectedBuild: health.BuildInfo = {
  source: "manifest",
  commit: "d".repeat(40),
  schemaVersion: 49,
  ...VALID_MANIFEST_FIELDS,
};

const stackInjected = makeServices();
const handlerInjected = createDaemonFetchHandler({
  services: stackInjected.services,
  token: "tok",
  buildInfo: Promise.resolve(injectedBuild),
});

const stackDefault = makeServices();
const handlerDefault = createDaemonFetchHandler({
  services: stackDefault.services,
  token: "tok",
});

const stackProbe = makeServices();

afterAll(() => {
  for (const stack of [stackInjected, stackDefault, stackProbe]) {
    stack.services.supervisor.stopAll();
    stack.db.close();
  }
});

type BuildBody = { build?: health.BuildInfoSnapshot };

async function getBuild(handler: (req: Request) => Promise<Response>): Promise<BuildBody["build"]> {
  const response = await handler(new Request("http://x/health"));
  expect(response.status).toBe(200);
  return ((await response.json()) as BuildBody).build;
}

test("GET /health resolves build info once, not on every request", async () => {
  const root = tempDir("penumbra-build-once-");
  let gitHeadCalls = 0;
  const handler = createDaemonFetchHandler({
    services: stackProbe.services,
    token: "tok",
    buildInfoProbe: {
      root,
      gitHead: () => {
        gitHeadCalls += 1;
        return Promise.resolve("e".repeat(40));
      },
    },
  });
  await Bun.sleep(0);
  for (let i = 0; i < 5; i++) {
    expect(await getBuild(handler)).toEqual({
      source: "git",
      commit: "e".repeat(40),
      schemaVersion: SCHEMA_VERSION,
    });
  }
  expect(gitHeadCalls).toBe(1);
});

test("GET /health does not block on an unresolved build-info probe", async () => {
  const root = tempDir("penumbra-build-slow-");
  let gitHeadCalls = 0;
  let release: (commit: string | null) => void = () => undefined;
  const handler = createDaemonFetchHandler({
    services: stackProbe.services,
    token: "tok",
    buildInfoProbe: {
      root,
      gitHead: () => {
        gitHeadCalls += 1;
        return new Promise<string | null>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const pending: health.BuildInfoSnapshot = {
    source: "pending",
    commit: null,
    schemaVersion: null,
  };
  expect(await getBuild(handler)).toEqual(pending);
  expect(await getBuild(handler)).toEqual(pending);
  release("f".repeat(40));
  await Bun.sleep(0);
  expect(await getBuild(handler)).toEqual({
    source: "git",
    commit: "f".repeat(40),
    schemaVersion: SCHEMA_VERSION,
  });
  expect(gitHeadCalls).toBe(1);
});

test("GET /health reports unknown when the build-info probe rejects", async () => {
  const handler = createDaemonFetchHandler({
    services: stackProbe.services,
    token: "tok",
    buildInfoProbe: {
      root: tempDir("penumbra-build-reject-"),
      gitHead: () => Promise.reject(new Error("boom")),
    },
  });
  await Bun.sleep(0);
  expect(await getBuild(handler)).toEqual({ source: "unknown", commit: null, schemaVersion: null });
});

test("GET /health surfaces the injected build info", async () => {
  const response = await handlerInjected(new Request("http://x/health"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.build).toEqual(injectedBuild);
});

test("GET /health without injected build info resolves the git HEAD", async () => {
  const expectedCommit = git(REPO_ROOT, ["rev-parse", "HEAD"]);
  let build = await getBuild(handlerDefault);
  for (let i = 0; i < 300 && build?.source === "pending"; i++) {
    await Bun.sleep(50);
    build = await getBuild(handlerDefault);
  }
  expect(build?.source).toBe("git");
  expect(build?.commit).toBe(expectedCommit);
}, 30_000);
