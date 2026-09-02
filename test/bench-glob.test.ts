import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function scan(pattern: string): string[] {
  return Array.from(new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT }));
}

test("bench tests live under package scripts bench files", () => {
  const candidates = [
    ...scan("packages/**/*.bench.test.ts"),
    ...scan("packages/**/test/**/bench*.test.ts"),
  ];
  const strays = candidates
    .filter((path) => !path.includes("/node_modules/"))
    .filter((path) => !path.includes("/dist/"))
    .filter((path) => !/\/scripts\/bench[^/]*\.test\.ts$/.test(path))
    .sort();

  expect(strays).toEqual([]);
});

test("embed recipe bench stays in core scripts", () => {
  expect(existsSync(join(REPO_ROOT, "packages/core/scripts/bench-embed-recipe.test.ts"))).toBe(
    true,
  );
});
