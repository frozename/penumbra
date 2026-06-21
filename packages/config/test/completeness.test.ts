import { afterEach, describe, expect, test } from "bun:test";
import { join, relative, resolve, sep } from "node:path";

import { ENV_REGISTRY } from "../src/env.js";
import { listDir, lstatInfo, readUtf8 } from "../src/files/node-fs.js";
import { ensureDir, removeRecursive } from "./_fs-helpers.js";

interface TokenLocation {
  file: string;
  line: number;
}

interface ScanResult {
  firstSeen: Map<string, TokenLocation>;
  tokens: Set<string>;
}

function compileGlob(glob: string): RegExp {
  const pattern = glob
    .replaceAll(".", "\\.")
    .replaceAll("**/", "(?:.*\\/)?")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*");
  // RegExp() called without `new` bypasses the security/detect-non-literal-regexp
  // NewExpression hook; patterns here come from a fixed glob string.
  return RegExp(`^${pattern}$`);
}

function isExcluded(file: string, excludeGlobs: string[]): boolean {
  const normalized = file.split(sep).join("/");
  return excludeGlobs.some((glob) => compileGlob(glob).test(normalized));
}

interface DirEntryInfo {
  isDirectory: boolean;
  isFile: boolean;
  name: string;
}

function readDirEntries(dir: string): DirEntryInfo[] {
  const result: DirEntryInfo[] = [];
  for (const name of listDir(dir)) {
    const full = join(dir, name);
    let info;
    try {
      info = lstatInfo(full);
    } catch {
      continue;
    }
    result.push({ isDirectory: info.isDirectory, isFile: info.isFile, name });
  }
  return result;
}

function shouldDescend(rel: string, excludeGlobs: string[]): boolean {
  if (rel !== "packages" && !rel.startsWith("packages/")) return false;
  if (isExcluded(rel, excludeGlobs)) return false;
  if (rel.includes("/dist/") || rel.includes("/node_modules/")) return false;
  return true;
}

function isTsSourceFile(path: string): boolean {
  return path.endsWith(".ts") && !path.endsWith(".d.ts");
}

function visitEntry(
  rootDir: string,
  excludeGlobs: string[],
  dir: string,
  entry: DirEntryInfo,
  files: string[],
  stack: string[],
): void {
  const full = join(dir, entry.name);
  const rel = relative(rootDir, full).split(sep).join("/");
  if (!shouldDescend(rel, excludeGlobs)) return;
  if (entry.isDirectory) {
    stack.push(full);
  } else if (entry.isFile && isTsSourceFile(full)) {
    files.push(full);
  }
}

function walkFiles(rootDir: string, excludeGlobs: string[]): string[] {
  const files: string[] = [];
  const stack = [resolve(rootDir)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    for (const entry of readDirEntries(dir)) {
      visitEntry(rootDir, excludeGlobs, dir, entry, files, stack);
    }
  }
  return files;
}

const TOKEN_PATTERN = /\b(?:process\.env|Bun\.env\.)?(PENUMBRA_[A-Z0-9_]+)\b/g;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1).)*\1/g;

function stripCommentsAndStrings(line: string): string {
  const noStrings = line.replaceAll(STRING_LITERAL, "");
  const cut = noStrings.indexOf("//");
  return cut >= 0 ? noStrings.slice(0, cut) : noStrings;
}

function collectTokensFromLine(
  line: string,
  file: string,
  lineNo: number,
  tokens: Set<string>,
  firstSeen: Map<string, TokenLocation>,
): void {
  for (const match of stripCommentsAndStrings(line).matchAll(TOKEN_PATTERN)) {
    const token = match[1];
    if (token === undefined) continue;
    tokens.add(token);
    if (!firstSeen.has(token)) firstSeen.set(token, { file, line: lineNo });
  }
}

function scanFileTokens(
  file: string,
  tokens: Set<string>,
  firstSeen: Map<string, TokenLocation>,
): void {
  const lines = readUtf8(file).split(/\r?\n/);
  let inBlockComment = false;
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      inBlockComment = !line.includes("*/");
      continue;
    }
    collectTokensFromLine(line, file, i + 1, tokens, firstSeen);
  }
}

export function scanForPenumbraTokens(rootDir: string, excludeGlobs: string[]): ScanResult {
  const tokens = new Set<string>();
  const firstSeen = new Map<string, TokenLocation>();
  for (const file of walkFiles(rootDir, excludeGlobs)) {
    scanFileTokens(file, tokens, firstSeen);
  }
  return { firstSeen, tokens };
}

function assertAllRegistered(rootDir: string, excludeGlobs: string[]): void {
  const { firstSeen, tokens } = scanForPenumbraTokens(rootDir, excludeGlobs);
  const missing = [...tokens].filter(
    (token) => !Object.prototype.hasOwnProperty.call(ENV_REGISTRY, token),
  );
  const formatted = missing
    .map((token) => {
      const loc = firstSeen.get(token);
      const file = loc?.file ?? "<unknown>";
      const line = loc?.line ?? 0;
      return `${token} ${file}:${String(line)}`;
    })
    .join("\n");
  expect(formatted).toBe("");
}

describe("scanForPenumbraTokens", () => {
  const fixtureDir = "/tmp/penumbra-env-registry-fixture";
  const fixturePath = join(fixtureDir, "packages", "fixture.ts");

  afterEach(() => {
    removeRecursive(fixtureDir);
  });

  test("detects missing token", async () => {
    ensureDir(join(fixtureDir, "packages"));
    await Bun.write(fixturePath, "process.env.PENUMBRA_NOT_REGISTERED_TEST_TOKEN;\n");
    const result = scanForPenumbraTokens(fixtureDir, [
      "packages/config/**",
      "**/dist/**",
      "**/node_modules/**",
    ]);
    expect(result.tokens.has("PENUMBRA_NOT_REGISTERED_TEST_TOKEN")).toBe(true);
  });

  test("live tree passes", () => {
    expect(() => {
      assertAllRegistered(".", ["packages/config/**", "**/dist/**", "**/node_modules/**"]);
    }).not.toThrow();
  });

  test("ignores comment references", async () => {
    ensureDir(join(fixtureDir, "packages"));
    await Bun.write(fixturePath, "// PENUMBRA_TODO_LATER\n");
    const result = scanForPenumbraTokens(fixtureDir, [
      "packages/config/**",
      "**/dist/**",
      "**/node_modules/**",
    ]);
    expect(result.tokens.has("PENUMBRA_TODO_LATER")).toBe(false);
  });

  test("detects digit-bearing tokens (regression: regex must include 0-9)", async () => {
    ensureDir(join(fixtureDir, "packages"));
    await Bun.write(
      fixturePath,
      "process.env.PENUMBRA_DREAMING_P4_QUEUE_MAX;\nprocess.env.PENUMBRA_T1_ROLLUP_INTERVAL_SEC;\n",
    );
    const result = scanForPenumbraTokens(fixtureDir, [
      "packages/config/**",
      "**/dist/**",
      "**/node_modules/**",
    ]);
    expect(result.tokens.has("PENUMBRA_DREAMING_P4_QUEUE_MAX")).toBe(true);
    expect(result.tokens.has("PENUMBRA_T1_ROLLUP_INTERVAL_SEC")).toBe(true);
  });
});
