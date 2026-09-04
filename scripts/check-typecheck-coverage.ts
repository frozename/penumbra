#!/usr/bin/env bun
/**
 * Typecheck coverage ratchet — measures the type-error debt that `bun run
 * typecheck` (tsc --build) is silent on because the root tsconfig references
 * omit test files for most packages.
 *
 * For each package (and the root scripts/ + test/ project) this script runs
 * `tsc -p <tsconfig.test.json> --noEmit` using NORMAL BUILD OPTIONS
 * (tsconfig.base.json: strict, noUncheckedIndexedAccess — NO eslint-only
 * strictness flags like exactOptionalPropertyTypes or
 * noPropertyAccessFromIndexSignature). It counts TS diagnostic lines and
 * compares against a committed ratchet file (typecheck-coverage-ratchet.json).
 *
 * Exit codes:
 *   0 — all packages at or below their floor
 *   1 — at least one package EXCEEDS its floor, or a package is MISSING from
 *       the ratchet (new package slipped in uncounted)
 *
 * Going below the floor is NOT a failure, but a loud message is printed
 * urging the operator to lower the floor.
 *
 * Usage:
 *   bun scripts/check-typecheck-coverage.ts            # check against ratchet
 *   bun scripts/check-typecheck-coverage.ts --update    # rewrite ratchet
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface RatchetEntry {
  errorCount: number;
}

interface RatchetFile {
  optionSet: string;
  packages: Record<string, RatchetEntry>;
  total: number;
}

interface Project {
  name: string;
  configPath: string;
}

interface ProjectResult {
  name: string;
  count: number;
}

const ROOT = resolve(import.meta.dirname, "..");
const RATCHET_PATH = join(ROOT, "typecheck-coverage-ratchet.json");
const OPTION_SET = "tsconfig.base.json (strict + noUncheckedIndexedAccess; NO eslint-only flags)";

function tryStat(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function collectPackageProjects(pkgName: string, pkgDir: string, projects: Project[]): void {
  const testCfg = join(pkgDir, "tsconfig.test.json");
  if (tryStat(testCfg)) {
    projects.push({ name: `packages/${pkgName}`, configPath: testCfg });
  }
}

function collectIntegrationProjects(integrationsDir: string, projects: Project[]): void {
  for (const sub of readdirSync(integrationsDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = join(integrationsDir, sub.name);
    const testCfg = join(subDir, "tsconfig.test.json");
    if (tryStat(testCfg)) {
      projects.push({
        name: `packages/integrations/${sub.name}`,
        configPath: testCfg,
      });
    }
  }
}

function discoverProjects(): Project[] {
  const projects: Project[] = [];

  for (const entry of readdirSync(join(ROOT, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(ROOT, "packages", entry.name);
    if (entry.name === "integrations") {
      collectIntegrationProjects(pkgDir, projects);
      continue;
    }
    collectPackageProjects(entry.name, pkgDir, projects);
  }

  const scriptsCfg = join(ROOT, "tsconfig.scripts.json");
  if (tryStat(scriptsCfg)) {
    projects.push({ name: "scripts+test", configPath: scriptsCfg });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}

function countTypeErrors(configPath: string): number {
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "-p", configPath, "--noEmit"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  const lines = output.split("\n").filter((l) => /^\S.*error TS\d+:/.test(l));
  return lines.length;
}

async function loadRatchet(): Promise<RatchetFile | null> {
  try {
    const file = Bun.file(RATCHET_PATH);
    if (!(await file.exists())) return null;
    const data = (await file.json()) as RatchetFile;
    return data;
  } catch {
    return null;
  }
}

function formatProjectLine(
  name: string,
  count: number,
  floor: number | undefined,
): { line: string; violated: boolean } {
  if (floor === undefined) {
    return {
      line: `  [MISSING] ${name}: ${String(count)} errors — NOT in ratchet`,
      violated: true,
    };
  }
  if (count > floor) {
    return {
      line: `  [REGRESS] ${name}: ${String(count)} errors (floor: ${String(floor)}) — +${String(count - floor)}`,
      violated: true,
    };
  }
  if (count < floor) {
    return {
      line: `  [IMPROVE] ${name}: ${String(count)} errors (floor: ${String(floor)}) — LOWER THE FLOOR by ${String(floor - count)}`,
      violated: false,
    };
  }
  return {
    line: `  [ok]     ${name}: ${String(count)} errors (floor: ${String(floor)})`,
    violated: false,
  };
}

function formatTotalLine(total: number, ratchetTotal: number): string {
  if (ratchetTotal >= 0) {
    if (total > ratchetTotal) {
      return `Total: ${String(total)} errors (ratchet total: ${String(ratchetTotal)}) — REGRESSION`;
    }
    if (total < ratchetTotal) {
      return `Total: ${String(total)} errors (ratchet total: ${String(ratchetTotal)}) — improved by ${String(ratchetTotal - total)}`;
    }
    return `Total: ${String(total)} errors (ratchet total: ${String(ratchetTotal)})`;
  }
  return `Total: ${String(total)} errors`;
}

function formatReport(
  results: ProjectResult[],
  ratchet: RatchetFile | null,
): { exitCode: number; lines: string[] } {
  const lines: string[] = [];
  let total = 0;
  let exitCode = 0;

  lines.push("=== Typecheck Coverage Report ===");
  lines.push(`Option set: ${OPTION_SET}`);
  lines.push("");

  const ratchetPackages = ratchet?.packages ?? {};
  const ratchetSet = new Set(Object.keys(ratchetPackages));

  for (const { name, count } of results) {
    total += count;
    const floor = ratchetPackages[name]?.errorCount;
    const { line, violated } = formatProjectLine(name, count, floor);
    lines.push(line);
    if (violated) exitCode = 1;
    ratchetSet.delete(name);
  }

  for (const stale of ratchetSet) {
    lines.push(`  [STALE]  ${stale}: in ratchet but no tsconfig.test.json found`);
    exitCode = 1;
  }

  lines.push("");
  lines.push(formatTotalLine(total, ratchet?.total ?? -1));

  if (exitCode === 0) {
    lines.push("\nAll packages at or below their floor.");
  } else {
    lines.push("\nFAIL: ratchet violation(s) above.");
  }

  return { exitCode, lines };
}

async function main(): Promise<void> {
  const argSet = new Set(process.argv.slice(2));
  const updateMode = argSet.has("--update") || argSet.has("--write");

  const projects = discoverProjects();
  const results: ProjectResult[] = [];

  for (const project of projects) {
    process.stderr.write(`Checking ${project.name}...`);
    const count = countTypeErrors(project.configPath);
    process.stderr.write(` ${String(count)} errors\n`);
    results.push({ name: project.name, count });
  }

  if (updateMode) {
    const ratchet: RatchetFile = {
      optionSet: OPTION_SET,
      packages: {},
      total: 0,
    };
    for (const { name, count } of results) {
      ratchet.packages[name] = { errorCount: count };
      ratchet.total += count;
    }
    writeFileSync(RATCHET_PATH, JSON.stringify(ratchet, null, 2) + "\n");
    process.stdout.write(`Ratchet written to ${RATCHET_PATH}\n`);
    process.stdout.write(
      `Total: ${String(ratchet.total)} errors across ${String(results.length)} projects\n`,
    );
    process.exit(0);
  }

  const ratchet = await loadRatchet();
  const { exitCode, lines } = formatReport(results, ratchet);
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(exitCode);
}

void main();
