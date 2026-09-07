import { expect, test } from "bun:test";
import { readdirSync, readFileSync, Dirent } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOT_CONFIG = join(REPO_ROOT, "tsconfig.json");

// HOLE 1 fix: only real build/test projects count as coverage.
// tsconfig.eslint.json is NOT in the tsc --build graph and must not satisfy the census.
const BUILD_CONFIG_RE = /^tsconfig\.(json|test\.json|scripts\.json)$/;

function findConfigFiles(): string[] {
  const configs: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > 4) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === ".penumbra" ||
        entry.name === ".git" ||
        entry.name === "coverage" ||
        entry.name === "storybook-static"
      )
        continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile() && BUILD_CONFIG_RE.test(entry.name)) {
        configs.push(fullPath);
      }
    }
  }

  walk(REPO_ROOT, 0);
  return configs.sort();
}

// HOLE 2 fix: build the transitive references graph from the root tsconfig.json.
// Every package tsconfig.json must be reachable from the root solution.
function readReferences(configPath: string): string[] {
  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as { references?: { path: string }[] };
    if (!Array.isArray(parsed.references)) return [];
    const configDir = dirname(configPath);
    return parsed.references.map((r) => {
      const refPath = resolve(configDir, r.path);
      return refPath.endsWith(".json") ? refPath : join(refPath, "tsconfig.json");
    });
  } catch {
    return [];
  }
}

function buildReachableSet(rootConfig: string): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [rootConfig];
  while (queue.length > 0) {
    const cfg = queue.shift()!;
    if (reachable.has(cfg)) continue;
    reachable.add(cfg);
    for (const ref of readReferences(cfg)) {
      if (!reachable.has(ref)) queue.push(ref);
    }
  }
  return reachable;
}

// HOLE 5 fix: fail loudly on a non-zero exit from tsc --showConfig.
// A broken or spoofed config must not silently read as "covers nothing".
function getResolvedFiles(configPath: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "-p", configPath, "--showConfig"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `tsc --showConfig failed (exit ${result.exitCode}) for ${configPath}` +
        (stderr ? `:\n${stderr}` : ""),
    );
  }
  const output = result.stdout.toString();
  if (!output.trim()) return [];
  try {
    const parsed = JSON.parse(output);
    return (parsed.files ?? []) as string[];
  } catch {
    throw new Error(`tsc --showConfig produced unparseable output for ${configPath}`);
  }
}

// HOLE 3 fix: cover .tsx files and root-level .ts/.tsx files.
// dot:true ensures dot-directories (e.g. .storybook) are not silently skipped.
function collectAllTsFiles(): Set<string> {
  const patterns = [
    "packages/**/*.ts",
    "packages/**/*.tsx",
    "plugin/**/*.ts",
    "plugin/**/*.tsx",
    "scripts/**/*.ts",
    "scripts/**/*.tsx",
    "test/**/*.ts",
    "test/**/*.tsx",
    "*.ts",
    "*.tsx",
  ];
  const files = new Set<string>();
  for (const pattern of patterns) {
    for (const path of new Bun.Glob(pattern).scanSync({
      cwd: REPO_ROOT,
      absolute: true,
      dot: true,
    })) {
      if (path.includes("/node_modules/")) continue;
      if (path.includes("/dist/")) continue;
      if (path.includes("/.penumbra/")) continue;
      if (path.includes("/coverage/")) continue;
      if (path.includes("/storybook-static/")) continue;
      if (path.endsWith(".d.ts")) continue;
      files.add(path);
    }
  }
  return files;
}

function resolveConfigFile(configPath: string, file: string): string {
  if (file.startsWith("/")) return resolve(file);
  const configDir = configDirOf(configPath);
  return resolve(configDir, file);
}

function configDirOf(configPath: string): string {
  return configPath.includes("/") ? configPath.slice(0, configPath.lastIndexOf("/")) : ".";
}

// Closed, shrink-only allowlist. HOLE 4 fix: the size is pinned so that
// adding a new entry is a visible, deliberate act that fails the test.
// To add an entry you must also bump ALLOWLIST_EXPECTED_SIZE.
const ALLOWLIST = new Set<string>([
  // Playwright e2e specs — eslint ignores **/*.spec.ts globally; these are
  // compiled and run by Playwright's own runner, not tsc.
  "packages/console/e2e/handoff-flows.spec.ts",
  "packages/console/e2e/mission-panels.spec.ts",
  "packages/console/e2e/mission-smoke.spec.ts",
  "packages/console/e2e/navigation.spec.ts",
  "packages/console/e2e/parity.spec.ts",
  "packages/console/e2e/registrar-panels.spec.ts",
  "packages/console/e2e/sessions-panels.spec.ts",
  "packages/console/e2e/smoke.spec.ts",
  "packages/console/e2e/t0-tail.spec.ts",
  // Playwright e2e helpers — consumed only by .spec.ts files above.
  // The harness/ directory was split out of e2e/harness.ts by the table-driven harness refactor.
  "packages/console/e2e/_helpers.ts",
  "packages/console/e2e/harness.ts",
  "packages/console/e2e/harness/fixtures/index.ts",
  "packages/console/e2e/harness/fixtures/mission.ts",
  "packages/console/e2e/harness/fixtures/registrar.ts",
  "packages/console/e2e/harness/fixtures/sessions.ts",
  "packages/console/e2e/harness/index.ts",
  "packages/console/e2e/harness/server.ts",
  "packages/console/e2e/parity-fixture.ts",
  // Framework config files — imported by Vite/Playwright at runtime, not tsc.
  "packages/console/vite.config.ts",
  "packages/console/playwright.config.ts",
  "packages/console/playwright-visual.config.ts",
  // Storybook config files — consumed by Storybook's own tooling, not tsc.
  "packages/console/.storybook/main.ts",
  "packages/console/.storybook/preview.tsx",
  // Scripts only covered by tsconfig.eslint.json, not the tsc build graph.
  // Pre-existing gap: these were never in any tsconfig.json/tsconfig.test.json
  // include. Bringing them into the build graph may surface type errors and
  // raise the ratchet floor — deferred to a dedicated PR.
  "packages/console/scripts/capture-parity-references.ts",
  "packages/core/scripts/bench-embed-recipe.test.ts",
  "packages/daemon/test-utils.ts",
  "packages/mcp/scripts/invocations-summarize.ts",
]);

const ALLOWLIST_EXPECTED_SIZE = 27;

test("typecheck census: every package tsconfig.json is reachable from the root build graph", () => {
  const reachable = buildReachableSet(ROOT_CONFIG);

  const allConfigs = findConfigFiles();
  const buildConfigs = allConfigs.filter((c) => c.endsWith("/tsconfig.json") && c !== ROOT_CONFIG);

  const unreachable: string[] = [];
  for (const cfg of buildConfigs) {
    if (!reachable.has(cfg)) {
      unreachable.push(relative(REPO_ROOT, cfg));
    }
  }
  unreachable.sort();

  expect(unreachable).toEqual([]);
});

test("typecheck census: every .ts/.tsx file is in at least one build-graph tsconfig project", () => {
  // HOLE 4: assert the allowlist is a closed, shrink-only set.
  expect(ALLOWLIST.size).toBe(ALLOWLIST_EXPECTED_SIZE);

  const reachable = buildReachableSet(ROOT_CONFIG);

  // Coverage configs: only configs that are actually in the build graph
  // (or test configs extending a reachable build config, or the standalone
  // tsconfig.scripts.json that covers scripts/ and test/).
  const allConfigs = findConfigFiles();
  const scriptsConfig = allConfigs.find((c) => c === join(REPO_ROOT, "tsconfig.scripts.json"));

  const coverageConfigs: string[] = [];
  for (const cfg of allConfigs) {
    if (cfg.endsWith("/tsconfig.test.json")) {
      const sibling = cfg.replace("/tsconfig.test.json", "/tsconfig.json");
      if (reachable.has(sibling)) {
        coverageConfigs.push(cfg);
      }
    } else if (cfg.endsWith("/tsconfig.json") && cfg !== ROOT_CONFIG) {
      if (reachable.has(cfg)) {
        coverageConfigs.push(cfg);
      }
    }
  }
  if (scriptsConfig) coverageConfigs.push(scriptsConfig);

  const coveredFiles = new Set<string>();
  for (const configPath of coverageConfigs) {
    const files = getResolvedFiles(configPath);
    for (const file of files) {
      const abs = resolveConfigFile(configPath, file);
      if (abs.endsWith(".ts") || abs.endsWith(".tsx")) {
        coveredFiles.add(abs);
      }
    }
  }

  const allTsFiles = collectAllTsFiles();

  const uncovered: string[] = [];
  for (const file of allTsFiles) {
    if (!coveredFiles.has(file)) {
      uncovered.push(relative(REPO_ROOT, file));
    }
  }
  uncovered.sort();

  const unexpected = uncovered.filter((f) => !ALLOWLIST.has(f));
  const missingAllowlisted = [...ALLOWLIST].filter((f) => !uncovered.includes(f));

  if (unexpected.length > 0 || missingAllowlisted.length > 0) {
    const lines: string[] = [];
    if (unexpected.length > 0) {
      lines.push(`UNCOVERED .ts/.tsx files outside the tsconfig graph (${unexpected.length}):`);
      for (const f of unexpected) {
        lines.push(`  ${f}`);
      }
    }
    if (missingAllowlisted.length > 0) {
      lines.push(`\nSTALE allowlist entries (declared but now covered or gone):`);
      for (const f of missingAllowlisted) {
        lines.push(`  ${f}`);
      }
    }
    lines.push(
      `\nTo fix: either add the uncovered files to a tsconfig include,` +
        ` or add them to the ALLOWLIST in this test with a justification` +
        ` (and bump ALLOWLIST_EXPECTED_SIZE).`,
    );
    expect(lines.join("\n")).toBe("no uncovered files");
  }

  expect(unexpected).toEqual([]);
  expect(missingAllowlisted).toEqual([]);
});
