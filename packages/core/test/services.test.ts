import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("buildServices without projectRegistry leaves resolveProjectRoot undefined", () => {
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
