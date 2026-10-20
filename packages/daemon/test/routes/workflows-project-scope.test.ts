import { ProjectRegistry, resolveProjectScope, type Services } from "@penumbra/core";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflowsStatusRoute } from "@src/routes/workflows.js";
import { createWorkflowRunsRegistry } from "@src/services/workflow-runs-registry.js";

if (process.platform === "darwin") {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {
    // Optional Homebrew SQLite is unavailable in some CI images.
  }
}

type Fixture = {
  repoA: string;
  repoB: string;
  link: string;
  runA: string;
  runB: string;
  services: Services;
};

let fixture: Fixture;
const cleanup: string[] = [];

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      result_json TEXT,
      error_json TEXT,
      result_spill_path TEXT,
      error_spill_path TEXT,
      result_bytes INTEGER NOT NULL DEFAULT 0,
      error_bytes INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

function makeRepo(remote: string): string {
  const root = mkdtempSync(join(tmpdir(), "wf-project-scope-"));
  cleanup.push(root);
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["remote", "add", "origin", remote], { cwd: root });
  return root;
}

function projectOf(cwd: string): string {
  const scope = resolveProjectScope({ cwd });
  if (scope.project_id === null) throw new Error(`expected a project for ${cwd}`);
  return scope.project_id;
}

beforeEach(() => {
  const repoA = makeRepo("https://example.com/scope/a.git");
  const repoB = makeRepo("https://example.com/scope/b.git");
  const linkDir = mkdtempSync(join(tmpdir(), "wf-project-scope-link-"));
  cleanup.push(linkDir);
  const link = join(linkDir, "cwd");
  symlinkSync(repoA, link);

  const db = freshDb();
  let nextId = 0;
  const workflowRuns = createWorkflowRunsRegistry({
    uuid: () => `wfrun-${String(++nextId)}`,
    clock: () => new Date("2026-05-29T00:00:00Z"),
    db,
    storageRoot: linkDir,
  });
  const runA = workflowRuns.register("wf", projectOf(repoA));
  const runB = workflowRuns.register("wf", projectOf(repoB));
  if (!runA || !runB) throw new Error("expected both runs to register");
  // Unregistered repos resolve to synthetic git ids, so the scope a caller
  // sees comes straight from the git resolution under test.
  const services = {
    workflowRuns,
    projectRegistry: new ProjectRegistry(new Map()),
    db,
    log: { warn: (): undefined => undefined, error: (): undefined => undefined },
  } as unknown as Services;
  fixture = { repoA, repoB, link, runA, runB, services };
});

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function statusFor(runId: string, cwd: string): Promise<number> {
  const req = new Request("http://localhost/workflows/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_run_id: runId, cwd }),
  });
  const res = await workflowsStatusRoute(req, fixture.services);
  return res.status;
}

test("two cwds keep their own workflow scopes across interleaved requests", async () => {
  const { repoA, repoB, runA, runB } = fixture;
  expect(await statusFor(runA, repoA)).toBe(200);
  expect(await statusFor(runA, repoB)).toBe(404);
  expect(await statusFor(runB, repoB)).toBe(200);
  expect(await statusFor(runB, repoA)).toBe(404);
  expect(await statusFor(runA, repoA)).toBe(200);
});

test("a symlinked cwd retargeted at another repo loses the old repo's runs", async () => {
  const { link, repoB, runA, runB } = fixture;
  expect(await statusFor(runA, link)).toBe(200);
  unlinkSync(link);
  symlinkSync(repoB, link);
  expect(await statusFor(runA, link)).toBe(404);
  expect(await statusFor(runB, link)).toBe(200);
});

test("a cwd deleted after a successful lookup is rejected as untrusted", async () => {
  const { repoA, runA } = fixture;
  expect(await statusFor(runA, repoA)).toBe(200);
  rmSync(repoA, { recursive: true, force: true });
  expect(await statusFor(runA, repoA)).toBe(400);
});
