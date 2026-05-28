import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ENV_REGISTRY } from "../src/env.js";

function matchesGlob(path: string, glob: string) {
  const pattern = glob
    .replaceAll(".", "\\.")
    .replaceAll("**/", "(?:.*\\/)?")
    .replaceAll("**", ".*")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${pattern}$`).test(path);
}

function isExcluded(file: string, excludeGlobs: string[]) {
  const normalized = file.split(sep).join("/");
  return excludeGlobs.some((glob) => matchesGlob(normalized, glob));
}

function walkFiles(rootDir: string, excludeGlobs: string[]) {
  const files: string[] = [];
  const stack = [resolve(rootDir)];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(rootDir, full).split(sep).join("/");
      if (rel !== "packages" && !rel.startsWith("packages/")) continue;
      if (isExcluded(rel, excludeGlobs) || rel.includes("/dist/") || rel.includes("/node_modules/"))
        continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith(".ts") && !full.endsWith(".d.ts")) files.push(full);
    }
  }
  return files;
}

export function scanForPenumbraTokens(rootDir: string, excludeGlobs: string[]) {
  const tokens = new Set<string>();
  const firstSeen = new Map<string, { file: string; line: number }>();
  for (const file of walkFiles(rootDir, excludeGlobs)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
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
      line = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "");
      const cut = line.indexOf("//");
      if (cut >= 0) line = line.slice(0, cut);
      for (const match of line.matchAll(/\b(?:process\.env|Bun\.env\.)?(PENUMBRA_[A-Z0-9_]+)\b/g)) {
        const token = match[1];
        tokens.add(token);
        if (!firstSeen.has(token)) firstSeen.set(token, { file, line: i + 1 });
      }
    }
  }
  return { tokens, firstSeen };
}

function assertAllRegistered(rootDir: string, excludeGlobs: string[]) {
  const { tokens, firstSeen } = scanForPenumbraTokens(rootDir, excludeGlobs);
  const missing = [...tokens].filter(
    (token) => !Object.prototype.hasOwnProperty.call(ENV_REGISTRY, token),
  );
  expect(
    missing.length
      ? missing
          .map((token) => `${token} ${firstSeen.get(token)?.file}:${firstSeen.get(token)?.line}`)
          .join("\n")
      : "",
  ).toBe("");
}

describe("scanForPenumbraTokens", () => {
  const fixtureDir = "/tmp/penumbra-env-registry-fixture";
  const fixturePath = join(fixtureDir, "packages", "fixture.ts");

  afterEach(async () => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("detects missing token", async () => {
    mkdirSync(join(fixtureDir, "packages"), { recursive: true });
    await Bun.write(fixturePath, "process.env.PENUMBRA_NOT_REGISTERED_TEST_TOKEN;\n");
    const result = scanForPenumbraTokens(fixtureDir, [
      "packages/config/**",
      "**/dist/**",
      "**/node_modules/**",
    ]);
    expect(result.tokens.has("PENUMBRA_NOT_REGISTERED_TEST_TOKEN")).toBe(true);
  });

  test("live tree passes", () => {
    expect(() =>
      assertAllRegistered(".", ["packages/config/**", "**/dist/**", "**/node_modules/**"]),
    ).not.toThrow();
  });

  test("ignores comment references", async () => {
    mkdirSync(join(fixtureDir, "packages"), { recursive: true });
    await Bun.write(fixturePath, "// PENUMBRA_TODO_LATER\n");
    const result = scanForPenumbraTokens(fixtureDir, [
      "packages/config/**",
      "**/dist/**",
      "**/node_modules/**",
    ]);
    expect(result.tokens.has("PENUMBRA_TODO_LATER")).toBe(false);
  });

  test("detects digit-bearing tokens (regression: regex must include 0-9)", async () => {
    mkdirSync(join(fixtureDir, "packages"), { recursive: true });
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
