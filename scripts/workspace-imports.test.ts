import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { findUndeclaredWorkspaceImports } from "./lib/workspace-imports.js";

type Manifest = {
  name: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const temporaryRoots: string[] = [];
const repoRoot = resolve(import.meta.dir, "..");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, contents: string | Manifest): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
}

function git(root: string, ...args: string[]): void {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
  }
}

function fixture(owner: Partial<Manifest> = {}, rootManifest: Partial<Manifest> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "p7a-workspace-imports-"));
  temporaryRoots.push(root);
  write(root, "package.json", {
    name: "fixture-root",
    workspaces: ["packages/*", "packages/integrations/*"],
    ...rootManifest,
  });
  write(root, "packages/a/package.json", { name: "@penumbra/a", ...owner });
  write(root, "packages/b/package.json", { name: "@penumbra/b" });
  return root;
}

const importForms = [
  ["static import", 'import { x } from "@penumbra/b";'],
  ["side-effect import", 'import "@penumbra/b";'],
  ["type-only import", 'import type { X } from "@penumbra/b";'],
  ["export", 'export { x } from "@penumbra/b";'],
  ["type-only export", 'export type { X } from "@penumbra/b";'],
  ["dynamic import", 'const x = import("@penumbra/b");'],
  ["dynamic import template", "const x = import(`@penumbra/b`);"],
  ["require", 'const x = require("@penumbra/b");'],
  ["require template", "const x = require(`@penumbra/b`);"],
  ["import type node", 'type X = import("@penumbra/b").X;'],
  ["mock.module", 'mock.module("@penumbra/b", () => ({}));'],
  ["mock.module template", "mock.module(`@penumbra/b`, () => ({}));"],
  ["require.resolve", 'const x = require . resolve("@penumbra/b");'],
  ["require.resolve template", "const x = require . resolve(`@penumbra/b`);"],
  ["import.meta.resolve", 'const x = import.meta . resolve("@penumbra/b");'],
  ["import.meta.resolve template", "const x = import.meta . resolve(`@penumbra/b`);"],
  ["import equals require", 'import x = require("@penumbra/b");'],
  ["reference types", '/// <reference types="@penumbra/b" />'],
] as const;

test.each(importForms)("reports an undeclared %s", (_name, source) => {
  const root = fixture();
  write(root, "packages/a/src/x.ts", source);
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 1, owner: "@penumbra/a", specifier: "@penumbra/b" },
  ]);
});

test.each(["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"])("scans .%s files", (extension) => {
  const root = fixture();
  const file = `packages/a/src/x.${extension}`;
  write(root, file, 'import "@penumbra/b";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file, line: 1, owner: "@penumbra/a", specifier: "@penumbra/b" },
  ]);
});

test("reports each occurrence with its full subpath and source line", () => {
  const root = fixture();
  write(root, "packages/a/src/x.ts", '\nimport "@penumbra/b/sub";\nimport "@penumbra/b/sub";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 2, owner: "@penumbra/a", specifier: "@penumbra/b/sub" },
    { file: "packages/a/src/x.ts", line: 3, owner: "@penumbra/a", specifier: "@penumbra/b/sub" },
  ]);
});

test("allows self references without allowing a neighboring package name", () => {
  const root = fixture();
  write(
    root,
    "packages/a/src/x.ts",
    'import "@penumbra/a";\nimport "@penumbra/a/sub";\nimport "@penumbra/a-b";',
  );
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 3, owner: "@penumbra/a", specifier: "@penumbra/a-b" },
  ]);
});

test.each(["dependencies", "devDependencies", "optionalDependencies"] as const)(
  "accepts any spec declared in %s",
  (field) => {
    for (const spec of ["*", "workspace:*", "workspace:^", "^1.2.3", "file:../b"]) {
      const root = fixture({ [field]: { "@penumbra/b": spec } });
      write(root, "packages/a/src/x.ts", 'import "@penumbra/b/sub";');
      expect(findUndeclaredWorkspaceImports(root)).toEqual([]);
    }
  },
);

test("reports peer-only declarations", () => {
  const root = fixture({ peerDependencies: { "@penumbra/b": "workspace:*" } });
  write(root, "packages/a/src/x.ts", 'import "@penumbra/b";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 1, owner: "@penumbra/a", specifier: "@penumbra/b" },
  ]);
});

test("does not inherit root declarations", () => {
  const root = fixture({}, { dependencies: { "@penumbra/c": "*" } });
  write(root, "packages/a/src/x.ts", 'import "@penumbra/c";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 1, owner: "@penumbra/a", specifier: "@penumbra/c" },
  ]);
});

test("uses the longest workspace directory prefix, including integrations", () => {
  const root = fixture();
  write(root, "packages/integrations/package.json", {
    name: "@penumbra/parent",
    dependencies: { "@penumbra/b": "*" },
  });
  write(root, "packages/integrations/nested/package.json", { name: "@penumbra/nested" });
  write(root, "packages/integrations/nested/src/x.ts", 'import "@penumbra/b";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    {
      file: "packages/integrations/nested/src/x.ts",
      line: 1,
      owner: "@penumbra/nested",
      specifier: "@penumbra/b",
    },
  ]);
});

test("uses directory boundaries and discovers custom root workspace globs", () => {
  const root = fixture({}, { workspaces: ["modules/*"] });
  write(root, "modules/one/package.json", {
    name: "@penumbra/one",
    dependencies: { "@penumbra/b": "*" },
  });
  write(root, "modules/one/src/x.ts", 'import "@penumbra/b";');
  write(root, "modules/one-extra/x.ts", 'import "@penumbra/b";');
  expect(findUndeclaredWorkspaceImports(root)).toContainEqual({
    file: "modules/one-extra/x.ts",
    line: 1,
    owner: "fixture-root",
    specifier: "@penumbra/b",
  });
  expect(
    findUndeclaredWorkspaceImports(root).some(({ file }) => file === "modules/one/src/x.ts"),
  ).toBe(false);
});

test.each(["plugin", "scripts", "test"])("assigns %s imports to the root package", (directory) => {
  const root = fixture();
  const file = `${directory}/x.ts`;
  write(root, file, 'import "@penumbra/b";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file, line: 1, owner: "fixture-root", specifier: "@penumbra/b" },
  ]);
  write(root, "package.json", {
    name: "fixture-root",
    workspaces: ["packages/*"],
    optionalDependencies: { "@penumbra/b": "*" },
  });
  expect(findUndeclaredWorkspaceImports(root)).toEqual([]);
});

test("ignores generated directories, comments, unrelated calls, strings and computed imports", () => {
  const root = fixture();
  for (const directory of ["node_modules", "dist", ".test-storage"]) {
    write(root, `packages/a/${directory}/x.ts`, 'import "@penumbra/b";');
  }
  write(
    root,
    "packages/a/src/x.ts",
    [
      '// import "@penumbra/b";',
      'const text = "@penumbra/b";',
      'unrelated("@penumbra/b");',
      'other.resolve("@penumbra/b");',
      'import("@penumbra/" + name);',
      "import(`@penumbra/${name}`);",
      'import "external";',
      'import "./relative";',
    ].join("\n"),
  );
  expect(findUndeclaredWorkspaceImports(root)).toEqual([]);
});

test("scans a tracked file inside a git work tree", () => {
  const root = fixture();
  write(root, "packages/a/src/x.ts", 'import "@penumbra/b";');
  git(root, "init", "-q");
  git(root, "add", "-A");
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 1, owner: "@penumbra/a", specifier: "@penumbra/b" },
  ]);
});

test("ignores untracked nested copies and linked checkouts inside a git work tree", () => {
  const root = fixture();
  write(root, "packages/a/src/x.ts", 'import "@penumbra/b";');
  git(root, "init", "-q");
  git(root, "add", "-A");
  write(root, "review-copy/packages/b/y.ts", 'import "@penumbra/c";');
  write(root, "linked-checkout/.git", `gitdir: ${join(root, ".git", "worktrees", "linked")}`);
  write(root, "linked-checkout/package.json", { name: "linked-root" });
  write(root, "linked-checkout/src/z.ts", 'import "@penumbra/c";');
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 1, owner: "@penumbra/a", specifier: "@penumbra/b" },
  ]);
});

test("skips tracked paths that are missing on disk", () => {
  const root = fixture();
  write(root, "packages/a/src/x.ts", 'import "@penumbra/b";');
  write(root, "packages/a/src/gone.ts", 'import "@penumbra/c";');
  git(root, "init", "-q");
  git(root, "add", "-A");
  rmSync(join(root, "packages/a/src/gone.ts"));
  expect(findUndeclaredWorkspaceImports(root)).toEqual([
    { file: "packages/a/src/x.ts", line: 1, owner: "@penumbra/a", specifier: "@penumbra/b" },
  ]);
});

test("detects deleting agentchat's api-contract declaration in a temporary source copy", () => {
  const root = fixture();
  cpSync(join(repoRoot, "package.json"), join(root, "package.json"));
  const original = JSON.parse(
    readFileSync(join(repoRoot, "packages/agentchat/package.json"), "utf8"),
  ) as Manifest;
  write(root, "packages/agentchat/package.json", original);
  const file = "packages/agentchat/test/penumbra-client.test.ts";
  mkdirSync(dirname(join(root, file)), { recursive: true });
  cpSync(join(repoRoot, file), join(root, file));
  expect(findUndeclaredWorkspaceImports(root)).toEqual([]);
  const { ["@penumbra/api-contract"]: removed, ...remaining } = original.devDependencies ?? {};
  expect(removed).toBeDefined();
  write(root, "packages/agentchat/package.json", { ...original, devDependencies: remaining });
  expect(findUndeclaredWorkspaceImports(root)).toContainEqual({
    file,
    line: 1,
    owner: "@penumbra/agentchat",
    specifier: "@penumbra/api-contract",
  });
  write(root, "packages/agentchat/package.json", original);
  expect(findUndeclaredWorkspaceImports(root)).toEqual([]);
});
