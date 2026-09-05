import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function findCompiledTestFiles(): string[] {
  const glob = new Bun.Glob("packages/*/dist/**/*.{test,spec}.{js,jsx}");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: REPO_ROOT, absolute: true })) {
    if (!path.includes("/node_modules/")) {
      files.push(relative(REPO_ROOT, path));
    }
  }
  return files.sort();
}

test("no compiled test files are emitted into packages/*/dist", () => {
  const files = findCompiledTestFiles();
  expect(files).toEqual([]);
});
