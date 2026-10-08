import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

export type UndeclaredWorkspaceImport = {
  file: string;
  line: number;
  owner: string;
  specifier: string;
};

type Manifest = {
  name: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type Owner = { directory: string; manifest: Manifest };
type Specifier = { text: string; position: number };

const IGNORED_DIRS = new Set(["node_modules", "dist", ".test-storage", ".git"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Manifest;
}

function discoverOwners(root: string): Owner[] {
  const manifest = readManifest(root);
  const owners: Owner[] = [{ directory: root, manifest }];
  for (const pattern of manifest.workspaces ?? []) {
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      const directory = resolve(root, file, "..");
      owners.push({ directory, manifest: readManifest(directory) });
    }
  }
  return owners.sort((a, b) => b.directory.length - a.directory.length);
}

function insideGitWorkTree(root: string): boolean {
  try {
    const probe = Bun.spawnSync({
      cmd: ["git", "rev-parse", "--is-inside-work-tree"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return probe.exitCode === 0 && probe.stdout.toString().trim() === "true";
  } catch {
    return false;
  }
}

function trackedSourceFiles(root: string): string[] {
  const listed = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed for ${root}: ${listed.stderr.toString().trim()}`);
  }
  const files: string[] = [];
  for (const relativePath of listed.stdout.toString().split("\0")) {
    const directories = relativePath.split("/").slice(0, -1);
    if (
      !SOURCE_EXTENSIONS.has(extname(relativePath)) ||
      directories.some((directory) => IGNORED_DIRS.has(directory))
    ) {
      continue;
    }
    const path = join(root, relativePath);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isFile() === true) files.push(path);
  }
  return files.sort();
}

function walkSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
      files.push(...walkSourceFiles(path));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

// A git work tree is scanned through its index only: a filesystem walk also
// descends into untracked nested checkouts and copies that are not part of the
// repo. A root outside git (test fixtures) falls back to the walk.
function collectSourceFiles(root: string): string[] {
  if (insideGitWorkTree(root)) return trackedSourceFiles(root);
  return walkSourceFiles(root);
}

function isTrackedCall(expression: ts.Expression): boolean {
  if (expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(expression)) return expression.text === "require";
  if (!ts.isPropertyAccessExpression(expression)) return false;
  const receiver = expression.expression;
  const method = expression.name.text;
  if (ts.isIdentifier(receiver)) {
    return (
      (receiver.text === "require" && method === "resolve") ||
      (receiver.text === "mock" && method === "module")
    );
  }
  return (
    ts.isMetaProperty(receiver) &&
    receiver.keywordToken === ts.SyntaxKind.ImportKeyword &&
    receiver.name.text === "meta" &&
    method === "resolve"
  );
}

function nodeSpecifier(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isCallExpression(node) && isTrackedCall(node.expression)) return node.arguments[0];
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return node.argument.literal;
  if (ts.isExternalModuleReference(node)) return node.expression;
  return undefined;
}

function readSpecifiers(sourceFile: ts.SourceFile): Specifier[] {
  const specifiers: Specifier[] = sourceFile.typeReferenceDirectives.map((reference) => ({
    text: reference.fileName,
    position: reference.pos,
  }));
  const visit = (node: ts.Node): void => {
    const specifier = nodeSpecifier(node);
    if (specifier && ts.isStringLiteralLike(specifier)) {
      specifiers.push({ text: specifier.text, position: specifier.getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers.sort((a, b) => a.position - b.position);
}

function isDeclared(manifest: Manifest, specifier: string): boolean {
  const packageName = specifier.split("/").slice(0, 2).join("/");
  return (
    packageName === manifest.name ||
    [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some(
      (dependencies) => dependencies !== undefined && Object.hasOwn(dependencies, packageName),
    )
  );
}

function scanFile(root: string, file: string, owner: Manifest): UndeclaredWorkspaceImport[] {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  return readSpecifiers(sourceFile)
    .filter(({ text }) => text.startsWith("@penumbra/") && !isDeclared(owner, text))
    .map(({ text, position }) => ({
      file: relative(root, file).split(sep).join("/"),
      line: sourceFile.getLineAndCharacterOfPosition(position).line + 1,
      owner: owner.name,
      specifier: text,
    }));
}

export function findUndeclaredWorkspaceImports(repoRoot: string): UndeclaredWorkspaceImport[] {
  const root = resolve(repoRoot);
  const owners = discoverOwners(root);
  return collectSourceFiles(root).flatMap((file) => {
    const owner = owners.find(({ directory }) => file.startsWith(`${directory}${sep}`));
    if (!owner) throw new Error(`No package owner for ${file}`);
    return scanFile(root, file, owner.manifest);
  });
}
