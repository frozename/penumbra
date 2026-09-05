import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ESLINT_CONFIG = resolve(REPO_ROOT, "eslint.config.mjs");
const TSC_PATH = resolve(REPO_ROOT, "node_modules/.bin/tsc");

function extractStringLiterals(block: string): string[] {
  const values: string[] = [];
  const re = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    values.push(m[1]);
  }
  return values;
}

function isIgnoredByEslint(rel: string): boolean {
  return (
    rel.includes("/node_modules/") ||
    rel.includes("/dist/") ||
    rel.endsWith(".d.ts") ||
    rel.endsWith(".spec.ts")
  );
}

async function listProjectFiles(configRel: string): Promise<string[]> {
  const configAbs = resolve(REPO_ROOT, configRel);
  const proc = Bun.spawn(["bun", TSC_PATH, "--listFilesOnly", "-p", configAbs], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await proc.stdout.text();
  await proc.exited;
  const lines = out
    .split("\n")
    .filter((line) => line.startsWith(REPO_ROOT) && !line.includes("/node_modules/"));
  if (lines.length === 0) {
    throw new Error(`tsc --listFilesOnly produced no files for ${configRel}`);
  }
  return lines
    .map((line) => relative(REPO_ROOT, line))
    .filter((rel) => rel.endsWith(".ts") && !isIgnoredByEslint(rel));
}

test("every file linted by eslint is covered by a type-aware parser project", async () => {
  const configText = await Bun.file(ESLINT_CONFIG).text();

  const sourceGlobsMatch = configText.match(/const\s+SOURCE_GLOBS\s*=\s*\[([\s\S]*?)\];/);
  expect(sourceGlobsMatch).not.toBeNull();
  const sourceGlobs = extractStringLiterals(sourceGlobsMatch![1]);

  const projectPatterns: string[] = [];
  const projectRe = /project:\s*(?:\[([\s\S]*?)\]|"([^"]+)")/g;
  let pm: RegExpExecArray | null;
  while ((pm = projectRe.exec(configText)) !== null) {
    if (pm[1]) {
      projectPatterns.push(...extractStringLiterals(pm[1]));
    } else if (pm[2]) {
      projectPatterns.push(pm[2]);
    }
  }

  const lintedFiles = new Set<string>();
  for (const pattern of sourceGlobs) {
    const glob = new Bun.Glob(pattern);
    for (const path of glob.scanSync({ cwd: REPO_ROOT, absolute: true })) {
      const rel = relative(REPO_ROOT, path);
      if (isIgnoredByEslint(rel)) continue;
      lintedFiles.add(rel);
    }
  }

  const projectConfigs = new Set<string>();
  for (const pattern of projectPatterns) {
    const glob = new Bun.Glob(pattern);
    for (const path of glob.scanSync({ cwd: REPO_ROOT, absolute: true })) {
      if (path.includes("/node_modules/")) continue;
      projectConfigs.add(relative(REPO_ROOT, path));
    }
  }

  const projectFiles = await Promise.all(
    [...projectConfigs].sort().map((config) => listProjectFiles(config)),
  );

  const coveredFiles = new Set<string>();
  for (const files of projectFiles) {
    for (const f of files) {
      coveredFiles.add(f);
    }
  }

  const uncovered = [...lintedFiles].filter((f) => !coveredFiles.has(f)).sort();

  if (uncovered.length > 0) {
    const byPackage = new Map<string, string[]>();
    for (const f of uncovered) {
      const pkgMatch = f.match(/^packages\/([^/]+)\//);
      const key = pkgMatch ? `packages/${pkgMatch[1]}` : (f.split("/")[0] ?? "<root>");
      const list = byPackage.get(key) ?? [];
      list.push(f);
      byPackage.set(key, list);
    }

    const lines: string[] = [
      `${uncovered.length} file(s) matched by eslint SOURCE_GLOBS are not in any type-aware parser project.`,
      'This usually means a tsconfig.eslint.json extends a base tsconfig with "exclude" and does not re-declare "exclude": [] to clear it.',
      "Uncovered files:",
    ];
    for (const [pkg, files] of [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${pkg}:`);
      for (const f of files) {
        lines.push(`    ${f}`);
      }
    }
    throw new Error(lines.join("\n"));
  }

  expect(uncovered).toEqual([]);
});
