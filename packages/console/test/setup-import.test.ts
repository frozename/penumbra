import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as ts from "typescript";

const TEST_ROOT = import.meta.dir;
const SETUP_IMPORT_RE = /^import "(?:\.\.\/)+setup";$/;
const RENDER_CALL_RE = /\b(?:render|renderHook)\(/;
const CLEANUP_RE = /afterEach\(\s*cleanup\s*\)|\bcleanup\(\)/;
const DOM_GLOBALS = new Set(["document", "window", "localStorage", "HTMLElement"]);

function collectTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(path));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function displayPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join("/");
}

function isExcluded(path: string): boolean {
  const display = displayPath(path);
  return (
    path === import.meta.path ||
    display.includes("/e2e/") ||
    display.includes("/visual/") ||
    display.includes("/dist/")
  );
}

function requiresSetupImport(path: string, source: string): boolean {
  return path.endsWith(".test.tsx") || hasDomDependency(source);
}

function firstImportLine(source: string): string | null {
  return source.split(/\r?\n/).find((line) => line.startsWith("import ")) ?? null;
}

function hasDomDependency(source: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.Identifier && DOM_GLOBALS.has(scanner.getTokenText())) {
      return true;
    }
    if (
      token === ts.SyntaxKind.StringLiteral &&
      scanner.getTokenText().includes("@testing-library")
    ) {
      return true;
    }
  }
  return false;
}

describe("console test setup imports", () => {
  test("DOM-dependent tests import happy-dom setup as their first import", () => {
    const offenders = collectTestFiles(TEST_ROOT)
      .filter((path) => !isExcluded(path))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return (
          requiresSetupImport(path, source) && !SETUP_IMPORT_RE.test(firstImportLine(source) ?? "")
        );
      })
      .map(displayPath);

    if (offenders.length > 0) {
      throw new Error(`Missing setup import as first import in:\n${offenders.join("\n")}`);
    }

    expect(offenders).toEqual([]);
  });

  // Each file must unmount its own trees. A cleanup registered in a shared setup
  // module binds to whichever file imports it first, so a file that renders
  // without its own cleanup leaks its DOM into every file that runs after it.
  test("files that render register their own cleanup", () => {
    const offenders = collectTestFiles(TEST_ROOT)
      .filter((path) => !isExcluded(path))
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return RENDER_CALL_RE.test(source) && !CLEANUP_RE.test(source);
      })
      .map(displayPath);

    if (offenders.length > 0) {
      throw new Error(`Missing afterEach(cleanup) in:\n${offenders.join("\n")}`);
    }

    expect(offenders).toEqual([]);
  });
});
