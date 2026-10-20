import {
  buildServices,
  loadSqliteVec,
  migrate,
  ProjectRegistry,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { chainsStartRoute } from "@src/routes/chains.js";

const execFile = promisify(execFileCb);

try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  /* already loaded */
}

const temps: string[] = [];
let targetRepo: string;
let otherRoot: string;
let branchBaseOnlySha: string;
let previousStrict: string | undefined;
let previousExplicit: string | undefined;

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return stdout.trim();
}

function writePackage(root: string, name: string): void {
  fs.mkdirSync(path.join(root, "packages", name), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", name, "package.json"), `{"name":"${name}"}\n`);
}

beforeAll(async () => {
  targetRepo = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-chains-guard-target-"));
  otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penumbra-chains-guard-other-"));
  temps.push(targetRepo, otherRoot);
  await git(targetRepo, ["init", "-q", "-b", "main"]);
  await git(targetRepo, ["config", "user.email", "test@example.com"]);
  await git(targetRepo, ["config", "user.name", "test"]);
  writePackage(targetRepo, "core");
  await git(targetRepo, ["add", "-A"]);
  await git(targetRepo, ["commit", "-q", "-m", "init"]);
  await git(targetRepo, ["checkout", "-q", "-b", "ahead"]);
  writePackage(targetRepo, "fresh");
  await git(targetRepo, ["add", "-A"]);
  await git(targetRepo, ["commit", "-q", "-m", "add fresh"]);
  branchBaseOnlySha = await git(targetRepo, ["rev-parse", "HEAD"]);
  await git(targetRepo, ["checkout", "-q", "main"]);
  await git(targetRepo, ["branch", "-q", "-D", "ahead"]);
  writePackage(otherRoot, "fresh");
  writePackage(otherRoot, "train");
});

afterAll(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

beforeEach(() => {
  previousStrict = process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  previousExplicit = process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = "1";
  delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
});

afterEach(() => {
  if (previousStrict === undefined) {
    delete process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH;
  } else {
    process.env.PENUMBRA_REQUIRE_PROMPT_PROJECT_MATCH = previousStrict;
  }
  if (previousExplicit === undefined) {
    delete process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID;
  } else {
    process.env.PENUMBRA_DAEMON_REQUIRE_EXPLICIT_PROJECT_ID = previousExplicit;
  }
});

function tempServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  let n = 0;
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/chains-routing-guard-git-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    clock: () => new Date("2026-10-01T00:00:00Z"),
    uuid: () => `id-${String(++n)}`,
    agentRegistry: ["planner"],
  });
  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["penumbra", { project_id: "penumbra", root_path: targetRepo }],
      ["nova", { project_id: "nova", root_path: otherRoot }],
    ]),
  );
  services.watchdog = {
    recordHeartbeat: (): void => undefined,
    hasActiveWorker: (): boolean => true,
    getStaleWorkers: (): string[] => [],
    getStaleHeartbeatAges: (): { worker_id: string; last_seen_age_ms: number }[] => [],
    tick: (): Promise<void> => Promise.resolve(),
  };
  return services;
}

function startRequest(body: Record<string, unknown>): Request {
  return new Request("http://t/chains/start", {
    method: "POST",
    body: JSON.stringify({
      initial_agent: "planner",
      project_id: "penumbra",
      task_class: "STANDARD",
      use_worktree: false,
      ...body,
    }),
  });
}

test("strict mode accepts a package that exists only at the dispatch's branch_base", async () => {
  const res = await chainsStartRoute(
    startRequest({ message: "extend packages/fresh", branch_base: branchBaseOnlySha }),
    tempServices(),
  );

  expect(res.status).toBe(200);
  expect(((await res.json()) as { routing_warning?: unknown }).routing_warning).toBeUndefined();
});

test("strict mode still rejects a package the target project never had", async () => {
  const res = await chainsStartRoute(
    startRequest({ message: "work in packages/train", branch_base: "main" }),
    tempServices(),
  );

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: {
      code: "prompt_project_mismatch",
      project_id: "penumbra",
      mentioned_paths: ["packages/train"],
      missing_in_project: ["packages/train"],
      suggested_project_id: "nova",
      hint: "pass project_id explicitly or update prompt paths",
    },
  });
});
