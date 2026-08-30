import { loadModelAliasMapFromDir, type ModelAliasMap } from "@src/index.js";
import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeRecursive, writeUtf8 } from "../_fs-helpers.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = nodeFs.mkdtempSync(join(tmpdir(), "model-alias-config-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeRecursive(dir);
  }
});

describe("loadModelAliasMapFromDir", () => {
  test("defaults to an empty map when model-aliases.yaml is absent", () => {
    const loaded = loadModelAliasMapFromDir(makeTempDir());

    expect(loaded).toEqual({} satisfies ModelAliasMap);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test("an empty model-aliases.yaml yields an empty map", () => {
    const dir = makeTempDir();
    writeUtf8(join(dir, "model-aliases.yaml"), "");

    expect(loadModelAliasMapFromDir(dir)).toEqual({} satisfies ModelAliasMap);
  });

  test("rejects a duplicate seat name at load", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "model-aliases.yaml"),
      `
writer:
  aa_creator: anthropic
  aa_slug: claude-sonnet-4-5
writer:
  aa_creator: openai
  aa_slug: gpt-5.6
`,
    );

    expect(() => loadModelAliasMapFromDir(dir)).toThrow(/unique|duplicate/i);

    // yaml currently rejects duplicates by default, so behavior alone cannot prove local ownership.
    const loaderSource = nodeFs.readFileSync(
      join(import.meta.dir, "../../src/files/model-aliases.ts"),
      "utf8",
    );
    expect(loaderSource).toContain("parseYaml(readUtf8(filePath), { uniqueKeys: true })");
  });

  test("two seats mapping to the same (aa_creator, aa_slug) are BOTH accepted", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "model-aliases.yaml"),
      `
planner:
  aa_creator: anthropic
  aa_slug: claude-sonnet-4-5
reviewer:
  aa_creator: anthropic
  aa_slug: claude-sonnet-4-5
`,
    );

    // Fleet reality: planner and executor seats may intentionally share one underlying model.
    expect(loadModelAliasMapFromDir(dir)).toEqual({
      planner: {
        aa_creator: "anthropic",
        aa_slug: "claude-sonnet-4-5",
      },
      reviewer: {
        aa_creator: "anthropic",
        aa_slug: "claude-sonnet-4-5",
      },
    });
  });

  test("prefixes YAML parse errors with the alias path and preserves the cause", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "model-aliases.yaml");
    writeUtf8(filePath, "writer: [\n");

    try {
      loadModelAliasMapFromDir(dir);
      throw new Error("expected loader to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toStartWith(`${filePath}: `);
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  test("rejects a non-canonical provider value in an alias entry", () => {
    const dir = makeTempDir();
    writeUtf8(
      join(dir, "model-aliases.yaml"),
      `
executor:
  aa_creator: OpenAI
  aa_slug: gpt-5.6
`,
    );

    expect(() => loadModelAliasMapFromDir(dir)).toThrow(/aa_creator/);
  });
});
