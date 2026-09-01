import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const consoleDir = resolve(testDir, "..");
const tsconfigPath = resolve(consoleDir, "tsconfig.json");
const viteConfigPath = resolve(consoleDir, "vite.config.ts");

type ViteAliasEntry = {
  find: string | RegExp;
  replacement?: string;
};

type ViteConfig = {
  resolve?: {
    alias?: Record<string, string> | ViteAliasEntry[];
  };
};

function stripJsonComments(source: string): string {
  return source.replaceAll(
    /("(?:\\.|[^"\\])*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
    (match: string, stringLiteral: string | undefined) =>
      stringLiteral ?? "\n".repeat(match.split("\n").length - 1),
  );
}

function normalizeTsconfigPath(pattern: string): string {
  return pattern.replace(/\/\*$/, "");
}

async function loadViteConfig(): Promise<ViteConfig> {
  const module = (await import(pathToFileURL(viteConfigPath).href)) as { default: ViteConfig };
  return module.default;
}

function getViteSrcAliasTarget(viteConfig: ViteConfig): string | undefined {
  const alias = viteConfig.resolve?.alias;

  if (Array.isArray(alias)) {
    const entry = alias.find(
      (item) => item.find === "@src" || (item.find instanceof RegExp && item.find.test("@src/")),
    );
    return entry?.replacement ? normalizeTsconfigPath(entry.replacement) : undefined;
  }

  return alias?.["@src"] ? normalizeTsconfigPath(alias["@src"]) : undefined;
}

describe("console build config", () => {
  test("keeps the Vite @src alias aligned with tsconfig paths", async () => {
    const tsconfig = JSON.parse(stripJsonComments(readFileSync(tsconfigPath, "utf8"))) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const tsconfigSrcPath = tsconfig.compilerOptions?.paths?.["@src/*"]?.[0];

    if (!tsconfigSrcPath) {
      throw new Error(
        `${tsconfigPath} is missing compilerOptions.paths["@src/*"], which must stay aligned with ${viteConfigPath}`,
      );
    }

    const viteSrcAliasTarget = getViteSrcAliasTarget(await loadViteConfig());
    if (!viteSrcAliasTarget) {
      throw new Error(
        `${tsconfigPath} declares compilerOptions.paths["@src/*"], but ${viteConfigPath} is missing resolve.alias for @src`,
      );
    }

    expect(resolve(consoleDir, normalizeTsconfigPath(tsconfigSrcPath))).toBe(
      resolve(consoleDir, viteSrcAliasTarget),
    );
  });
});
