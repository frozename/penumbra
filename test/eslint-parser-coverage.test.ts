import { expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ESLINT_CONFIG = resolve(REPO_ROOT, "eslint.config.mjs");

// eslint's flat-config built-in global ignores apply on top of whatever the
// config's own `ignores` array declares.
const ESLINT_BUILTIN_IGNORES = ["**/node_modules/**", ".git/**"];

function extractStringLiterals(block: string): string[] {
  const values: string[] = [];
  for (const m of block.matchAll(/"([^"]*)"/g)) {
    const value = m[1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function requiredBlock(text: string, re: RegExp, what: string): string {
  const m = text.match(re);
  const inner = m?.[1];
  if (inner === undefined) {
    throw new Error(
      `Could not parse ${what} out of ${ESLINT_CONFIG}. This tripwire reads it to learn ` +
        `which files eslint lints and which tsconfig projects give them type info; if the ` +
        `declaration was renamed or reformatted, update this regex rather than deleting the check.`,
    );
  }
  return inner;
}

// Project membership is resolved with TypeScript's own config parser in-process:
// readConfigFile + parseJsonConfigFileContent follow the `extends` chain (re-basing
// relative include/exclude paths to the config that declares them) and apply
// include/exclude/files with tsc's precedence. No tsc subprocess is spawned and no
// program is built, so the result cannot depend on the state of built dist/*.d.ts —
// that dependence is what made the previous, process-spawning version flaky on CI.
function projectMemberFiles(configPath: string): string[] {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    throw new Error(
      `Failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    const details = parsed.errors
      .map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
      .join("\n  ");
    throw new Error(`tsc config resolution produced diagnostics for ${configPath}:\n  ${details}`);
  }
  return parsed.fileNames;
}

test("every file linted by eslint is covered by a type-aware parser project", () => {
  const configText = ts.sys.readFile(ESLINT_CONFIG);
  if (configText === undefined) {
    throw new Error(`Could not read ${ESLINT_CONFIG}`);
  }

  const sourceGlobs = extractStringLiterals(
    requiredBlock(configText, /const\s+SOURCE_GLOBS\s*=\s*\[([\s\S]*?)\];/, "SOURCE_GLOBS"),
  );
  // The global ignores block must be the sole key of its object and comes first
  // in the config array, so the first `ignores:` match is the global list.
  const globalIgnores = [
    ...extractStringLiterals(
      requiredBlock(configText, /ignores:\s*\[([\s\S]*?)\]/, "the global ignores array"),
    ),
    ...ESLINT_BUILTIN_IGNORES,
  ];
  const ignoreMatchers = globalIgnores.map((p) => new Bun.Glob(p));

  const projectPatterns: string[] = [];
  for (const m of configText.matchAll(/project:\s*(?:\[([\s\S]*?)\]|"([^"]+)")/g)) {
    if (m[1] !== undefined) projectPatterns.push(...extractStringLiterals(m[1]));
    else if (m[2] !== undefined) projectPatterns.push(m[2]);
  }

  const lintedFiles = new Set<string>();
  for (const pattern of sourceGlobs) {
    for (const abs of new Bun.Glob(pattern).scanSync({
      cwd: REPO_ROOT,
      absolute: true,
      dot: true,
    })) {
      const rel = relative(REPO_ROOT, abs);
      if (ignoreMatchers.some((g) => g.match(rel))) continue;
      lintedFiles.add(rel);
    }
  }

  const projectConfigs = new Set<string>();
  for (const pattern of projectPatterns) {
    for (const abs of new Bun.Glob(pattern).scanSync({
      cwd: REPO_ROOT,
      absolute: true,
      dot: true,
    })) {
      if (abs.includes("/node_modules/")) continue;
      projectConfigs.add(abs);
    }
  }

  const canonical = (p: string): string => {
    const resolved = resolve(p);
    return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
  };

  const coveredFiles = new Set<string>();
  for (const configPath of [...projectConfigs].sort()) {
    for (const f of projectMemberFiles(configPath)) {
      coveredFiles.add(canonical(f));
    }
  }

  // Fail loudly rather than vacuously: if any parsing or resolution step silently
  // yields nothing, `uncovered` would be empty and the check would "pass" while
  // guarding nothing — the exact rot this tripwire exists to prevent.
  expect(sourceGlobs.length).toBeGreaterThan(0);
  expect(globalIgnores.length).toBeGreaterThan(0);
  expect(projectPatterns.length).toBeGreaterThan(0);
  expect(projectConfigs.size).toBeGreaterThan(0);
  expect(lintedFiles.size).toBeGreaterThan(0);
  expect(coveredFiles.size).toBeGreaterThan(0);

  const uncovered = [...lintedFiles]
    .filter((f) => !coveredFiles.has(canonical(resolve(REPO_ROOT, f))))
    .sort();

  if (uncovered.length > 0) {
    const byPackage = new Map<string, string[]>();
    for (const f of uncovered) {
      const pkgMatch = /^packages\/([^/]+)\//.exec(f);
      const key =
        pkgMatch?.[1] !== undefined ? `packages/${pkgMatch[1]}` : (f.split("/")[0] ?? "<root>");
      const list = byPackage.get(key) ?? [];
      list.push(f);
      byPackage.set(key, list);
    }

    const lines: string[] = [
      `${String(uncovered.length)} file(s) matched by eslint SOURCE_GLOBS are not in any type-aware parser project.`,
      "A linted file outside every tsconfig.eslint.json project parses without type info, " +
        "falls back to base JS rules, and emits a parse error per file.",
      'The usual cause: a tsconfig.eslint.json extends a base tsconfig that declares "exclude" ' +
        'and does not re-declare "exclude": [] to clear the inherited filter.',
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
  // Resolving ~14 tsconfigs in-process is pure JSON+filesystem work and lands well
  // under a second; the budget is explicit and generous rather than incidental.
}, 60_000);
