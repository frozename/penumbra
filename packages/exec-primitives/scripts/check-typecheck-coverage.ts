/**
 * check-typecheck-coverage.ts — prove every .ts source under
 * packages/exec-primitives is actually typechecked. `bun test` transpiles
 * without typechecking and the shipped tsconfig only includes src/**, so
 * test files, scripts and consumer sources would silently rot. This gate:
 *
 *   1. compiles the whole tree via tsconfig.test.json (noEmit);
 *   2. lists the files tsc resolved (--listFilesOnly);
 *   3. fails if any walked .ts file is absent from that list.
 *
 * Consumer files resolve `penumbra-exec-primitives` through a compile-time
 * paths mapping to ./src/index.ts — exercising the same exported types the
 * packed .d.ts surface hands them — so this gate needs no consumer
 * node_modules. The mapping lives only in this coverage config; consumer
 * tsconfigs never remap the specifier.
 *
 * Excluded trees are inputs, not checkable sources: audit fixtures contain
 * deliberately broken imports, and vendor/node_modules/test/contract are
 * generated or installed per run.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPTS_DIR = import.meta.dir;
const PACKAGE_DIR = dirname(SCRIPTS_DIR);
const CONFIG = join(PACKAGE_DIR, "tsconfig.test.json");

const SKIP_SEGMENTS = new Set(["node_modules", "vendor", "dist", "dist-coverage", ".git"]);
const SKIP_DIRS = new Set([
  join(PACKAGE_DIR, "qualification", "audit-fixtures"),
  join(PACKAGE_DIR, "qualification", "consumers", "infra-host", "test", "contract"),
  join(PACKAGE_DIR, "qualification", "consumers", "penumbra-host", "test", "contract"),
]);

function collectTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (SKIP_SEGMENTS.has(name) || SKIP_DIRS.has(path)) continue;
      out.push(...collectTs(path));
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".mts") || name.endsWith(".cts")) {
      out.push(path);
    }
  }
  return out;
}

const check = spawnSync("bunx", ["tsc", "-p", CONFIG, "--noEmit"], {
  cwd: PACKAGE_DIR,
  encoding: "utf8",
});
if (check.status !== 0) {
  process.stdout.write(check.stdout);
  process.stderr.write(check.stderr);
  process.stderr.write(`typecheck-coverage: FAIL — tsc exited ${String(check.status)}\n`);
  process.exit(1);
}

const list = spawnSync("bunx", ["tsc", "-p", CONFIG, "--listFilesOnly"], {
  cwd: PACKAGE_DIR,
  encoding: "utf8",
});
if (list.status !== 0) {
  process.stderr.write(`typecheck-coverage: FAIL — listFiles exited ${String(list.status)}\n`);
  process.exit(1);
}

const packageRoot = realpathSync(PACKAGE_DIR);
const covered = new Set(
  list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => realpathSync(resolve(line))),
);

const uncovered = collectTs(PACKAGE_DIR)
  .map((path) => realpathSync(path))
  .filter((path) => !covered.has(path))
  .map((path) => relative(packageRoot, path))
  .sort();

if (uncovered.length > 0) {
  for (const file of uncovered) {
    process.stdout.write(`finding: ${file} not covered by tsconfig.test.json\n`);
  }
  process.stderr.write(
    `typecheck-coverage: FAIL — ${String(uncovered.length)} uncovered file(s)\n`,
  );
  process.exit(1);
}
process.stdout.write(`typecheck-coverage: PASS (${String(covered.size)} covered files)\n`);
process.exit(0);
