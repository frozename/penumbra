import {
  buildServices,
  loadProjectRegistry,
  loadSqliteVec,
  migrate,
  type Services,
} from "@penumbra/core";
import { TestEmbedder } from "@penumbra/core/testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DaemonServices } from "../../src/serve.js";

import { reloadConfigRoute } from "../../src/routes/reload-config.js";

const dirs: string[] = [];
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.PENUMBRA_PROJECTS_YAML;
});

afterEach(() => {
  process.env.PENUMBRA_PROJECTS_YAML = prevEnv;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeServices(): Services {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  migrate(db, { embeddingDim: 384 });
  const services = buildServices({
    env: {},
    input: {},
    storageRoot: "/tmp/penumbra-project-registry-test",
    db,
    embedder: new TestEmbedder({ dim: 384 }),
  });
  return services;
}

function writeRegistry(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-proj-reg-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(path, contents);
  process.env.PENUMBRA_PROJECTS_YAML = path;
  return path;
}

test("loadProjectRegistry uses PENUMBRA_PROJECTS_YAML", () => {
  const path = writeRegistry(`projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n`);
  const reg = loadProjectRegistry(path);
  expect(reg.has("penumbra")).toBe(true);
});

test("loadProjectRegistry parses github remote entries", () => {
  const path = writeRegistry(
    `projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n    remote:\n      kind: github\n      repo: frozename/penumbra\n`,
  );
  const reg = loadProjectRegistry(path);
  expect(reg.get("penumbra")?.remote).toEqual({ kind: "github", repo: "frozename/penumbra" });
});

test("loadProjectRegistry rejects entries that declare both gh_repo and remote", () => {
  const path = writeRegistry(
    `projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n    gh_repo: frozename/penumbra\n    remote:\n      kind: github\n      repo: frozename/penumbra\n`,
  );
  expect(() => loadProjectRegistry(path)).toThrow(
    "declares both legacy gh_repo and remote; pick one",
  );
});

test("loadProjectRegistry returns an empty registry for a missing file", () => {
  const reg = loadProjectRegistry("/nonexistent/penumbra/projects.yaml");
  expect(reg.list().length).toBe(0);
});

test("POST /agentchat/reload refreshes the project registry snapshot", async () => {
  const services = makeServices();
  const daemonSvc = services as unknown as DaemonServices;
  const path = writeRegistry(`projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n`);

  const first = await reloadConfigRoute(
    new Request("http://x/agentchat/reload", { method: "POST" }),
    daemonSvc,
  );
  expect(first.status).toBe(200);
  expect(services.projectRegistry?.list().map((entry) => entry.project_id)).toEqual(["penumbra"]);

  writeFileSync(
    path,
    `projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n  - project_id: sirius\n    root_path: /tmp/sirius\n`,
  );
  const second = await reloadConfigRoute(
    new Request("http://x/agentchat/reload", { method: "POST" }),
    daemonSvc,
  );
  expect(second.status).toBe(200);
  expect(
    services.projectRegistry
      ?.list()
      .map((entry) => entry.project_id)
      .sort(),
  ).toEqual(["penumbra", "sirius"]);
});
