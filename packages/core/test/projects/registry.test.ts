import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultProjectRegistryPath,
  getGithubRepo,
  loadProjectRegistry,
  ProjectRegistryDuplicateId,
  ProjectRegistryParseError,
} from "@src/projects/registry.js";

import { writeBootstrapRegistry } from "./registry-fixtures.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

test("bootstrap parse loads five entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = writeBootstrapRegistry(dir);

  const registry = loadProjectRegistry(path);
  expect(registry.list()).toHaveLength(5);
  expect(registry.get("sirius")?.root_path).toBe("/tmp/sirius");
  expect(registry.has("penumbra")).toBe(true);
  expect(registry.has("nope")).toBe(false);
});

test("loadProjectRegistry stores canonical_root_path for symlinked roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const canonicalDir = join(dir, "canonical");
  const aliasDir = join(dir, "alias");
  mkdirSync(canonicalDir);
  symlinkSync(canonicalDir, aliasDir, "dir");
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: ${aliasDir}
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.root_path).toBe(aliasDir);
  expect(registry.get("penumbra")?.canonical_root_path).toBe(realpathSync(canonicalDir));
});

test("loadProjectRegistry ignores missing root_path canonicalization failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const missingRoot = join(dir, "does-not-exist");
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: ${missingRoot}
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.root_path).toBe(missingRoot);
  expect(registry.get("penumbra")?.canonical_root_path).toBeUndefined();
});

test("canonicalization warning truncates long values", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const missingRoot = "a".repeat(300);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: ${missingRoot}
`,
  );

  const warn = mock((): void => undefined);
  const originalWarn = console.warn;
  console.warn = warn;
  try {
    loadProjectRegistry(path);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`${"a".repeat(253)}...`);
  } finally {
    console.warn = originalWarn;
  }
});

test("duplicate id throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
  - project_id: penumbra
    root_path: /tmp/penumbra-2
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryDuplicateId);
  try {
    loadProjectRegistry(path);
  } catch (err) {
    expect(err).toBeInstanceOf(ProjectRegistryDuplicateId);
    expect((err as ProjectRegistryDuplicateId).id).toBe("penumbra");
  }
});

test("malformed yaml throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(path, "projects: [\n  - not valid yaml\n");

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test("missing file returns empty registry and warns once", () => {
  const path = join(
    tmpdir(),
    `penumbra-missing-${String(Date.now())}-${String(Math.random())}.yaml`,
  );
  const warn = mock((): void => undefined);
  const originalWarn = console.warn;
  console.warn = warn;
  try {
    const first = loadProjectRegistry(path);
    const second = loadProjectRegistry(path);
    expect(first.list()).toHaveLength(0);
    expect(first.get("penumbra")).toBeUndefined();
    expect(second.list()).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    console.warn = originalWarn;
  }
});

test("bad project_id format throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: CAPITALIZED
    root_path: /tmp/capitalized
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test("gh_repo parses owner/name form", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    gh_repo: frozename/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(getGithubRepo(registry.get("penumbra"))).toBe("frozename/penumbra");
});

test("invalid gh_repo format throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    gh_repo: frozename
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test("remote github form parses and helper prefers remote repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      kind: github
      repo: frozename/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.remote).toEqual({ kind: "github", repo: "frozename/penumbra" });
  expect(getGithubRepo(registry.get("penumbra"))).toBe("frozename/penumbra");
});

test("both gh_repo and remote throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    gh_repo: frozename/penumbra
    remote:
      kind: github
      repo: frozename/penumbra
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(
    "declares both legacy gh_repo and remote; pick one",
  );
});

test("invalid remote github repo format throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      kind: github
      repo: frozename
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test("remote parses when repo appears before kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      repo: frozename/penumbra
      kind: github
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.remote).toEqual({ kind: "github", repo: "frozename/penumbra" });
});

test("remote parses with blank line before kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:

      kind: github
      repo: frozename/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.remote).toEqual({ kind: "github", repo: "frozename/penumbra" });
});

test("remote block missing repo throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      kind: github
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow("remote block must contain kind and repo");
});

test("multiple remote entries do not swallow the next project", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    remote:
      kind: github
      repo: frozename/penumbra
  - project_id: sirius
    root_path: /tmp/sirius
    remote:
      repo: frozename/sirius
      kind: github
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.list()).toHaveLength(2);
  expect(registry.get("penumbra")?.remote).toEqual({ kind: "github", repo: "frozename/penumbra" });
  expect(registry.get("sirius")?.remote).toEqual({ kind: "github", repo: "frozename/sirius" });
});

test("default registry path points at home .config/penumbra/projects.yaml", () => {
  expect(defaultProjectRegistryPath()).toMatch(/\.config[\\/]penumbra[\\/]+projects\.yaml$/);
});

test("dreaming block parses full config", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: firecrawl
      allowed_domains:
        - example.com
        - wikipedia.org
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming).toEqual({
    research_provider: "firecrawl",
    allowed_domains: ["example.com", "wikipedia.org"],
  });
});

test("dreaming block parses without allowed_domains", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: webfetch
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming?.research_provider).toBe("webfetch");
  expect(registry.get("penumbra")?.dreaming?.allowed_domains).toBeUndefined();
});

test("missing dreaming block leaves dreaming undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming).toBeUndefined();
});

test("invalid dreaming research_provider throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: invalid
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test("dreaming block parses research_provider and allowed_domains", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: firecrawl
      allowed_domains:
        - example.com
        - wikipedia.org
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming).toEqual({
    research_provider: "firecrawl",
    allowed_domains: ["example.com", "wikipedia.org"],
  });
});

test("dreaming block parses only research_provider and leaves allowed_domains undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: webfetch
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming?.research_provider).toBe("webfetch");
  expect(registry.get("penumbra")?.dreaming?.allowed_domains).toBeUndefined();
});

test("dreaming block omitted leaves entry dreaming undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming).toBeUndefined();
});

test("invalid dreaming research_provider is rejected by schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: invalid
`,
  );

  expect(() => loadProjectRegistry(path)).toThrow(ProjectRegistryParseError);
});

test("dreaming block followed by another project entry: domain-list parser stops at sibling indent", () => {
  // Regression: original parser greedily consumed the next project's `  - project_id:`
  // as a domain entry because `^\s+-\s*(.+)\s*$` didn't enforce strict indent depth.
  mkdirSync("/tmp/penumbra", { recursive: true });
  mkdirSync("/tmp/sirius", { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: firecrawl
      allowed_domains:
        - en.wikipedia.org
        - docs.anthropic.com
  - project_id: sirius
    root_path: /tmp/sirius
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.list()).toHaveLength(2);
  expect(registry.get("penumbra")?.dreaming?.allowed_domains).toEqual([
    "en.wikipedia.org",
    "docs.anthropic.com",
  ]);
  expect(registry.has("sirius")).toBe(true);
  expect(registry.get("sirius")?.root_path).toBe("/tmp/sirius");
});

test("entry key inline comments are stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: foo # comment
    root_path: /tmp/foo
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("foo")?.project_id).toBe("foo");
});

test("quoted root_path inline comments are stripped from raw value only", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: quotes
    root_path: "/path/with spaces"  # comment
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("quotes")?.root_path).toBe("/path/with spaces");
});

test("dreaming research_provider inline comments are stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      research_provider: firecrawl   # enabled
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming?.research_provider).toBe("firecrawl");
});

test("allowed_domains inline comments are stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: penumbra
    root_path: /tmp/penumbra
    dreaming:
      allowed_domains:
        - example.com   # primary
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("penumbra")?.dreaming?.allowed_domains).toEqual(["example.com"]);
});

test("quoted inline # is preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "penumbra-project-registry-"));
  dirs.push(dir);
  const path = join(dir, "projects.yaml");
  writeFileSync(
    path,
    `projects:
  - project_id: foo
    root_path: "foo # not-comment"
`,
  );

  const registry = loadProjectRegistry(path);
  expect(registry.get("foo")?.root_path).toBe("foo # not-comment");
});
