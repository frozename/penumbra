#!/usr/bin/env bun
// Lints packages/daemon/src for synchronous subprocess calls.
// Escape hatch: `// lint-ignore: no-sync-exec <reason>` on the offending line.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Finding = {
  file: string;
  line: number;
  match: string;
};

const ROOT = resolve(process.env.PENUMBRA_LINT_NO_SYNC_EXEC_ROOT ?? join(import.meta.dir, "../.."));
const DEFAULT_PATHS = ["packages/daemon/src/**/*.ts"];
const PATTERNS = [
  /\bBun\.spawnSync\b/g,
  /\bexecSync\b/g,
  /\bspawnSync\b/g,
  /\bimport\s+(?:\S.*)?from\s+["']child_process["']/g,
];

function readArgs(argv: string[]): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--paths") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--paths requires a glob");
      }
      paths.push(value);
      continue;
    }
    throw new Error(`unknown arg: ${String(arg)}`);
  }
  return paths.length ? paths : DEFAULT_PATHS;
}

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

function scanFile(rel: string, normalized: string, findings: Finding[]): void {
  const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
  for (const [lineIdx, line] of lines.entries()) {
    scanLine(line, lineIdx, normalized, findings);
  }
}

function scan(paths: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const pattern of paths) {
    const glob = new Bun.Glob(pattern);
    for (const rel of glob.scanSync({ cwd: ROOT, onlyFiles: true })) {
      const normalized = rel.split("\\").join("/");
      if (shouldSkip(normalized)) {
        continue;
      }
      scanFile(rel, normalized, findings);
    }
  }
  return findings;
}

function main(): void {
  const paths = readArgs(process.argv.slice(2));
  const findings = scan(paths);

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
