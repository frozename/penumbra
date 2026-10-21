import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LeftDispatchedEvent } from "../src/events/handoff-transitions.js";

import { migrate } from "../src/db/migrations.js";
import { loadSqliteVec } from "../src/db/sqlite-vec.js";
import { TestEmbedder } from "../src/embedder/test-embedder.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { buildServices } from "../src/services.js";

// On macOS, Bun uses the Apple SQLite build which disables extension loading.
// Switch to Homebrew's full-featured SQLite before any Database is created.
// See: https://bun.sh/docs/api/sqlite#loadextension
// Guard: setCustomSQLite throws if called after SQLite is already loaded (e.g.
// when multiple test files in the same bun test run each attempt the call).
try {
  if (process.platform === "darwin") {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  }
} catch {
  // already loaded in this process
}

test("buildServices wires all core dependencies with injected clock/uuid", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-svc-"));
  try {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const svc = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      clock: (): Date => new Date("2026-04-23T00:00:00Z"),
      uuid: (): string => "u",
    });
    expect(svc.settings.t0RetentionDays).toBe(30);
    expect(svc.machineId.get()).toBe("u");
    expect(svc.redactor).toBeDefined();
    expect(svc.t0Writer).toBeDefined();
    expect(svc.recallReader).toBeDefined();
    expect(svc.supervisor).toBeDefined();
    expect(svc.projectCache).toBeDefined();
    expect(svc.pidRegistry).toBeDefined();
    expect(svc.workflowRegistry).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildServices wires handoffTransitions into handoffWriter", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-svc-transitions-"));
  try {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const svc = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
    });
    const seen: LeftDispatchedEvent[] = [];
    svc.handoffTransitions.subscribe((event) => seen.push(event));
    svc.handoffWriter.createApproved({
      handoff_id: "h-svc-transition",
      ts: "2026-05-11T00:00:00Z",
      project_id: null,
      conversation_id: "conv-svc-transition",
      from: "a",
      to: "seat-a",
      to_role: null,
      message: "m",
      triggered_by_event_id: null,
      resolved_by: "u",
      resolved_at: null,
      chain_max_hops: null,
      chain_trust_mode: null,
      chain_task_type: null,
      use_worktree: null,
      parent_handoff_id: null,
    });
    expect(svc.handoffWriter.claimDispatch("h-svc-transition", "worker-1")).toBe(true);

    expect(svc.handoffWriter.markCompleted("h-svc-transition")).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.to_status).toBe("completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildServices passes through workflowRegistry when provided", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-svc-wf-"));
  try {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    migrate(db, { embeddingDim: 384 });
    const stub = {
      list: (): { name: string }[] => [{ name: "demo" }],
      entries: (): never[] => [],
      get: (): undefined => undefined,
      findByTrigger: (): never[] => [],
      getEntry: (): undefined => undefined,
      errors: [],
    };
    const svc = buildServices({
      env: {},
      input: {},
      storageRoot: dir,
      db,
      embedder: new TestEmbedder({ dim: 384 }),
      workflowRegistry: stub,
    });
    expect(svc.workflowRegistry).toBe(stub);
    expect(svc.workflowRegistry?.list().length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildServices wires resolveProjectRoot from projectRegistry", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const reg = new ProjectRegistry(
    new Map([["sirius", { project_id: "sirius", root_path: "/tmp/sirius-not-real" }]]),
  );

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-wiring-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    projectRegistry: reg,
  });

  // Test exercises private project-resolution helpers; cast through unknown to
  // a narrow shape rather than asserting the full WorktreeManager surface.
  const manager = services.worktreeManager as unknown as {
    baseFor(project_id: string): string;
    repoRootFor(project_id: string): string;
  };
  expect(manager.baseFor("sirius")).toBe("/tmp/sirius-not-real-worktrees");
  expect(manager.repoRootFor("sirius")).toBe("/tmp/sirius-not-real");
});

test("buildServices without projectRegistry resolves no project roots", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-noreg-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });

  const manager = services.worktreeManager as unknown as {
    baseFor(project_id: string): string;
  };
  expect(manager.baseFor("sirius")).not.toContain("sirius-not-real");
});

test("buildServices with an empty projectRegistry keeps legacy worktree fallback behavior", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const reg = new ProjectRegistry(new Map());
  const rootDir = "/tmp/svc-empty-registry-worktrees";

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-empty-registry-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    worktreeRootDir: rootDir,
    projectRegistry: reg,
  });

  const manager = services.worktreeManager as unknown as {
    baseFor(project_id: string): string;
  };
  expect(manager.baseFor("whatever")).toBe(rootDir);
});

test("buildServices worktree project resolution follows a reloaded projectRegistry", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const reg = new ProjectRegistry(
    new Map([["sirius", { project_id: "sirius", root_path: "/tmp/sirius-not-real" }]]),
  );

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-reload-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    projectRegistry: reg,
  });

  services.projectRegistry = new ProjectRegistry(
    new Map([
      ["sirius", { project_id: "sirius", root_path: "/tmp/sirius-not-real" }],
      ["vega", { project_id: "vega", root_path: "/tmp/vega-not-real" }],
    ]),
  );

  expect(services.worktreeManager.projectRootFor("vega")).toBe("/tmp/vega-not-real");

  const manager = services.worktreeManager as unknown as {
    baseFor(project_id: string): string;
  };
  expect(manager.baseFor("vega")).toBe("/tmp/vega-not-real-worktrees");
});

test("buildServices with an empty boot projectRegistry resolves projects added by a reload", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const rootDir = "/tmp/svc-reload-empty-worktrees";
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-reload-empty-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    worktreeRootDir: rootDir,
    projectRegistry: new ProjectRegistry(new Map()),
  });

  const manager = services.worktreeManager as unknown as {
    baseFor(project_id: string): string;
  };
  expect(manager.baseFor("vega")).toBe(rootDir);

  services.projectRegistry = new ProjectRegistry(
    new Map([["vega", { project_id: "vega", root_path: "/tmp/vega-not-real" }]]),
  );
  expect(manager.baseFor("vega")).toBe("/tmp/vega-not-real-worktrees");
});

test("buildServices worktree resolution falls back to the boot registry when the live registry cannot be read", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const reg = new ProjectRegistry(
    new Map([["sirius", { project_id: "sirius", root_path: "/tmp/sirius-not-real" }]]),
  );

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-boot-fallback-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    projectRegistry: reg,
  });

  services.projectRegistry = {
    list: () => {
      throw new Error("registry unavailable");
    },
  } as unknown as ProjectRegistry;

  expect(services.worktreeManager.projectRootFor("sirius")).toBe("/tmp/sirius-not-real");
});

test("buildServices requireKnownProjectId follows the live registry", () => {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });

  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/svc-require-known-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    projectRegistry: new ProjectRegistry(new Map()),
  });

  const manager = services.worktreeManager as unknown as {
    requireKnownProjectId?: () => boolean;
  };
  expect(manager.requireKnownProjectId?.()).toBe(false);

  services.projectRegistry = new ProjectRegistry(
    new Map([["vega", { project_id: "vega", root_path: "/tmp/vega-not-real" }]]),
  );
  expect(manager.requireKnownProjectId?.()).toBe(true);
});

function initCommittedRepo(repo: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { stdio: "ignore" },
  );
}

// Boots with an empty registry and then registers `vega` the way
// daemon_reload_config does: by replacing services.projectRegistry.
function buildServicesThenRegisterVega(
  storageRoot: string,
  repo: string,
): ReturnType<typeof buildServices> {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot,
    db,
    embedder: new TestEmbedder({ dim: 384 }),
    projectRegistry: new ProjectRegistry(new Map()),
  });
  services.projectRegistry = new ProjectRegistry(
    new Map([["vega", { project_id: "vega", root_path: repo }]]),
  );
  return services;
}

test("buildServices scratch worktrees match a project added by a reloaded projectRegistry", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-svc-scratch-match-"));
  try {
    const repo = join(dir, "vega");
    initCommittedRepo(repo);
    const services = buildServicesThenRegisterVega(join(dir, "storage"), repo);

    expect(services.scratchWorktrees.scratchCwdProject(repo)).toEqual({
      status: "matched",
      project_id: "vega",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildServices scratch orphan sweep reaps the scratch base of a project added by a reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-svc-scratch-sweep-"));
  try {
    const repo = join(dir, "vega");
    initCommittedRepo(repo);
    const storageRoot = join(dir, "storage");
    const crashed = buildServicesThenRegisterVega(storageRoot, repo);
    const handle = await crashed.scratchWorktrees.acquire({
      owner_run_id: "run-orphan",
      cwd: repo,
    });
    expect(handle.project_id).toBe("vega");

    // A fresh boot of the same daemon has no live set, so the previous
    // incarnation's scratch is an orphan it must find under vega's base.
    const restarted = buildServicesThenRegisterVega(storageRoot, repo);
    const sweep = await restarted.scratchWorktrees.sweepOrphans();
    expect(sweep.reaped).toContain(handle.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
