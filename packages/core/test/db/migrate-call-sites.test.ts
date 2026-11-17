import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const MIGRATIONS_MODULE = "packages/core/src/db/migrations.ts";
const SCHEMA_MODULE = "packages/core/src/db/schema.ts";
const CALL_PATTERN = /(?<![\w.])migrate\(/g;

interface MigrateCallSite {
  file: string;
  text: string;
}

function extractCallText(source: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen);
}

function collectMigrateCallSites(): MigrateCallSite[] {
  const sites: MigrateCallSite[] = [];
  for (const rel of new Bun.Glob("packages/*/src/**/*.ts").scanSync({ cwd: repoRoot })) {
    if (rel === MIGRATIONS_MODULE) continue;
    const source = readFileSync(join(repoRoot, rel), "utf8");
    for (const match of source.matchAll(CALL_PATTERN)) {
      const openParen = match.index + match[0].length - 1;
      sites.push({ file: rel, text: extractCallText(source, openParen) });
    }
  }
  return sites;
}

test("every migrate() call site passes a migrationGate", () => {
  const ungated = collectMigrateCallSites().filter((site) => !site.text.includes("migrationGate"));
  expect(ungated).toEqual([]);
});

test("migrate() call sites include the cli start and init commands", () => {
  const sites = collectMigrateCallSites();
  expect(sites.length).toBeGreaterThanOrEqual(2);
  const files = new Set(sites.map((site) => site.file));
  expect(files.has("packages/cli/src/commands/start.ts")).toBe(true);
  expect(files.has("packages/cli/src/commands/init.ts")).toBe(true);
});

test("applySchema() is only referenced by the core db modules", () => {
  const offenders: string[] = [];
  for (const rel of new Bun.Glob("packages/*/src/**/*.ts").scanSync({ cwd: repoRoot })) {
    if (rel === MIGRATIONS_MODULE || rel === SCHEMA_MODULE) continue;
    if (readFileSync(join(repoRoot, rel), "utf8").includes("applySchema(")) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});
