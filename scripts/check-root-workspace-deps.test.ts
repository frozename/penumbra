import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

type PackageJson = {
  devDependencies?: Record<string, string>;
};

const SCAN_ROOTS = ["plugin", "scripts", "test"] as const;
const IGNORED_DIRS = new Set(["dist", "node_modules"]);
const WORKSPACE_SPECIFIER_PATTERN = /^@penumbra\/[a-z0-9-]+/;

function collectTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) files.push(...collectTypeScriptFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) files.push(entryPath);
  }
  return files;
}

function findPenumbraWorkspaceImports(): string[] {
  const packages = new Set<string>();
  for (const root of SCAN_ROOTS) {
    for (const file of collectTypeScriptFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const packageName of readWorkspaceSpecifiers(file, source)) packages.add(packageName);
    }
  }
  return [...packages].sort();
}

function packageFromSpecifier(specifier: string): string | null {
  return WORKSPACE_SPECIFIER_PATTERN.exec(specifier)?.[0] ?? null;
}

function readWorkspaceSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const packages = new Set<string>();
  const record = (specifier: ts.Expression | undefined): void => {
    if (!specifier || !ts.isStringLiteral(specifier)) return;
    const packageName = packageFromSpecifier(specifier.text);
    if (packageName) packages.add(packageName);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return [...packages];
}

test("root package declares workspace deps imported outside packages", () => {
  const rootPackageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  const devDependencies = rootPackageJson.devDependencies ?? {};
  const missing = findPenumbraWorkspaceImports().filter(
    (packageName) => devDependencies[packageName] !== "workspace:*",
  );

  expect(missing).toEqual([]);
});
