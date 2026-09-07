import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { LEGACY_TSX_FILES, LEGACY_TSX_RULES } from "../../eslint.config.mjs";

const REPO_ROOT = resolve(import.meta.dir, "../..");

test("eslint does not ignore console .tsx files", async () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const ignored = await eslint.isPathIgnored("packages/console/src/shell/Rail.tsx");
  expect(ignored).toBe(false);
});

test("LEGACY_TSX_FILES and LEGACY_TSX_RULES match the checked-in snapshot and every listed file exists", async () => {
  const snapshotPath = resolve(import.meta.dir, "legacy-tsx.snapshot.json");
  const snapshotText = await Bun.file(snapshotPath).text();
  const snapshot = JSON.parse(snapshotText) as {
    legacyTsxFiles: string[];
    legacyTsxRules: Record<string, string>;
  };

  expect([...LEGACY_TSX_FILES]).toEqual(snapshot.legacyTsxFiles);
  expect({ ...LEGACY_TSX_RULES }).toEqual(snapshot.legacyTsxRules);

  for (const file of LEGACY_TSX_FILES) {
    const abs = resolve(REPO_ROOT, file);
    expect(existsSync(abs)).toBe(true);
  }
});
