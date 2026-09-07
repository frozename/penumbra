import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LEGACY_TSX_FILES, LEGACY_TSX_RULES } from "../../eslint.config.mjs";

const SNAPSHOT_PATH = resolve(import.meta.dir, "legacy-tsx.snapshot.json");

function buildSnapshot(): {
  legacyTsxFiles: string[];
  legacyTsxRules: Record<string, string>;
} {
  return {
    legacyTsxFiles: [...LEGACY_TSX_FILES],
    legacyTsxRules: { ...LEGACY_TSX_RULES },
  };
}

if (process.argv.includes("--write")) {
  const snapshot = buildSnapshot();
  const dir = resolve(SNAPSHOT_PATH, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(snapshot, null, 2) + "\n";
  await Bun.write(SNAPSHOT_PATH, json);
  console.log(`Wrote ${SNAPSHOT_PATH}`);
  console.log(`  legacyTsxFiles: ${snapshot.legacyTsxFiles.length} entries`);
  console.log(`  legacyTsxRules: ${Object.keys(snapshot.legacyTsxRules).length} entries`);
} else {
  const snapshot = buildSnapshot();
  console.log(JSON.stringify(snapshot, null, 2));
}
