#!/usr/bin/env bun
// Lints packages/daemon/src for synchronous subprocess calls.
// Escape hatch: `// lint-ignore: no-sync-exec <reason>` on the offending line.
import { join, resolve } from "node:path";

import { type Finding, readArgs, scanRepo } from "./_scan.js";

const ROOT = resolve(process.env.PENUMBRA_LINT_NO_SYNC_EXEC_ROOT ?? join(import.meta.dir, "../.."));
const DEFAULT_PATHS = ["packages/daemon/src/**/*.ts"];
const PATTERNS = [
  /\bBun\.spawnSync\b/g,
  /\bexecSync\b/g,
  /\bexecFileSync\b/g,
  /\bspawnSync\b/g,
  /\bimport\s+(?:\S.*)?from\s+["']child_process["']/g,
];

function shouldSkip(normalized: string): boolean {
  if (!normalized.startsWith("packages/daemon/src/")) {
    return true;
  }
  return !normalized.endsWith(".ts") || normalized.endsWith(".test.ts");
}

function scanLine(line: string, lineIdx: number, normalized: string, findings: Finding[]): void {
  if (line.includes("// lint-ignore: no-sync-exec")) {
    return;
  }
  const codeParts = line.split("//", 1);
  const code = codeParts[0] ?? "";
  for (const matchPattern of PATTERNS) {
    matchPattern.lastIndex = 0;
    const match = matchPattern.exec(code);
    if (match?.[0]) {
      findings.push({ file: normalized, line: lineIdx + 1, match: match[0] });
    }
  }
}

function main(): void {
  const paths = readArgs(process.argv.slice(2), { defaultPaths: DEFAULT_PATHS });
  const findings = scanRepo({ root: ROOT, patterns: paths, shouldSkip, scanLine });

  if (findings.length === 0) {
    process.stdout.write("no sync exec violations found\n");
    process.exit(0);
  }

  for (const finding of findings) {
    console.error(`${finding.file}:${String(finding.line)} ${finding.match}`);
  }
  process.exit(1);
}

main();
