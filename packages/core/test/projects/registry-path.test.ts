import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProjectRegistry } from "../../src/projects/registry.js";

const dirs: string[] = [];
let prevHome: string | undefined;
let prevConfigDir: string | undefined;
let prevProjectsYaml: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  prevConfigDir = process.env.PENUMBRA_CONFIG_DIR;
  prevProjectsYaml = process.env.PENUMBRA_PROJECTS_YAML;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevConfigDir === undefined) delete process.env.PENUMBRA_CONFIG_DIR;
  else process.env.PENUMBRA_CONFIG_DIR = prevConfigDir;
  if (prevProjectsYaml === undefined) delete process.env.PENUMBRA_PROJECTS_YAML;
  else process.env.PENUMBRA_PROJECTS_YAML = prevProjectsYaml;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("loadProjectRegistry reads projects.yaml from PENUMBRA_CONFIG_DIR", () => {
  const home = mkdtempSync(join(tmpdir(), "penumbra-project-registry-home-"));
  const configDir = join(home, "custom-config");
  const path = join(configDir, "projects.yaml");
  dirs.push(home);
  process.env.HOME = home;
  process.env.PENUMBRA_CONFIG_DIR = configDir;
  delete process.env.PENUMBRA_PROJECTS_YAML;

  mkdirSync(configDir, { recursive: true });
  writeFileSync(path, "projects:\n  - project_id: penumbra\n    root_path: /tmp/penumbra\n");

  const registry = loadProjectRegistry();
  expect(registry.get("penumbra")?.root_path).toBe("/tmp/penumbra");
});

test("loadProjectRegistry uses PENUMBRA_PROJECTS_YAML override when set", () => {
  const root = mkdtempSync(join(tmpdir(), "penumbra-project-registry-override-"));
  const sourcePath = join(root, "source-projects.yaml");
  dirs.push(root);
  process.env.PENUMBRA_PROJECTS_YAML = sourcePath;
  process.env.PENUMBRA_CONFIG_DIR = join(root, "ignored");

  writeFileSync(sourcePath, "projects:\n  - project_id: sirius\n    root_path: /tmp/sirius\n");

  const registry = loadProjectRegistry();
  expect(registry.get("sirius")?.root_path).toBe("/tmp/sirius");
});
