import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const BANNED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "/Volumes/WorkSSD", pattern: /\/Volumes\/WorkSSD/ },
  { label: "packages/[a-z]", pattern: /\bpackages\/[a-z]/ },
  { label: "bun test", pattern: /bun test/ },
  { label: "loadSqliteVec", pattern: /loadSqliteVec/ },
  { label: "@penumbra/core", pattern: /@penumbra\/core/ },
];

function stripAllowBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let allow = false;
  for (const line of lines) {
    if (line.includes("<!-- portability-allow -->")) {
      allow = true;
      continue;
    }
    if (line.includes("<!-- /portability-allow -->")) {
      allow = false;
      continue;
    }
    if (!allow) out.push(line);
  }
  return out.join("\n");
}

function collectPlaybooks(root: string): string[] {
  const playbooksDir = join(root, "plugin/playbooks");
  return readdirSync(playbooksDir)
    .map((entry) => join(playbooksDir, entry, "playbook.md"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

test("plugin/playbooks/* are portable across user repos", () => {
  const repoRoot = resolve(import.meta.dir, "../../../..");
  for (const path of collectPlaybooks(repoRoot)) {
    const content = stripAllowBlocks(readFileSync(path, "utf8"));
    for (const { label, pattern } of BANNED_PATTERNS) {
      if (pattern.test(content)) {
        throw new Error(`portable playbook violation in ${path}: matched ${label}`);
      }
    }
  }
});
